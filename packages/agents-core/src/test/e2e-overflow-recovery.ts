import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineAgent,
  Runner,
  LocalMachine,
  ListenerSink,
  MemoryStore,
  ConversationContext,
  compactionCapability,
  classifyError,
  isContextOverflowMessage,
  APIContextOverflowError,
  readTool,
  type AgentEvent,
  type AgentRecord,
  type Message,
} from "../index.ts";
import { runTurn } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const OVERFLOW_TEXT = "prompt is too long: 210012 tokens > 200000 maximum";

/** Same shape as the compaction e2e: many medium lines so token estimates are realistic. */
function bulkText(ch: string): string {
  return `${ch.repeat(80)}\n`.repeat(500);
}

function testClassification(): void {
  check("classify: overflow message detected", isContextOverflowMessage(OVERFLOW_TEXT));
  check(
    "classify: overflow message detected (openai phrasing)",
    isContextOverflowMessage("This model's maximum context length is 200000 tokens."),
  );
  check("classify: ordinary error not overflow", !isContextOverflowMessage("socket hang up"));
  check("classify: string-path overflow is non-retryable", classifyError(OVERFLOW_TEXT).retryable === false);
  check("classify: string-path transient stays non-overflow-classified", classifyError("socket hang up").retryable === false);
}

/** Overflow on a step → compaction claims via recoverStepError → step re-runs and completes. */
async function testOverflowCompactRetry(dir: string, machine: LocalMachine): Promise<void> {
  writeFileSync(join(dir, "big1.txt"), bulkText("A"));
  writeFileSync(join(dir, "big2.txt"), bulkText("B"));

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "big1.txt") }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "big2.txt") }), { stopReason: "toolUse" }),
    // Step 3 is rejected by the "provider" as too large.
    fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_TEXT }),
    // Consumed by the recovery compaction's summary call.
    fauxAssistantMessage("## Current Focus\nRead two large files; finish the task.", { stopReason: "stop" }),
    // The re-run of step 3 succeeds on the compacted context.
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "reader", model, instructions: "x", tools: [readTool] });

  const store = new MemoryStore();
  const events = new ListenerSink();
  let compacted = false;
  let retrying: Extract<AgentEvent, { type: "turn.step.retrying" }> | null = null;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "compaction.completed") compacted = true;
    if (e.type === "turn.step.retrying") retrying = e;
  });

  // A window far above what the reads produce: the PROACTIVE thresholds must never fire, so a
  // compaction can only come from the reactive overflow-recovery path under test.
  const runner = new Runner({
    machine,
    store,
    events,
    capabilities: [compactionCapability({ maxContextTokens: 9_000_000 })],
    permission: { mode: "yolo" },
  });
  const result = await runner.run(agent, "read both files");
  faux.unregister();

  check("recover: run completes after overflow", result.status === "completed");
  check("recover: final output comes from the re-run step", result.output === "all done");
  check("recover: compaction ran reactively (thresholds never fired)", compacted);
  check(
    "recover: turn.step.retrying carries the overflow reason",
    retrying !== null && (retrying as Extract<AgentEvent, { type: "turn.step.retrying" }>).reason?.includes("prompt is too long") === true,
  );
  check(
    "recover: no error assistant message journaled into history",
    !result.messages.some((m: Message) => m.role === "assistant" && m.stopReason === "error"),
  );

  const entries: AgentRecord[] = [];
  for await (const e of store.readRecords()) entries.push(e);
  check(
    "recover: dropped overflow message kept as transcript record",
    entries.some((e) => e.type === "custom" && (e as { name?: string }).name === "overflow_dropped"),
  );
}

/** Overflow with no claimant (no compaction capability) → the turn settles as "error",
 *  exactly the pre-recovery degradation — the run must not reject. */
async function testUnclaimedOverflowDegrades(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_TEXT })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "bare", model, instructions: "x" });

  const runner = new Runner({ machine, permission: { mode: "yolo" } });
  const result = await runner.run(agent, "hello");
  faux.unregister();

  check("unclaimed: run settles with error status (no rejection)", result.status === "error");
  check(
    "unclaimed: error assistant message still not journaled",
    !result.messages.some((m: Message) => m.role === "assistant" && m.stopReason === "error"),
  );
}

/** A claimant that never fixes anything is cut off after MAX_STEP_RECOVERIES_PER_TURN (2). */
async function testRecoveryCap(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_TEXT }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_TEXT }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_TEXT }),
    // Never reached: the cap stops after two claimed recoveries.
    fauxAssistantMessage("unreachable", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;

  const attempts: number[] = [];
  const result = await runTurn({
    turnId: "t1",
    signal: new AbortController().signal,
    model,
    machine,
    context: new ConversationContext({
      history: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
    }),
    hooks: {
      recoverStepError: async (ctx) => {
        attempts.push(ctx.attempt);
        return { recovered: true };
      },
    },
  });
  faux.unregister();

  check("cap: exactly two recovery attempts", attempts.length === 2 && attempts[0] === 1 && attempts[1] === 2);
  check("cap: turn settles as error after the cap", result.stopReason === "error");
  check("cap: recovered re-runs never consumed the step budget", result.steps === 1);
}

/** The compaction claimant only answers for context overflow. */
async function testCompactionDeclinesOtherErrors(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("unused", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;

  const cap = compactionCapability({ maxContextTokens: 48_000 });
  const result = await cap.hooks?.recoverStepError?.({
    turnId: "t1",
    stepNumber: 1,
    signal: new AbortController().signal,
    model,
    messages: [],
    context: new ConversationContext({}),
    error: new Error("socket hang up"),
    attempt: 1,
  });
  faux.unregister();

  check("decline: compaction ignores non-overflow errors", result === undefined);
  check(
    "decline: overflow error class carries the message text",
    new APIContextOverflowError(0, OVERFLOW_TEXT, null).message === OVERFLOW_TEXT,
  );
  void machine;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "overflow-recovery-"));
  const machine = new LocalMachine(dir);
  try {
    testClassification();
    await testOverflowCompactRetry(dir, machine);
    await testUnclaimedOverflowDegrades(machine);
    await testRecoveryCap(machine);
    await testCompactionDeclinesOtherErrors(machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ OVERFLOW RECOVERY E2E PASS — classify + compact-retry + unclaimed degrade + cap + decline");
  } else {
    console.log("❌ OVERFLOW RECOVERY E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ OVERFLOW RECOVERY E2E ERROR:", error);
  process.exit(1);
});
