/**
 * Durable human-in-the-loop interruption and cross-process-style resume.
 *
 * No approval handler is registered. In manual permission mode that means a tool call is
 * persisted under SessionStore["interrupt"] and prompt() returns status "interrupted".
 * We then close the whole Harness, reopen the same disk session, approve by approvalId, and
 * continue from the assistant batch recorded in the log.
 *
 * Run: ANTHROPIC_API_KEY=... pnpm start
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLocalHarness, defineAgent, type ApprovalResponse, type RunResult } from "operon-agents";
import { writeTool } from "operon-agents/tools";

const MODEL = process.env.MODEL ?? "anthropic/claude-opus-4-8";
const HOME = join(process.cwd(), ".agent-home");
const WORK = join(process.cwd(), "workspace");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}
mkdirSync(WORK, { recursive: true });

interface AppContext {
  readonly requestId: string;
  /** Function handles are runtime-only and deliberately cannot be serialized. */
  readonly audit: (event: string) => void;
}

const model = MODEL;
const writer = defineAgent<AppContext>({
  name: "writer",
  model,
  instructions: ({ context }) => {
    context?.audit(`instructions:${context.requestId}`);
    return "Use the Write tool exactly once when asked, then report completion.";
  },
  tools: [writeTool],
});

// Context belongs to the host process, not SessionStore. A newly opened process supplies a
// fresh object (and fresh handles such as DB clients/loggers) for the same persisted session.
const openHarness = (context: AppContext) =>
  createLocalHarness<AppContext>({
    context,
    homeDir: HOME,
    config: { workDir: WORK, defaults: { model: model, agent: "default", permission: { mode: "manual" }, subagents: false } },
    registry: { agents: { default: writer } }
  });

// ── Process 1: start a run and stop at the durable approval boundary ────────────────

let harness = await openHarness({
  requestId: "request-42",
  audit: (event) => console.log(`[process 1 audit] ${event}`),
});
let session = await harness.createSession({ title: "durable-interruption-demo" });
const sessionId = session.id;

console.log(`session: ${sessionId}\n`);

const first = await session.prompt(
  "Use Write to create durable-approved.txt containing: approved after resume",
);
if (first.status !== "interrupted") {
  throw new Error(`Expected a durable interruption, received status "${first.status}".`);
}

console.log("\nSimulating a process exit: closing the session and the entire Harness.\n");
await session.close();
await harness.close();

// ── Process 2: reopen the session and resume from SessionStore + per-agent logs ─────
//
// Nothing below reads a value from process 1 except the session id: what is awaiting an answer
// comes from the store, through the same call a real second process would make.

harness = await openHarness({
  requestId: "request-42",
  audit: (event) => console.log(`[process 2 audit] ${event}`),
});
session = await harness.resumeSession(sessionId);

// A resumed run may interrupt more than once. Approve the currently surfaced controls and
// keep going until the root agent completes. For nested/parallel agents, the pending list
// already contains the flattened approvals from every paused frame.
let result: RunResult | undefined;
let pending = await session.pendingInterruptions();
while (pending.length > 0) {
  const answers: Record<string, ApprovalResponse> = {};
  for (const item of pending) {
    console.log(
      `approve ${item.approvalId}\n` +
        `  agent=${item.agent.name} address=${item.address} tool=${item.toolName}`,
    );
    answers[item.approvalId] = { decision: "approved" };
  }
  result = await session.respond(answers);
  pending = result.status === "interrupted" ? await session.pendingInterruptions() : [];
}

console.log(`\ncompleted: ${result?.status}`);
console.log(`output:    ${result?.output}`);
console.log(`still pending after completion: ${(await session.pendingInterruptions()).length}`);

await session.close();
await harness.close();
