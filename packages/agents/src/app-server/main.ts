#!/usr/bin/env node
/**
 * `operon-app-server` — the process entrypoint. Wires a `Harness` to this
 * process's stdio and runs the protocol. Spawn it from any language:
 *
 *   operon-app-server --home ~/.agent --workdir /repo --model anthropic/claude-opus-4-...
 *
 * Configuration comes from the same `config.toml` files any other host reads (`loadHarnessConfig`:
 * `<home>/config.toml`, then the working directory's `.agents/config.toml` and
 * `.agents/config.local.toml`), with the command-line flags laid over it. `--no-config` skips the
 * files.
 *
 * stdout carries the protocol (NDJSON JSON-RPC). stderr is logs. We defensively
 * redirect console.log/info/debug to stderr so a stray log can never corrupt the
 * protocol stream.
 */
import { DiskSessionRepository, loadHarnessConfig, type HarnessConfig, type PermissionMode } from "operon-agents-core";
import { createHarness } from "../harness.ts";
import { nodeStreamTransport } from "./codec.ts";
import { AppServer } from "./server.ts";

interface Args {
  home?: string;
  workdir?: string;
  model?: string;
  permission?: PermissionMode;
  noConfig?: boolean;
}

const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "workspace", "yolo", "auto"];
/** What this binary has always run on when nothing names a model. */
const FALLBACK_MODEL = "anthropic/claude-opus-4-8";

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = (): string | undefined => argv[++i];
    switch (arg) {
      case "--home":
        out.home = take();
        break;
      case "--workdir":
      case "--cwd":
        out.workdir = take();
        break;
      case "--model":
        out.model = take();
        break;
      case "--permission": {
        const mode = take();
        if (PERMISSION_MODES.includes(mode as PermissionMode)) out.permission = mode as PermissionMode;
        break;
      }
      case "--no-config":
        out.noConfig = true;
        break;
      default:
        break;
    }
  }
  return out;
}

function redirectStdoutLogsToStderr(): void {
  const toStderr = (...parts: unknown[]): void => {
    process.stderr.write(`${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

async function main(): Promise<void> {
  redirectStdoutLogsToStderr();
  const args = parseArgs(process.argv.slice(2));

  // The files first, the flags over them: one configuration, whichever way it was written.
  const file: HarnessConfig = args.noConfig === true
    ? { defaults: {} }
    : await loadHarnessConfig({
        ...(args.home !== undefined ? { homeDir: args.home } : {}),
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      });
  const config: HarnessConfig = {
    ...file,
    defaults: {
      ...file.defaults,
      model: args.model ?? file.defaults.model ?? FALLBACK_MODEL,
      ...(args.permission !== undefined ? { permission: { ...file.defaults.permission, mode: args.permission } } : {}),
    },
    ...(args.workdir !== undefined ? { workDir: args.workdir } : {}),
  };
  const harness = createHarness({
    config,
    ...(args.home !== undefined ? { infrastructure: () => ({ sessionRepository: new DiskSessionRepository(args.home!) }) } : {}),
  });

  const transport = nodeStreamTransport(process.stdin, process.stdout, {
    onParseError: (line, error) => process.stderr.write(`parse error: ${String(error)} on: ${line.slice(0, 200)}\n`),
  });
  const server = new AppServer({
    harness,
    transport,
    serverInfo: { name: "operon-app-server", version: "0.0.0" },
    log: (m) => process.stderr.write(`${m}\n`),
  });

  await server.serve();
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
