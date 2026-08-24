/**
 * A custom app-server entry — wraps a `Harness` onto this process's stdio and runs the
 * NDJSON JSON-RPC protocol. This is essentially what the built-in `operon-app-server`
 * binary does; it's shown here as user code so you can see how to build (and customize)
 * your own. `client.ts` spawns THIS file as a child process.
 *
 * IMPORTANT: stdout carries the protocol — never log there. stderr is for human logs, so
 * we redirect console.* to stderr; a stray `console.log` would otherwise corrupt the stream.
 *
 * Run standalone (it then waits for JSON-RPC on stdin):  pnpm server
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppServer, nodeStreamTransport } from "operon-agents/app-server";
import { createHarness, defineModel, filesystemTools, bashTool, type ChatModel } from "operon-agents";

const MODEL = process.env.MODEL ?? "anthropic/claude-opus-4-8";
const WORK = join(process.cwd(), "workspace");
mkdirSync(WORK, { recursive: true });

// stdout is the wire protocol — force every console channel to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const harness = createHarness({
  model: resolveModel(MODEL),
  workDir: WORK,
  appendSystemPrompt: "Use the tools; explain briefly what you do.",
  tools: [...filesystemTools(), bashTool],
  permission: { mode: "workspace" }, // machine defaults to a LocalMachine at the session's workDir
});

const transport = nodeStreamTransport(process.stdin, process.stdout, {
  onParseError: (line, err) => process.stderr.write(`parse error: ${String(err)} on ${line.slice(0, 120)}\n`),
});

// serve() runs the dispatch loop until the transport (stdin) closes.
await new AppServer({
  harness,
  transport,
  serverInfo: { name: "example-app-server", version: "0.0.0" },
  log: (m) => process.stderr.write(`[server] ${m}\n`),
}).serve();

function resolveModel(id: string): ChatModel {
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error(`MODEL must be "provider/model", got "${id}"`);
  return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
}
