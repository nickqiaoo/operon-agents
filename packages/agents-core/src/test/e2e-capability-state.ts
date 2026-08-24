// Capability state lives in the linear session log: a stateful capability writes its
// snapshot into the tool result `details`, and rebuilds in-memory state by folding the log. This
// verifies cold-resume reconstruction and goal counter re-derivation from usage records.
import { GoalStore, MemoryStore, PlanMode, TodoStore } from "../index.ts";
import type { AgentRecord, SessionStore, Usage } from "../index.ts";

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

let seq = 0;
function nextId(): string {
  seq += 1;
  return `e${seq}`;
}

function mkUsage(total: number): Usage {
  return { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

async function toolResult(store: SessionStore, toolName: string, details: unknown): Promise<string> {
  const id = nextId();
  await store.appendRecord({
    address: "main",
    type: "context.append_message",
    message: { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "" }], details, isError: false, timestamp: Date.now() },
  });
  return id;
}

async function usageEntry(store: SessionStore, total: number): Promise<string> {
  const id = nextId();
  await store.appendRecord({ address: "main", type: "usage.record", model: "m", usage: mkUsage(total) });
  return id;
}

async function branch(store: SessionStore): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const r of store.readRecords({ address: "main" })) out.push(r);
  return out;
}

function activeGoal(objective: string, budget = { turnBudget: null as number | null, tokenBudget: null as number | null, wallClockBudgetMs: null as number | null }) {
  return { goal: { objective, status: "active", budget, startedAtMs: Date.now() } };
}

async function main(): Promise<void> {
  // ── A: cold resume rebuilds todo / goal / plan from the branch ──
  {
    const store = new MemoryStore();
    await toolResult(store, "TodoList", { todos: [{ title: "a", status: "in_progress" }, { title: "b", status: "pending" }] });
    await toolResult(store, "UpdateGoal", activeGoal("ship"));
    await usageEntry(store, 100);
    await usageEntry(store, 50);
    await toolResult(store, "EnterPlanMode", { planActive: true, planId: "p1", planFilePath: "/tmp/p1.md" });

    const todo = new TodoStore();
    todo.reconstruct(await branch(store));
    check("resume: todo list rebuilt (2 items, first in_progress)", todo.get().length === 2 && todo.get()[0]!.title === "a" && todo.get()[0]!.status === "in_progress");

    const goal = new GoalStore();
    goal.reconstruct(await branch(store));
    const snap = goal.snapshot();
    check("resume: goal rebuilt active", snap?.status === "active" && snap.objective === "ship");
    check("resume: goal counters re-derived from usage (2 turns / 150 tokens)", snap?.turnsUsed === 2 && snap.tokensUsed === 150);

    const plan = new PlanMode();
    plan.reconstruct(await branch(store));
    check("resume: plan mode rebuilt active with file path", plan.isActive && plan.planFilePath === "/tmp/p1.md");
  }

  // ── B: usage before goal creation does NOT count toward the goal ──
  {
    const store = new MemoryStore();
    await usageEntry(store, 999); // pre-goal turn — must be ignored
    await toolResult(store, "UpdateGoal", activeGoal("later"));
    await usageEntry(store, 10);
    const goal = new GoalStore();
    goal.reconstruct(await branch(store));
    check("scope: pre-goal usage ignored (1 turn / 10 tokens)", goal.snapshot()?.turnsUsed === 1 && goal.snapshot()?.tokensUsed === 10);
  }

  // ── C: budget auto-block is re-derived on replay ──
  {
    const store = new MemoryStore();
    await toolResult(store, "UpdateGoal", activeGoal("bounded", { turnBudget: 2, tokenBudget: null, wallClockBudgetMs: null }));
    await usageEntry(store, 10);
    await usageEntry(store, 10);
    await usageEntry(store, 10); // would-be 3rd turn: goal already blocked, must not count
    const goal = new GoalStore();
    goal.reconstruct(await branch(store));
    const snap = goal.snapshot();
    check("budget: goal auto-blocked on replay at turn budget", snap?.status === "blocked" && snap.turnsUsed === 2);
  }

  // ── D: goal cleared later in the log reconstructs as cleared at the tip ──
  {
    const store = new MemoryStore();
    await toolResult(store, "TodoList", { todos: [{ title: "x", status: "pending" }] });
    await toolResult(store, "UpdateGoal", activeGoal("forky"));
    await usageEntry(store, 20);
    // complete (clear) the goal and empty the todo list
    await toolResult(store, "UpdateGoal", { goal: null });
    await toolResult(store, "TodoList", { todos: [] });
    const mainGoal = new GoalStore();
    mainGoal.reconstruct(await branch(store));
    const mainTodo = new TodoStore();
    mainTodo.reconstruct(await branch(store));
    check("tip: goal cleared + todo empty at the log tip", mainGoal.snapshot() === null && mainTodo.get().length === 0);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ CAPABILITY-STATE E2E FAIL");
    process.exit(1);
  }
  console.log("✅ CAPABILITY-STATE E2E PASS — log-sourced todo/goal/plan: cold resume + counter re-derivation + budget block");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
