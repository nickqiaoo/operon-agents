/**
 * app-server client — spawn the server as a child process and drive it over the
 * NDJSON JSON-RPC protocol. This is exactly what a non-JS host (Python, Rust, Go…)
 * does: `spawn` the `operon-app-server` binary and talk to it over stdio. Here we
 * spawn OUR OWN `server.ts` so you can see both ends — point `command`/`args` at
 * the installed `operon-app-server` binary instead and nothing else changes.
 *
 * The protocol is symmetric. We send requests (initialize / newSession / prompt);
 * the server sends US reverse-requests (approval / question) and a stream of event
 * notifications. `AppServerClient` bridges those to `setApprovalHandler` / `onEvent`,
 * giving you the same shape as an in-process `Harness` session.
 *
 * Run:  ANTHROPIC_API_KEY=... pnpm start
 *       ANTHROPIC_API_KEY=... pnpm start "count the lines in package.json with bash"
 */
import { fileURLToPath } from "node:url";
import { AppServerClient } from "operon-agents/app-server";
import type { AgentEvent, ApprovalRequest, ApprovalResponse } from "operon-agents";

const MODEL = process.env.MODEL ?? "anthropic/claude-opus-4-8";
const TASK = process.argv[2] ?? "create a file haiku.txt with a haiku about json-rpc, then read it back to me";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}

// Spawn OUR server.ts under node's type-stripping. `AppServerClient.spawn` forwards
// this process's env to the child, so ANTHROPIC_API_KEY flows through automatically.
// To drive the real binary instead: AppServerClient.spawn({ command: "operon-app-server",
//   args: ["--workdir", process.cwd(), "--model", MODEL, "--permission", "workspace"] }).
const serverEntry = fileURLToPath(new URL("./server.ts", import.meta.url));
const client = AppServerClient.spawn({
  command: process.execPath,
  args: ["--experimental-strip-types", "--no-warnings", serverEntry],
  env: { MODEL },
});

// 1. Handshake — negotiate the protocol version and declare that WE can answer
//    approval + question reverse-requests. Advertised server capabilities come back.
const init = await client.initialize({ approval: true, question: true }, { name: "app-server-example", version: "0.0.0" });
console.log(`↔ connected to ${init.serverInfo.name} (protocol v${init.protocolVersion}) — modes: ${init.permissionModes.join(", ")}\n`);

// 2. Reverse-RPC: the server calls US back whenever a tool needs a human decision.
//    In a real UI this awaits a click; here we auto-approve file tools and reject bash.
client.setApprovalHandler((req: ApprovalRequest): ApprovalResponse => {
  const allow = req.toolName !== "bash";
  console.log(`  🔐 approval: ${req.toolName} → ${allow ? "APPROVED" : "REJECTED"}`);
  return allow ? { decision: "approved" } : { decision: "rejected", feedback: "Shell is disabled in this demo — use the file tools." };
});

// 3. Notifications: every AgentEvent the server emits is forwarded verbatim over the wire.
client.onEvent(render);

// 4. Open a session and run one turn. `prompt` resolves with the final RunResult.
const { sessionId, workDir } = await client.newSession({ title: "app-server demo" });
console.log(`❯ ${TASK}\n  (session ${sessionId} in ${workDir})\n`);
const result = await client.prompt(sessionId, TASK);
console.log(`\n─ ${result.status} ─  (${result.usage.totalTokens} tokens)`);
if (result.output) console.log(`\n${result.output}`);

// 5. Clean up: close the session, then the transport + child process.
await client.closeSession(sessionId);
client.close();

function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "assistant.delta":
      process.stdout.write(ev.delta);
      break;
    case "tool.call.started":
      process.stdout.write(`\n  ⚙︎ ${ev.toolName} ${preview(ev.args)}\n`);
      break;
    case "tool.result":
      process.stdout.write(`  ↳ ${ev.toolName}: ${ev.isError ? "error" : "ok"}\n`);
      break;
    case "error":
      process.stdout.write(`\n  ✖ ${ev.message}\n`);
      break;
  }
}

function preview(args: unknown): string {
  const s = JSON.stringify(args) ?? "";
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
