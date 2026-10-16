// Reopening a session reads `main`'s history from its newest checkpoint, and its state from the
// store's key/value side — never the log from its head, and never state out of the log.
//
// A checkpoint (a compaction, a history replace) is self-contained: its history does not depend
// on the records before it. State is kept apart, as current values, so it restores the same
// whenever the history was last compacted and whichever capabilities were open at the time.
// These checks drive that end to end through a real Session, and pin the pieces that keep it
// correct:
//   A  goal/plan/todo/permission/usage restored, reading only main's history tail
//   B  the root/subagent line: a subagent's stop neither drives nor counts toward the goal, and
//      its usage is not the session's
//   C  the catalog's `usage` summary, readable without opening the session
//   D  a stale checkpoint index falls back; state outlives a checkpoint taken while its
//      capability was absent
//   F  the two crash windows between a state write and the record the model saw both reopen
//      and run on
//   E  a pre-v3 compaction record (no kept tail) is rejected, not silently misread
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, openTestSession, testRunner } from "./faux.ts";
import { LocalEnvironment } from "../tool/environment-local.ts";
import {
  DiskSessionStore,
  MemorySessionRepository,
  MemoryStore,
  defineAgent,
  goalCapability,
  planCapability,
  replayContext,
  reduceHistory,
  todoCapability,
  type AgentRecord,
  type GoalStore,
  type PlanMode,
  type ReadRecordsFilter,
  type SessionStore,
  type TodoStore,
} from "../index.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.log(`❌ ${label}`);
  }
}

/** Counts what a reopen actually reads: every record yielded, and every whole-log read. */
class CountingStore extends DiskSessionStore {
  yielded = 0;
  wholeLogReads = 0;
  headReads = 0;
  override async *readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    if (filter?.address === undefined) this.wholeLogReads += 1;
    else if (filter.fromCheckpoint !== true) this.headReads += 1;
    for await (const record of super.readRecords(filter)) {
      this.yielded += 1;
      yield record;
    }
  }
}

function capabilities(): ReturnType<typeof goalCapability>[] {
  return [goalCapability(), planCapability(), todoCapability()];
}

async function readAll(store: SessionStore, address = "main"): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const record of store.readRecords({ address })) out.push(record);
  return out;
}

function texts(messages: readonly { content: unknown }[]): string {
  return JSON.stringify(messages.map((m) => m.content));
}

// ── A: restore from checkpoint + tail, reading only the tail ──
async function testRestoreFromCheckpoint(root: string): Promise<void> {
  const dir = join(root, "a");
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "main", model, instructions: "x" });
  const runner = testRunner({});

  const work = join(root, "a-work");
  mkdirSync(work, { recursive: true });
  const environment = new LocalEnvironment(work);
  const first = await openTestSession({ store: new DiskSessionStore(dir), environment, capabilities: capabilities(), permission: { mode: "manual" } });
  // Some history and state before the checkpoint.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("TodoList", { todos: [{ title: "before", status: "pending" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("turn one done", { stopReason: "stop" }),
  ]);
  await first.goal.create({ objective: "ship the feature" });
  await first.setPermissionMode("yolo");
  await runner.run(agent, "turn one", { session: first });
  // A compaction: summary + the last two messages kept.
  const live = first.liveContext("main")!;
  live.applyCompaction({ summary: "everything so far", compactedCount: live.messages.length - 2, tokensBefore: 100, tokensAfter: 10 });
  // State changes AFTER the checkpoint — the tail must carry these.
  await first.plan.setEnabled(true, { createFile: false });
  await first.goal.pause("Paused by the user");
  first.permission.applyApproval("Bash(npm test)", { decision: "approved", scope: "session" });
  first.persistPermissionState();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("TodoList", { todos: [{ title: "after", status: "in_progress" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("turn two done", { stopReason: "stop" }),
  ]);
  await runner.run(agent, "turn two", { session: first });
  const liveHistory = texts(first.liveContext("main")!.messages);
  const liveUsage = first.usage;
  const liveGoal = (first.goal as GoalStore).snapshot();
  await first.close();

  const full = await readAll(new DiskSessionStore(dir));
  const checkpointAt = full.findIndex((record) => record.type === "context.apply_compaction");
  const stamp = checkpointAt >= 0 ? (full[checkpointAt] as { checkpoint?: Record<string, unknown> }).checkpoint : undefined;
  check("A: the compaction record carries the lifecycle only — no state", stamp !== undefined && Object.keys(stamp).join(",") === "#frame");
  check("A: no state records in the log", full.every((record) => record.type !== "custom" || !record.name.endsWith(":state")));

  const counting = new CountingStore(dir);
  const reopened = await openTestSession({ store: counting, environment, capabilities: capabilities(), permission: { mode: "manual" } });
  const tailLength = full.length - checkpointAt;
  check("A: the open read only main's tail — no whole-log read, no head read", counting.wholeLogReads === 0 && counting.headReads === 0);
  check(`A: records read = the tail from the checkpoint (${tailLength} of ${full.length})`, counting.yielded === tailLength && tailLength < full.length);
  check("A: history equals the live history", texts(reopened.liveContext("main")!.messages) === liveHistory);
  check("A: history equals a whole-shard replay", texts(reduceHistory(full).messages) === liveHistory);
  const goal = (reopened.goal as GoalStore).snapshot();
  check("A: goal restored paused, with its counters", goal?.status === "paused" && goal.objective === "ship the feature" && goal.turnsUsed === liveGoal?.turnsUsed);
  check("A: plan mode (set by a host command after the checkpoint) restored", (reopened.plan as PlanMode).isActive);
  check("A: todo list from after the checkpoint restored", (reopened.service<TodoStore>("todo")!).get()[0]?.title === "after");
  check("A: permission mode set only BEFORE the checkpoint restored over the host default", reopened.permission.mode === "yolo");
  check("A: approve-for-session grant restored", reopened.permission.sessionGrants.includes("Bash(npm test)"));
  check("A: session usage restored", reopened.usage !== undefined && reopened.usage.totalTokens === liveUsage?.totalTokens && liveUsage.totalTokens > 0);
  await reopened.close();
  faux.unregister();
}

// ── B: a subagent's stop neither drives nor counts toward the goal ──
async function testSubagentIsNotTheGoal(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("UpdateGoal", { objective: "probe", status: "active" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "helper", prompt: "say hi", description: "hi" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("CHILD DONE", { stopReason: "stop" }),
    // The root stops with the goal still active: THIS stop is counted and driven onward.
    fauxAssistantMessage("ROOT PAUSES", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("UpdateGoal", { status: "complete" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("ROOT DONE", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const helper = defineAgent({ name: "helper", model, instructions: "help" });
  const main = defineAgent({ name: "main", model, instructions: "x", subagents: [helper] });
  const store = new MemoryStore();
  const session = await openTestSession({ store, capabilities: [goalCapability()], permission: { mode: "yolo" } });
  const goal = session.goal as GoalStore;
  const turnsCounted: number[] = [];
  const account = goal.accountTurn.bind(goal);
  goal.accountTurn = (usage) => {
    turnsCounted.push(usage.totalTokens);
    return account(usage);
  };
  const result = await testRunner({ maxTurns: 6 }).run(main, "go", { session });
  faux.unregister();

  check("B: run completes (the child did not eat the root's replies)", result.status === "completed" && result.output.includes("ROOT DONE"));
  const childShard = (await readAll(store, "main")).flatMap((record) =>
    record.type === "context.append_message" && record.message.role === "toolResult" && record.message.toolName === "Agent"
      ? [/agent_id: ([a-zA-Z0-9_-]+)/.exec(JSON.stringify(record.message.content))?.[1]]
      : []);
  const childAddress = `main/${childShard[0]}`;
  const child = await readAll(store, childAddress);
  check("B: the subagent ran exactly one turn", child.filter((record) => record.type === "usage.record").length === 1);
  check("B: only the root's stop was counted toward the goal (and driven onward)", turnsCounted.length === 1);
  const mainUsage = (await readAll(store, "main")).filter((record): record is Extract<AgentRecord, { type: "usage.record" }> => record.type === "usage.record");
  const rootSum = mainUsage.reduce((sum, record) => sum + record.usage.totalTokens, 0);
  await session.close();
  const stored = (await store.getState("session:usage")) as { totalTokens?: number } | null;
  check("B: the session total is the root's turns only, and is what is stored", session.usage?.totalTokens === rootSum && stored?.totalTokens === rootSum);
}

// ── C: the catalog's usage summary ──
async function testCatalogUsage(): Promise<void> {
  const repo = new MemorySessionRepository();
  const handle = await repo.create({ workDir: "/tmp/catalog-usage" });
  check("C: no usage before the first turn", (await repo.get(handle.id))?.usage === undefined);
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("hello", { stopReason: "stop" }), fauxAssistantMessage("again", { stopReason: "stop" })]);
  const agent = defineAgent({ name: "main", model: faux.getChatModel()!, instructions: "x" });
  const session = await openTestSession({ store: handle.store, sessionId: handle.id, permission: { mode: "yolo" } });
  await testRunner({}).run(agent, "one", { session });
  await testRunner({}).run(agent, "two", { session });
  faux.unregister();
  const summary = await repo.get(handle.id);
  check("C: the summary carries the session's running usage", summary?.usage !== undefined && summary.usage.totalTokens === session.usage?.totalTokens && summary.usage.totalTokens > 0);
  const listed = (await repo.list()).find((entry) => entry.id === handle.id);
  check("C: list() carries it too", listed?.usage?.totalTokens === summary?.usage?.totalTokens);
  await session.close();
}

// ── D: fallbacks stay correct ──
async function testFallbacks(root: string): Promise<void> {
  const dir = join(root, "d");
  const store = new DiskSessionStore(dir);
  const message = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });
  await store.appendRecord({ address: "main", type: "context.append_message", message: message("one") });
  await store.appendRecord({ address: "main", type: "context.replace", messages: [message("reset")] });
  await store.appendRecord({ address: "main", type: "context.append_message", message: message("two") });
  const tail: AgentRecord[] = [];
  for await (const record of store.readRecords({ address: "main", fromCheckpoint: true })) tail.push(record);
  check("D: disk reads from the indexed checkpoint", tail.length === 2 && tail[0]!.type === "context.replace");
  // A stale index (as after a fork that renumbered, or a crashed write) falls back to the head.
  await store.putState("checkpoint-offset:main", { sequence: "999", offset: 3 });
  const replayed = await replayContext(store, "main");
  check("D: a stale index falls back to the whole shard, same history", texts(replayed.history) === texts([message("reset"), message("two")]));

  // State outlives a checkpoint taken while its capability was absent: it was never in the log.
  const memory = new MemoryStore();
  const withTodo = await openTestSession({ store: memory, capabilities: [todoCapability()] });
  withTodo.service<TodoStore>("todo")!.set("main", [{ title: "kept", status: "pending" }]);
  await withTodo.close();
  const without = await openTestSession({ store: memory, capabilities: [] });
  without.liveContext("main")!.replaceHistory([message("reset while todo was absent")]);
  await without.close();
  const back = await openTestSession({ store: memory, capabilities: [todoCapability()] });
  check("D: a checkpoint taken while the capability was absent does not lose its state", back.service<TodoStore>("todo")!.get()[0]?.title === "kept");
  check("D: and the history is the checkpoint's", texts(back.liveContext("main")!.messages) === texts([message("reset while todo was absent")]));
  // Detach + attach in one session: the attach reads the stored value back.
  await back.detachCapability("todo");
  await back.attachCapability(todoCapability());
  check("D: a re-attached capability gets its stored state back", back.service<TodoStore>("todo")!.get()[0]?.title === "kept");
  await back.close();
}

// ── F: the crash windows between the state write and the record the model saw ──
async function testCrashWindows(): Promise<void> {
  const faux = registerFauxProvider();
  const agent = defineAgent({ name: "main", model: faux.getChatModel()!, instructions: "x" });
  const source = new MemoryStore();
  const first = await openTestSession({ store: source, capabilities: [todoCapability()], permission: { mode: "yolo" } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("TodoList", { todos: [{ title: "new", status: "in_progress" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("listed", { stopReason: "stop" }),
  ]);
  await testRunner({}).run(agent, "plan it", { session: first });
  await first.close();
  const records = await readAll(source);
  const isTodoResult = (record: AgentRecord) => record.type === "context.append_message" && record.message.role === "toolResult" && record.message.toolName === "TodoList";

  // (1) The state was written, the tool result was not: the call reopens as interrupted.
  const stateOnly = new MemoryStore();
  let cut = false;
  for (const record of records) {
    if (isTodoResult(record)) cut = true;
    if (!cut) await stateOnly.appendRecord(record);
  }
  await stateOnly.putState("durable:todo:main", await source.getState("durable:todo:main"));
  const one = await openTestSession({ store: stateOnly, capabilities: [todoCapability()], permission: { mode: "yolo" } });
  check("F1: the stored list is restored though its tool result is missing", one.service<TodoStore>("todo")!.get()[0]?.title === "new");
  faux.setResponses([fauxAssistantMessage("carrying on", { stopReason: "stop" })]);
  const resumed = await testRunner({}).run(agent, "continue", { session: one });
  check("F1: the session runs on", resumed.status === "completed" && resumed.output.includes("carrying on"));
  await one.close();

  // (2) The tool result was written, the state was not: the stored (older) state wins.
  const resultOnly = new MemoryStore();
  for (const record of records) await resultOnly.appendRecord(record);
  const two = await openTestSession({ store: resultOnly, capabilities: [todoCapability()], permission: { mode: "yolo" } });
  check("F2: the list is the stored one (none), not the transcript's", two.service<TodoStore>("todo")!.get().length === 0);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("TodoList", { todos: [{ title: "again", status: "pending" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("relisted", { stopReason: "stop" }),
  ]);
  const rerun = await testRunner({}).run(agent, "continue", { session: two });
  check("F2: the session runs on, and the next write heals it", rerun.status === "completed" && two.service<TodoStore>("todo")!.get()[0]?.title === "again");
  await two.close();
  faux.unregister();
}

// ── E: a pre-v3 compaction record is rejected, not misread ──
async function testLegacyCompactionRejected(): Promise<void> {
  const legacy = { type: "context.apply_compaction", summary: "s", summaryTimestamp: 1, cutoff: 1, compactedCount: 1, tokensBefore: 2, tokensAfter: 1 } as unknown as AgentRecord;
  let error: unknown;
  try {
    reduceHistory([legacy]);
  } catch (caught) {
    error = caught;
  }
  check("E: replay rejects a compaction record without its kept tail", error instanceof Error && error.message.includes("predates self-contained compaction"));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "operon-checkpoint-"));
  try {
    await testRestoreFromCheckpoint(root);
    await testSubagentIsNotTheGoal();
    await testCatalogUsage();
    await testFallbacks(root);
    await testCrashWindows();
    await testLegacyCompactionRejected();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ CHECKPOINT-RESTORE E2E FAIL");
    process.exit(1);
  }
  console.log("✅ CHECKPOINT-RESTORE E2E PASS — tail-only history + stored state + root-only goal/usage + catalog usage + crash windows");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
