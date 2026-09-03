#!/usr/bin/env node
/**
 * `operon-app-server` — the process entrypoint. Wires a `Harness` to this
 * process's stdio and runs the protocol. Spawn it from any language:
 *
 *   operon-app-server --home ~/.agent --workdir /repo --model anthropic/claude-opus-4-...
 *
 * stdout carries the protocol (NDJSON JSON-RPC). stderr is logs. We defensively
 * redirect console.log/info/debug to stderr so a stray log can never corrupt the
 * protocol stream.
 */
import { defineModel, DiskSessionRepository, T, type ChatModel, type Scope } from "operon-agents-core";
import { createHarness } from "../harness.ts";
import { nodeStreamTransport } from "./codec.ts";
import { AppServer } from "./server.ts";

interface Args {
  home?: string;
  workdir?: string;
  model?: string;
  permission?: "manual" | "workspace" | "yolo";
}

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
        if (mode === "manual" || mode === "workspace" || mode === "yolo") out.permission = mode;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Resolve a `provider/model` id into a ChatModel (API keys come from the env). */
function resolveModel(id: string): ChatModel {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new Error(`invalid --model "${id}": expected "provider/model" (e.g. anthropic/claude-opus-4-...)`);
  }
  return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
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

  const harness = createHarness({
    model: args.model ?? "anthropic/claude-opus-4-8",
    resolveModel,
    ...(args.home !== undefined ? { harness: (scope: Scope) => scope.register(T.SessionRepository, new DiskSessionRepository(args.home!)) } : {}),
    ...(args.workdir !== undefined ? { workDir: args.workdir } : {}),
    permission: { mode: args.permission ?? "yolo" },
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
