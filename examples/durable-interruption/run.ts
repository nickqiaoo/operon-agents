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
import {
  INTERRUPTION_STATE_KEY,
  createLocalHarness,
  defineAgent,
  defineModel,
  parseInterruptionState,
  writeTool,
  type ApprovalResponse,
  type ChatModel,
  type InterruptionState,
  type RunResult,
} from "operon-agents";

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

const model = resolveModel(MODEL);
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
    model,
    agent: writer,
    context,
    homeDir: HOME,
    workDir: WORK,
    permission: { mode: "manual" },
    subagentProvider: null,
  });

// ── Process 1: start a run and stop at the durable approval boundary ────────────────

let harness = await openHarness({
  requestId: "request-42",
  audit: (event) => console.log(`[process 1 audit] ${event}`),
});
let session = await harness.createSession({ title: "durable-interruption-demo" });
const sessionId = session.id;

console.log(`session: ${sessionId}`);
console.log(`state:   ${join(HOME, "sessions", "…", "state.json")} -> ${INTERRUPTION_STATE_KEY}\n`);

let result: RunResult = await session.prompt(
  "Use Write to create durable-approved.txt containing: approved after resume",
);
requireInterruption(result);
await showPersistedState(session.core.store && (await session.core.store.getState(INTERRUPTION_STATE_KEY)));

console.log("\nSimulating a process exit: closing the session and the entire Harness.\n");
await session.close();
await harness.close();

// ── Process 2: reopen the session and resume from SessionStore + per-agent logs ─────

harness = await openHarness({
  requestId: "request-42",
  audit: (event) => console.log(`[process 2 audit] ${event}`),
});
session = await harness.resumeSession(sessionId);

// A resumed run may interrupt more than once. Approve the currently surfaced controls and
// keep going until the root agent completes. For nested/parallel agents, interruptions already
// contains the flattened approvals from every paused frame.
while (result.status === "interrupted") {
  const answers: Record<string, ApprovalResponse> = {};
  for (const pending of result.interruptions ?? []) {
    console.log(
      `approve ${pending.approvalId}\n` +
        `  agent=${pending.agent.name} address=${pending.address} tool=${pending.toolName}`,
    );
    answers[pending.approvalId] = { decision: "approved" };
  }
  result = await session.resume(answers);
  if (result.status === "interrupted") {
    await showPersistedState(session.core.store && (await session.core.store.getState(INTERRUPTION_STATE_KEY)));
  }
}

console.log(`\ncompleted: ${result.status}`);
console.log(`output:    ${result.output}`);
console.log(
  `interrupt key after completion: ${String(await session.core.store?.getState(INTERRUPTION_STATE_KEY))}`,
);

await session.close();
await harness.close();

function requireInterruption(value: RunResult): asserts value is RunResult & { status: "interrupted" } {
  if (value.status !== "interrupted" || !value.interruptions?.length) {
    throw new Error(`Expected a durable interruption, received status "${value.status}".`);
  }
}

async function showPersistedState(raw: unknown): Promise<void> {
  const state = parseInterruptionState(raw);
  console.log(
    `interrupted: ${state.interruptionId}@${state.revision} phase=${state.phase} frames=${Object.keys(state.frames).length}`,
  );
  printFrameTree(state, state.rootFrameId);
}

function printFrameTree(state: InterruptionState, frameId: string, depth = 0): void {
  const frame = state.frames[frameId];
  if (!frame) throw new Error(`Interruption frame "${frameId}" is missing.`);
  const indent = "  ".repeat(depth);
  console.log(
    `${indent}- ${frame.agent.name} instance=${frame.agentInstanceId} address=${frame.address}` +
      ` pending=[${frame.pending.map((item) => item.toolName).join(", ")}]`,
  );
  for (const [toolCallId, childFrameId] of Object.entries(frame.children)) {
    console.log(`${indent}  child of ${toolCallId}:`);
    printFrameTree(state, childFrameId, depth + 2);
  }
}

function resolveModel(id: string): ChatModel {
  const slash = id.indexOf("/");
  if (slash <= 0) throw new Error(`MODEL must be "provider/model", got "${id}"`);
  return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
}
