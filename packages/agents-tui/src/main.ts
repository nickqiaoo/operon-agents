#!/usr/bin/env node
import { createLocalHarness, createModelRuntimeFromConfig, defineModel } from 'operon-agents';

import { getVersion } from './app/version.ts';
import { helpText, parseCliArgs } from './cli.ts';
import { DEFAULT_TUI_CONFIG, loadTuiConfig, TuiConfigParseError, type TuiConfig } from './config.ts';
import { getColorPalette } from './theme/index.ts';
import { currentTheme } from './theme/index.ts';
import { OperonTui } from './operon-tui.ts';
import { splitModelId } from './utils/model-catalog.ts';
import { combineStartupNotice } from './utils/startup.ts';

/** The model the session starts on: `--model` wins, then tui.toml, then a built-in default. */
const FALLBACK_MODEL = 'anthropic/claude-opus-4-8';

async function main(): Promise<number> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('operon-tui needs an interactive terminal (TTY). Use the Harness API for non-interactive runs.');
  }

  let startupNotice: string | undefined;
  let tuiConfig: TuiConfig;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    tuiConfig = error instanceof TuiConfigParseError ? error.fallback : DEFAULT_TUI_CONFIG;
    startupNotice = combineStartupNotice(startupNotice, error instanceof Error ? error.message : String(error));
  }
  // The theme has to be live before the first frame, or the welcome panel paints in the default.
  currentTheme.setPalette(await getColorPalette(tuiConfig.theme));

  const model = options.model ?? tuiConfig.defaultModel ?? FALLBACK_MODEL;
  const split = splitModelId(model);
  if (split === undefined) {
    throw new Error(`A model is named provider/model, got ${JSON.stringify(model)}.`);
  }

  // One registry for the whole process: the engine's built-in providers plus everything in
  // <homeDir>/providers.toml, each configured endpoint already asked what it serves. The startup
  // model and every later /model switch resolve against it, so a self-hosted model is nameable.
  const modelRuntime = await createModelRuntimeFromConfig({
    homeDir: options.homeDir,
    onWarning: (message: string) => {
      startupNotice = combineStartupNotice(startupNotice, message);
    },
  });

  const harness = await createLocalHarness({
    model: defineModel({ provider: split.provider, model: split.model, runtime: modelRuntime }),
    homeDir: options.homeDir,
    workDir: options.workDir,
    modelRuntime,
    ...(options.permission !== undefined ? { permission: { mode: options.permission } } : {}),
  });

  const tui = new OperonTui(harness, {
    modelRuntime,
    startup: {
      ...(options.sessionId !== undefined ? { sessionFlag: options.sessionId } : {}),
      continueLast: options.continueLast,
      ...(options.permission !== undefined ? { permission: options.permission } : {}),
      plan: options.plan,
      model,
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(startupNotice !== undefined ? { startupNotice } : {}),
    },
    tuiConfig,
    version: getVersion(),
    workDir: options.workDir,
    ...(startupNotice !== undefined ? { startupNotice } : {}),
  });

  let exitCode = 0;
  tui.onExit = async (code) => {
    exitCode = code ?? 0;
  };
  await tui.start();
  // `start()` returns once the first frame is up; the TUI owns the process until it stops.
  await new Promise<void>((resolveExit) => {
    const previous = tui.onExit;
    tui.onExit = async (code) => {
      await previous?.(code);
      resolveExit();
    };
  });
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`operon-tui: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
