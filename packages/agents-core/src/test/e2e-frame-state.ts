/**
 * Two questions a capability has to answer separately (docs/state-and-lifetime.md): whose STATE
 * this is, and which agents may CALL the tools that touch it.
 *
 * A capability store is one session-lived object — it owns nothing that needs closing — but the
 * data inside it is indexed by journal address, because an agent's task list is its own. Before
 * this, a subagent's first `TodoList` call replaced the main agent's list outright: the parent's
 * transcript still carried its own last result, so nothing looked wrong until its next read.
 *
 * The fold on resume is the same rule seen from the log side: each shard's latest result is that
 * frame's state, so "restore my list" is "fold my shard".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRunner, openTestSession, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  CompactionService,
  DiskSessionStore,
  TodoStore,
  defineAgent,
  goalCapability,
  planCapability,
  todoCapability,
  type Tool,
  type ToolFilterContext,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const root = mkdtempSync(join(tmpdir(), "frame-state-"));

async function testTodoPerFrame(): Promise<void> {
  const store = new DiskSessionStore(join(root, "todo"));
  const todos = new TodoStore();
  const session = await openTestSession({ store, capabilities: [todoCapability(todos)] });
  const runner = testRunner({ permission: { mode: "yolo" } });
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const worker = defineAgent({ name: "worker", model, instructions: "Work." });
  const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [worker] });

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("TodoList", { todos: [{ title: "MAIN-A", status: "in_progress" }, { title: "MAIN-B", status: "pending" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "worker", prompt: "plan your own work", description: "worker" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("TodoList", { todos: [{ title: "SUB-1", status: "pending" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("worker done", { stopReason: "stop" }),
    fauxAssistantMessage("main done", { stopReason: "stop" }),
  ]);

  const result = await runner.run(main, "plan and delegate", { session });
  check("run completes", result.status === "completed");

  const frames = todos.frames();
  const subFrame = frames.find((f) => f !== "main");
  check("todo: the main agent keeps its own list", todos.get().map((t) => t.title).join(",") === "MAIN-A,MAIN-B");
  check("todo: the subagent wrote into its own frame", subFrame !== undefined && todos.get(subFrame).map((t) => t.title).join(",") === "SUB-1");
  check("todo: neither frame can see the other's list", !todos.get().some((t) => t.title === "SUB-1") && subFrame !== undefined && !todos.get(subFrame).some((t) => t.title.startsWith("MAIN")));
  check("todo: `session.todo.get()` still reads the root agent's list", session.todo.get() === todos.get("main"));
  await session.close();

  // The fold on resume: each shard restores its own frame, from the one linear log.
  const restored = new TodoStore();
  const reopened = await openTestSession({ store: new DiskSessionStore(join(root, "todo")), capabilities: [todoCapability(restored)] });
  check("resume: the main agent's list folds back from its shard", restored.get().map((t) => t.title).join(",") === "MAIN-A,MAIN-B");
  const restoredSub = restored.frames().find((f) => f !== "main");
  check("resume: the subagent's list folds back from its own shard", restoredSub !== undefined && restored.get(restoredSub).map((t) => t.title).join(",") === "SUB-1");
  await reopened.close();
}

// A capability's tools are visible to every agent in the session. Some of them should not be —
// which is a different question from who owns the state behind them.
function testToolVisibility(): void {
  const root: ToolFilterContext = { address: "main", isRootAgent: true };
  const sub: ToolFilterContext = { address: "main/worker-1", isRootAgent: false };
  const namesOf = (tools: readonly Tool[]): string[] => tools.map((t) => t.schema.name).sort();

  const plan = planCapability();
  const planFilter = plan.toolFilters![0]!;
  check("plan: the root agent keeps both plan tools", namesOf(planFilter(plan.tools!, root)).join(",") === "EnterPlanMode,ExitPlanMode");
  check("plan: a subagent gets neither — it has no human to negotiate a plan with", planFilter(plan.tools!, sub).length === 0);

  const goal = goalCapability();
  const goalFilter = goal.toolFilters![0]!;
  check("goal: the root agent keeps read and write", namesOf(goalFilter(goal.tools!, root)).join(",") === "GetGoal,SetGoalBudget,UpdateGoal");
  check("goal: a subagent may READ the conversation's goal", namesOf(goalFilter(goal.tools!, sub)).join(",") === "GetGoal");
}

// `beforeStep` runs for every agent in the session, so a single pending slot let whichever frame
// stepped next consume someone else's request — and compact its own context instead.
function testCompactionRequestPerFrame(): void {
  const service = new CompactionService();
  const request = service.request({ instruction: "fold the early research" });
  check("compaction: the request defaults to the root agent", service.pending()?.id === request.id);
  check("compaction: another frame's step does not consume it", service.consume("main/worker-1") === null);
  check("compaction: it is still waiting for the frame that asked", service.pending()?.id === request.id);
  check("compaction: that frame consumes it exactly once", service.consume("main")?.id === request.id && service.consume("main") === null);

  const subRequest = service.request({}, "main/worker-1");
  check("compaction: a subagent can request one for itself", service.consume("main/worker-1")?.id === subRequest.id);
  check("compaction: without touching the root agent's", service.pending() === null);
}

async function main(): Promise<void> {
  try {
    await testTodoPerFrame();
    testToolVisibility();
    testCompactionRequestPerFrame();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log(`❌ FRAME-STATE E2E FAIL — ${failed.map(([l]) => l).join("; ")}`);
    process.exit(1);
  }
  console.log("✅ FRAME-STATE E2E PASS — per-frame todo lists + compaction requests, and tools the root agent alone may call");
}

await main();
