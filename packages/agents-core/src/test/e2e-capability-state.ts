// Capability state lives in the store's key/value side as its CURRENT value, not in the log:
// every change asks the session to persist the whole new state (`SessionContext.persistState`),
// and a reopen hands the stored value straight back to `restore`. This pins, per capability, that
// every change persists and that the stored value round-trips — plus the writer underneath
// (ordering, coalescing, removal, failure). e2e-checkpoint-restore.ts drives it end to end.
import { GoalStore, MemoryStore, PlanMode, TodoStore, noopLogger } from "../index.ts";
import type { Usage } from "../index.ts";
import { DurableStateWriter } from "../agent/durable-state.ts";

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

function mkUsage(total: number): Usage {
  return { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** A GoalStore whose persistence records the value a session would store at each change. */
function persistedGoal(): { goal: GoalStore; stored: unknown[] } {
  const goal = new GoalStore();
  const stored: unknown[] = [];
  goal.attachPersistence(() => stored.push(goal.durable()));
  return { goal, stored };
}

async function main(): Promise<void> {
  // ── A: every goal change persists the whole state, counters included ──
  {
    const { goal, stored } = persistedGoal();
    goal.update({ objective: "ship", status: "active" });
    goal.accountTurn(mkUsage(100));
    goal.accountTurn(mkUsage(50));
    check("goal: one persist per change (create + 2 turns)", stored.length === 3);
    const restored = new GoalStore();
    restored.restore(stored.at(-1));
    const snap = restored.snapshot();
    check("goal: restored active with its counters (2 turns / 150 tokens)", snap?.status === "active" && snap.turnsUsed === 2 && snap.tokensUsed === 150);
  }

  // ── B: a change from outside the loop (a host `/goal pause`) persists too ──
  {
    const { goal, stored } = persistedGoal();
    await goal.create({ objective: "long task" });
    await goal.pause("Paused by the user");
    const restored = new GoalStore();
    restored.restore(stored.at(-1));
    check("goal: a host-side pause survives", restored.snapshot()?.status === "paused");
  }

  // ── C: the turn budget blocks in the same change that counts the turn ──
  {
    const { goal, stored } = persistedGoal();
    goal.update({ objective: "bounded", status: "active" });
    goal.setBudget({ turns: 2 });
    goal.accountTurn(mkUsage(10));
    const blocked = goal.accountTurn(mkUsage(10));
    check("goal budget: second turn blocks the goal", blocked && goal.snapshot()?.status === "blocked");
    const restored = new GoalStore();
    restored.restore(stored.at(-1));
    check("goal budget: restored blocked at 2 turns", restored.snapshot()?.status === "blocked" && restored.snapshot()?.turnsUsed === 2);
  }

  // ── D: completing clears; nothing stored restores no goal ──
  {
    const { goal, stored } = persistedGoal();
    goal.update({ objective: "done soon", status: "active" });
    goal.update({ status: "complete" });
    check("goal: completing persists the cleared state (null)", stored.length === 2 && stored[1] === null);
    const restored = new GoalStore();
    restored.update({ objective: "stale in memory", status: "active" });
    restored.restore(undefined);
    check("goal: restore(undefined) leaves no goal", restored.snapshot() === null);
  }

  // ── E: plan mode — enter/exit wait for the write; the stored value round-trips ──
  {
    const plan = new PlanMode();
    let release: (() => void) | undefined;
    const writes: boolean[] = [];
    plan.attachPersistence(() => {
      writes.push(plan.isActive);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    let entered = false;
    const entering = plan.enter(false).then(() => {
      entered = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    check("plan: enter does not settle before its state is durable", !entered && writes[0] === true);
    release!();
    await entering;
    check("plan: enter settles once the write did", entered);
    let exited = false;
    const exiting = plan.exit().then(() => {
      exited = true;
    });
    await Promise.resolve();
    check("plan: exit waits for its write too", !exited && writes[1] === false);
    release!();
    await exiting;

    const restored = new PlanMode();
    restored.restore({ planActive: true, planId: "p1", planFilePath: "/tmp/p1.md" });
    check("plan: restored active with its file path", restored.isActive && restored.planFilePath === "/tmp/p1.md");
    restored.restore(undefined);
    check("plan: nothing stored restores plan mode off", !restored.isActive && restored.planFilePath === null);
  }

  // ── F: todo is per frame — each address persists and restores its own list ──
  {
    const todo = new TodoStore();
    const persisted: string[] = [];
    todo.attachPersistence((address) => persisted.push(address));
    todo.set("main", [{ title: "a", status: "in_progress" }]);
    todo.set("main/sub-1", [{ title: "child", status: "pending" }]);
    check("todo: each change persists its own frame", persisted.join(",") === "main,main/sub-1");
    const restored = new TodoStore();
    restored.restore("main", todo.snapshot("main"));
    restored.restore("main/sub-1", todo.snapshot("main/sub-1"));
    check("todo: main list restored", restored.get()[0]?.title === "a" && restored.get()[0]?.status === "in_progress");
    check("todo: subagent list restored to its own address", restored.get("main/sub-1")[0]?.title === "child");
    restored.restore("main", undefined);
    check("todo: nothing stored clears the frame", restored.get().length === 0 && restored.get("main/sub-1").length === 1);
  }

  // ── G: the writer — newest value, per-key order, coalescing, removal, failure ──
  {
    const store = new MemoryStore();
    const writer = new DurableStateWriter(store, noopLogger);
    let value = 1;
    let reads = 0;
    const read = () => {
      reads += 1;
      return { value };
    };
    const first = writer.write("k", read);
    value = 2;
    const second = writer.write("k", read);
    value = 3;
    check("writer: a write asked for while one waits shares it", first === second);
    await first;
    check("writer: the shared write carries the newest value, read once", reads === 1 && (await store.getState("k") as { value: number }).value === 3);
    value = 4;
    await writer.write("k", read);
    check("writer: a later write lands after it", (await store.getState("k") as { value: number }).value === 4);
    await writer.write("k", () => null);
    check("writer: null removes the key", (await store.getState("k")) === null);

    const failing = new MemoryStore();
    let fail = true;
    const put = failing.putState.bind(failing);
    failing.putState = (key, v) => (fail ? Promise.reject(new Error("disk full")) : put(key, v));
    const flaky = new DurableStateWriter(failing, noopLogger);
    let rejected = false;
    await flaky.write("k", () => "lost").catch(() => {
      rejected = true;
    });
    fail = false;
    await flaky.write("k", () => "kept");
    check("writer: a failed write rejects, and the next one still runs", rejected && (await failing.getState("k")) === "kept");
    await flaky.flush();
    check("writer: flush settles after a failure", true);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ CAPABILITY-STATE E2E FAIL");
    process.exit(1);
  }
  console.log("✅ CAPABILITY-STATE E2E PASS — every change persists the whole state; stored values round-trip; writer order/coalescing/failure");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
