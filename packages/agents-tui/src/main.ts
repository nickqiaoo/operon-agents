#!/usr/bin/env node
import { createLocalHarness, defineModel } from "operon-agents";
import { OperonTui } from "./app.ts";
import { helpText, parseCliArgs } from "./cli.ts";

async function main(): Promise<number> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("operon-tui requires an interactive terminal (TTY). Use the Harness API for non-interactive runs.");
  }

  const harness = await createLocalHarness({
    model: resolveModel(options.model),
    homeDir: options.homeDir,
    workDir: options.workDir,
    permission: { mode: options.permission },
  });
  let app: OperonTui | undefined;
  const onTerm = (): void => app?.stop(143);
  const onHangup = (): void => app?.stop(129);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHangup);
  try {
    let session;
    if (options.sessionId !== undefined) {
      session = await harness.resumeSession(options.sessionId);
    } else if (options.continueLast) {
      const latest = (await harness.listSessions()).find((item) => item.workDir === options.workDir);
      session = latest === undefined ? await harness.createSession({ workDir: options.workDir }) : await harness.resumeSession(latest.id);
    } else {
      session = await harness.createSession({ workDir: options.workDir });
    }
    if (options.thinking !== undefined) session.setThinking(options.thinking);
    app = new OperonTui(harness, session, {
      model: options.model,
      permission: options.permission,
      thinking: options.thinking,
    });
    return await app.start();
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHangup);
    await harness.close();
  }
}

function resolveModel(id: string) {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) throw new Error(`Model must be provider/model, got ${JSON.stringify(id)}.`);
  return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`operon-tui: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
