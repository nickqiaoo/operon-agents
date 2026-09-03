import { testRunner, openTestSession, openCapability } from "./faux.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  Runner,
  LocalMachine,
  ListenerSink,
  MemoryStore,
  MicroCompaction,
  compactionCapability,
  CompactionService,
  CompactionStrategy,
  readTool,
  replayContext,
  type AgentEvent,
  type AgentRecord,
  type Message,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function partText(part: Message["content"][number]): string {
  if (typeof part === "string") return part;
  return part.type === "text" ? part.text : "";
}

function testMicroPreservesDeferredMetadata(): void {
  const selectedTool = "mcp__slack__send_message";
  const messages: Message[] = [
    {
      role: "toolResult",
      toolCallId: "search-1",
      toolName: "SearchTool",
      content: [{ type: "text", text: "X".repeat(1_000) }],
      addedToolNames: [selectedTool],
      isError: false,
      timestamp: 1,
    },
  ];
  const micro = new MicroCompaction({
    cacheMissedThresholdMs: 0,
    minContextUsageRatio: 0,
    keepRecentMessages: 0,
    minContentTokens: 1,
  });

  const cleared = micro.detectAndApply(messages, 0, 1);
  const result = messages[0];
  check(
    "micro: clearing SearchTool text preserves addedToolNames",
    cleared === 1 &&
      result?.role === "toolResult" &&
      result.addedToolNames?.[0] === selectedTool &&
      result.content.map(partText).join("") === "[Old tool result content cleared]",
  );
}

/** Many medium lines, not one huge one: the tool result builder truncates any single line past
 *  2000 chars, so a one-line file would never add up to a realistic number of tokens. */
function bulkText(ch: string): string {
  return `${ch.repeat(80)}\n`.repeat(500);
}

async function testFullCompaction(dir: string, machine: LocalMachine): Promise<void> {
  writeFileSync(join(dir, "big1.txt"), bulkText("A"));
  writeFileSync(join(dir, "big2.txt"), bulkText("B"));

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "big1.txt") }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "big2.txt") }), { stopReason: "toolUse" }),
    // This response is consumed by the compaction summary call (tools disabled).
    fauxAssistantMessage("## Current Focus\nRead two large files; continue the task.", { stopReason: "stop" }),
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "reader", model, instructions: "x", tools: [readTool] });

  const store = new MemoryStore();
  const events = new ListenerSink();
  let done: Extract<AgentEvent, { type: "compaction.completed" }> | null = null;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "compaction.completed") done = e;
  });

  // A window big enough to exercise the real thresholds rather than the small-window floor.
  // faux reports maxOutputTokens 16384, so: effective = 48000 − 16384 = 31616, compact line at
  // 31616 − 13000 = 18616, block line at 31616 − 3000 = 28616. The floor (15808) stays below
  // the compact line, so this covers the normal path. Two big reads land between the two lines,
  // which means afterStep's compact check fires — not beforeStep's hard block.
  const compaction = compactionCapability({ maxContextTokens: 48_000 });
  const runner = testRunner({
    machine,
    store,
    events,
    capabilities: [compaction],
    permission: { mode: "yolo" },
  });
  const result = await runner.run(agent, "read both files");
  faux.unregister();

  const hasSummary = result.messages.some(
    (m) => m.role === "user" && m.content.map(partText).join("").includes("<context-summary>"),
  );
  check("full: <context-summary> spliced into live context", hasSummary);
  check("full: compaction.completed emitted with token reduction", done !== null && done.tokensAfter < done.tokensBefore);
  // Pins which threshold fired: past the compact line but short of the block line, so this is
  // the afterStep head start doing the work. If a future change collapses the two lines back
  // into one, this is the assertion that notices.
  check(
    "full: fired on the compact line (18616), not the block line (28616)",
    done !== null && done.tokensBefore >= 18_616 && done.tokensBefore < 28_616,
  );

  const entries: AgentRecord[] = [];
  for await (const e of store.readRecords()) entries.push(e);
  check("full: compaction record appended to durable log", entries.some((e) => e.type === "context.apply_compaction"));
  check("full: committed compaction advances prompt-context invalidation revision", ((await openCapability(compaction)).service as CompactionService).revision > 0);
  check("full: run completes", result.status === "completed");
}

async function testMicroCompaction(dir: string, machine: LocalMachine): Promise<void> {
  writeFileSync(join(dir, "m1.txt"), "X".repeat(1500));
  writeFileSync(join(dir, "m2.txt"), "Y".repeat(1500));

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "m1.txt") }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "m2.txt") }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "reader", model, instructions: "x", tools: [readTool] });

  // Full compaction effectively off (huge window); micro on with the cache always "cold".
  const store = new MemoryStore();
  const compaction = compactionCapability({
    maxContextTokens: 1_000_000,
    micro: { cacheMissedThresholdMs: 0, minContextUsageRatio: 0, keepRecentMessages: 1, minContentTokens: 10 },
  });
  const runner = testRunner({
    machine,
    store,
    capabilities: [compaction],
    permission: { mode: "yolo" },
  });
  const result = await runner.run(agent, "read both files");
  faux.unregister();

  const cleared = result.messages.filter(
    (m) => m.role === "toolResult" && m.content.map(partText).join("") === "[Old tool result content cleared]",
  );
  check("micro: an old tool-result body was cleared to the marker", cleared.length >= 1);
  check("micro: at least one tool result remains intact (recent kept)", result.messages.some(
    (m) => m.role === "toolResult" && m.content.map(partText).join("").length > 100,
  ));
  check("micro: run completes", result.status === "completed");
  check("micro: does not advance full-compaction prompt-context revision", ((await openCapability(compaction)).service as CompactionService).revision === 0);

  // The truncation must be JOURNALED (replaceHistory), not an in-place edit of the live
  // array: replay has to reproduce the same cleared bodies, or a resume would resurrect
  // every tool result micro-compaction had cleared (live-vs-durable divergence).
  const replayed = await replayContext(store, "main");
  const clearedInReplay = replayed.history.filter(
    (m) => m.role === "toolResult" && m.content.map(partText).join("") === "[Old tool result content cleared]",
  );
  check("micro: truncation journaled — replay matches live cleared bodies", clearedInReplay.length === cleared.length);
}

/**
 * A summary call that keeps erroring must not take the run down with it. Automatic compaction
 * degrades — the step proceeds uncompacted and the breaker eventually stops retrying — whereas
 * the previous code let runFullCompaction's throw escape the hook and abort the step.
 */
async function testCompactionFailureDegrades(dir: string, machine: LocalMachine): Promise<void> {
  writeFileSync(join(dir, "fail1.txt"), bulkText("C"));
  writeFileSync(join(dir, "fail2.txt"), bulkText("D"));

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "fail1.txt") }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Read", { path: join(dir, "fail2.txt") }), { stopReason: "toolUse" }),
    // Consumed by the summary call, which fails — the same slot testFullCompaction feeds a
    // valid summary into.
    fauxAssistantMessage("", { stopReason: "error" }),
    ...Array.from({ length: 10 }, () => fauxAssistantMessage("done anyway", { stopReason: "stop" })),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "reader", model, instructions: "x", tools: [readTool] });

  const runner = testRunner({
    machine,
    store: new MemoryStore(),
    events: new ListenerSink(),
    // Same real-scale window as testFullCompaction, so the failure path is exercised at the
    // compact line rather than the small-window floor.
    capabilities: [compactionCapability({ maxContextTokens: 48_000 })],
    permission: { mode: "yolo" },
  });

  let threw: unknown = null;
  let status = "";
  try {
    status = (await runner.run(agent, "read both")).status;
  } catch (error) {
    threw = error;
  }
  faux.unregister();

  check("failure: a failing auto-compaction does not throw out of the run", threw === null);
  check("failure: the run completes uncompacted instead of aborting", status === "completed");
}

/**
 * Thresholds are absolute token subtractions rather than ratios:
 *   effectiveWindow = window − min(model.maxOutputTokens, summaryOutputReserve)
 *   compact line    = effectiveWindow − compactBufferTokens
 *   block line      = effectiveWindow − blockBufferTokens
 * No ratio is involved, so a bigger window stays proportionally more usable.
 */
function testStrategyThresholds(): void {
  const strategy = (window: number, maxOutput: number): CompactionStrategy =>
    new CompactionStrategy(() => window, () => maxOutput);

  // 200k window, 8k output cap → effective 192k, compact at 179k (89.5%), block at 189k.
  const big = strategy(200_000, 8_000);
  check("strategy: 200k/8k effective window is 192k", big.effectiveWindow === 192_000);
  check("strategy: 200k/8k compacts at 179k", big.compactThreshold === 179_000);
  check("strategy: 200k/8k blocks at 189k", big.blockThreshold === 189_000);
  check("strategy: 200k/8k does not compact just below the line", !big.shouldCompact(178_999));
  check("strategy: 200k/8k compacts on the line", big.shouldCompact(179_000));
  check("strategy: 200k/8k does not block at the compact line", !big.shouldBlock(179_000));

  // The summary reserve is capped by the model's own output limit, not applied blindly.
  const bigRoomyOutput = strategy(200_000, 64_000);
  check(
    "strategy: output limit above the reserve caps at summaryOutputReserve (20k)",
    bigRoomyOutput.effectiveWindow === 180_000 && bigRoomyOutput.compactThreshold === 167_000,
  );

  // An unknown output limit reserves the full configured amount rather than guessing low.
  check("strategy: unknown output limit reserves the full 20k", strategy(200_000, 0).effectiveWindow === 180_000);

  // 64k window: the old ratio+50k-reserve scheme compacted at 14k (22% of the window).
  const small = strategy(64_000, 8_000);
  check("strategy: 64k/8k compacts at 43k, not the old 14k", small.compactThreshold === 43_000);

  // Small windows fall back to the ratio floor instead of producing a negative threshold,
  // which would have made shouldCompact true at every step.
  const tiny = strategy(16_000, 8_000);
  check("strategy: 16k/8k floors the compact line at half the effective window", tiny.compactThreshold === 4_000);
  check("strategy: 16k/8k stays quiet below the floor", !tiny.shouldCompact(3_999));

  // A window smaller than its own output reserve can't be reasoned about — never fire.
  const degenerate = strategy(4_000, 8_000);
  check("strategy: window below the output reserve never compacts", !degenerate.shouldCompact(3_999));

  // The two lines differ by default, so afterStep is worth running.
  check("strategy: compact and block lines differ → afterStep check enabled", big.checkAfterStep);

  // What the context breakdown reports: summary reserve + compaction head start.
  check("strategy: reserved tokens reported as 21k for 200k/8k", big.reservedTokens === 21_000);
  check(
    "strategy: CompactionService reads the reserve through the strategy",
    new CompactionService(() => big.reservedTokens).reservedContextTokens === 21_000,
  );
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-compaction-e2e-"));
  const machine = new LocalMachine(dir);
  try {
    testStrategyThresholds();
    testMicroPreservesDeferredMetadata();
    await testFullCompaction(dir, machine);
    await testMicroCompaction(dir, machine);
    await testCompactionFailureDegrades(dir, machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ COMPACTION E2E PASS — full (summary splice + Entry + reduction) + micro (clear old tool results)");
  } else {
    console.log("❌ COMPACTION E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ COMPACTION E2E ERROR:", error);
  process.exit(1);
});
