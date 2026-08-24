import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRecord,
  ConversationContext,
  replayContext,
  summaryMessage,
  emptyUsage,
  MemoryStore,
  DiskSessionStore,
  type Message,
  type SessionStore,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}
function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }], toolCalls: [], timestamp: 1 };
}
async function entries(store: SessionStore): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const e of store.readRecords()) out.push(e);
  return out;
}
function texts(history: readonly Message[]): string {
  return history.map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("")).join("|");
}

async function buildLive(store: SessionStore): Promise<ConversationContext> {
  const ctx = new ConversationContext({ store, address: "main" });
  ctx.seed([user("hello")]);
  ctx.appendMessage(assistant("hi there"));
  ctx.appendMessage(user("do a thing"));
  ctx.appendMessage(assistant("working on it"));
  // Compact the oldest 2 into a summary.
  ctx.applyCompaction({ summary: "earlier chat", compactedCount: 2, tokensBefore: 999, tokensAfter: 50 });
  ctx.appendMessage(user("continue"));
  await ctx.flush();
  return ctx;
}

async function testMemoryReplay(): Promise<void> {
  const store = new MemoryStore();
  const live = await buildLive(store);

  // compactedCount:2 drops "hello"+"hi there" → [summary, "do a thing", "working on it", "continue"].
  const expected = texts([summaryMessage("earlier chat"), user("do a thing"), assistant("working on it"), user("continue")]);
  check("live: history reflects appends + compaction splice", texts(live.history) === expected);

  const rows = await entries(store);
  check(
    "journal: append_message + compaction rows in order",
    rows.filter((r) => r.type !== "metadata").map((r) => r.type).join(",") ===
      "context.append_message,context.append_message,context.append_message,context.append_message,context.apply_compaction,context.append_message",
  );
  const rowCount = rows.length;

  const replayed = await replayContext(store);
  check("replay: history byte-matches the live context", texts(replayed.history) === texts(live.history));
  check("replay: message objects match exactly (including compaction timestamp)", JSON.stringify(replayed.history) === JSON.stringify(live.history));
  check("replay: did NOT re-journal (row count unchanged)", (await entries(store)).length === rowCount);
}

async function testDiskReplay(root: string): Promise<void> {
  const dir = join(root, "ctx-session");
  const live = await buildLive(new DiskSessionStore(dir));

  // Fresh store object over the same dir = a cold resume in a new process.
  const cold = new DiskSessionStore(dir);
  const replayed = await replayContext(cold);
  check("disk: cold replay rebuilds history from log.jsonl", texts(replayed.history) === texts(live.history));

  // Per-agent isolation: a sub-agent's messages land in its own shard.
  const shared = new DiskSessionStore(join(root, "ctx-multi"));
  const main = new ConversationContext({ store: shared, address: "main" });
  const sub = new ConversationContext({ store: shared, address: "main/sub-2" });
  main.appendMessage(user("main-msg"));
  sub.appendMessage(user("sub-msg"));
  await main.flush();
  await sub.flush();
  const mainReplay = await replayContext(shared, "main");
  check("disk: address-filtered replay isolates one agent", texts(mainReplay.history) === "main-msg");
}

async function testReplaceHistoryAndAudit(): Promise<void> {
  const store = new MemoryStore();
  const ctx = new ConversationContext({ store, address: "main" });
  ctx.seed([user("noisy turn 1"), assistant("noisy reply"), user("noisy turn 2")]);
  // An explicit history rewrite collapses the noise into one clean summary.
  ctx.replaceHistory([user("clean handoff summary")]);
  ctx.appendMessage(assistant("specialist reply"));
  // Audit records — journaled, but must NOT enter history on replay.
  ctx.record({ type: "usage.record", model: "m", usage: emptyUsage() });
  ctx.record({ type: "permission.record_approval", toolCallId: "tc1", toolName: "Write", decision: "approved" });
  await ctx.flush();

  const live = texts(ctx.history);
  check("replace: live history is the filtered set", live === "clean handoff summary|specialist reply");

  const rows = await entries(store);
  check("audit: usage + approval rows present in the log", rows.some((r) => r.type === "usage.record") && rows.some((r) => r.type === "permission.record_approval"));
  check("audit: context.replace row present", rows.some((r) => r.type === "context.replace"));

  const replayed = await replayContext(store);
  check("replace: replay applies history_replace (matches live, drops pre-filter noise)", texts(replayed.history) === live);
  check("audit: replay did NOT fold usage/approval into history", replayed.history.length === 2);
}

async function testInjectionOriginReplay(): Promise<void> {
  const store = new MemoryStore();
  const ctx = new ConversationContext({ store, address: "main" });
  const reminder = user("durable reminder");
  ctx.appendMessage(reminder, { kind: "injection", injectorId: "test_injector", variant: "full" });
  await ctx.flush();

  const replayed = await replayContext(store, "main");
  const restored = replayed.history[0];
  check("injection: model-visible reminder replays from the log", restored !== undefined && texts(replayed.history) === "durable reminder");
  check(
    "injection: replay restores injector identity + variant",
    restored !== undefined &&
      JSON.stringify(replayed.originOf(restored)) ===
        JSON.stringify({ kind: "injection", injectorId: "test_injector", variant: "full" }),
  );

  const compactStore = new MemoryStore();
  const compact = new ConversationContext({ store: compactStore, address: "main" });
  compact.appendMessage(user("before reminder"));
  compact.appendMessage(user("reminder in compacted prefix"), {
    kind: "injection",
    injectorId: "test_injector",
    variant: "full",
  });
  compact.appendMessage(assistant("kept tail"));
  compact.applyCompaction({ summary: "durable prefix", compactedCount: 2, tokensBefore: 30, tokensAfter: 10 });
  await compact.flush();
  const compactReplay = await replayContext(compactStore, "main");
  check(
    "injection: compaction uses the same prefix count live and on replay",
    JSON.stringify(compactReplay.history) === JSON.stringify(compact.history),
  );
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-ctx-e2e-"));
  try {
    await testMemoryReplay();
    await testDiskReplay(root);
    await testReplaceHistoryAndAudit();
    await testInjectionOriginReplay();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ CONTEXT-REPLAY E2E PASS — journaled context + log-as-SoT replay (memory + disk + per-agent)");
  } else {
    console.log("❌ CONTEXT-REPLAY E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ CONTEXT-REPLAY E2E ERROR:", error);
  process.exit(1);
});
