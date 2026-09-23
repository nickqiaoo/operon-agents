import type { ShouldContinueAfterStopHook } from "../../loop/types.ts";
import type { Capability } from "../capability.ts";
import { readSessionLog } from "../capability-state.ts";
import { GoalStore } from "./goal-store.ts";
import { getGoalTool, setGoalBudgetTool, updateGoalTool } from "./tools.ts";
import { GoalInjector } from "./injector.ts";

export { GoalStore } from "./goal-store.ts";
export type { GoalSnapshot, GoalStatus, GoalBudget, GoalPersisted, GoalDetails } from "./goal-store.ts";

function goalDriver(store: GoalStore): ShouldContinueAfterStopHook {
  return async (ctx) => {
    if (!store.isActive()) return { continue: false };
    // Account for the turn that just finished, then auto-block if a hard budget hit.
    store.recordTurn(ctx.usage);
    if (store.enforceBudget()) return { continue: false };
    return { continue: store.isActive() };
  };
}

/** `store` may be pre-built by an embedder (or a test) that wants to hold the instance. */
const GOAL_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["UpdateGoal", "SetGoalBudget"]);

export function goalCapability(store: GoalStore = new GoalStore()): Capability {
  return {
    name: "goal",
    contract: "invariant",
    tools: [updateGoalTool(store), getGoalTool(store), setGoalBudgetTool(store)],
    // The goal is the CONVERSATION's, so a subagent may read it — knowing what the session is
    // for helps it do its part — but not rewrite it or change its budget. Those are the root
    // agent's, the one accountable to the human who set the goal.
    toolFilters: [(tools, ctx) => (ctx.isRootAgent ? tools : tools.filter((tool) => !GOAL_WRITE_TOOL_NAMES.has(tool.schema.name)))],
    injectors: [new GoalInjector(store)],
    hooks: { shouldContinueAfterStop: goalDriver(store) },
    service: store,
    // Rebuild the goal (incl. turn/token counters) by replaying the session log, so resume
    // and fork restore it instead of starting from an empty in-memory store.
    openSession: async (ctx) => {
      store.reconstruct(await readSessionLog(ctx));
      store.attachAnnouncer(async (snapshot) => {
        await ctx.events.emit({ type: "goal.updated", snapshot, address: "main", sessionId: ctx.sessionId });
      });
    },
  };
}
