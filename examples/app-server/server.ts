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
import { createHarness } from "operon-agents";
import { filesystemTools, bashTool } from "operon-agents/tools";

const MODEL = process.env.MODEL ?? "anthropic/claude-opus-4-8";
const WORK = join(process.cwd(), "workspace");
mkdirSync(WORK, { recursive: true });

// stdout is the wire protocol — force every console channel to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const harness = createHarness({
  config: {
    workDir: WORK,
    defaults: {
      model: MODEL,
      appendSystemPrompt: "Use the tools; explain briefly what you do.",
      permission: { mode: "workspace" },
    },
  },
  registry: { tools: [...filesystemTools(), bashTool] },
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
