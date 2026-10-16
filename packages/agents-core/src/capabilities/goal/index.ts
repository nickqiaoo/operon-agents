import type { ShouldContinueAfterStopHook } from "../../loop/types.ts";
import { DEFAULT_ADDRESS } from "../../store/index.ts";
import type { Capability } from "../capability.ts";
import { GoalStore } from "./goal-store.ts";
import { getGoalTool, setGoalBudgetTool, updateGoalTool } from "./tools.ts";
import { GoalInjector } from "./injector.ts";

export { GoalStore } from "./goal-store.ts";
export type { GoalSnapshot, GoalStatus, GoalBudget, GoalPersisted, GoalDetails, GoalDurable } from "./goal-store.ts";

function goalDriver(store: GoalStore): ShouldContinueAfterStopHook {
  return async (ctx) => {
    // The goal is the conversation's, pursued by the root agent. A subagent stopping is its own
    // work finishing: it is neither the goal's turn to count nor one to drive onward — it cannot
    // even mark the goal complete (its goal tools are read-only), so driving it would only spin
    // it to its turn limit.
    if (ctx.isRootAgent === false) return undefined;
    if (!store.isActive()) return { continue: false };
    // Account for the turn that just finished, then auto-block if a hard budget hit.
    if (store.accountTurn(ctx.usage)) return { continue: false };
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
    // The goal is SESSION state: it lives in `main`, whichever frame is running. A lost write
    // costs at most one turn of drift (a counter, or one extra driven turn after the model
    // completed it), so nothing waits for it.
    durableState: {
      snapshot: (address) => (address === DEFAULT_ADDRESS ? store.durable() : undefined),
      restore: (address, value) => {
        if (address === DEFAULT_ADDRESS) store.restore(value);
      },
    },
    openSession: async (ctx) => {
      store.attachPersistence(() => void ctx.persistState());
      store.attachAnnouncer(async (snapshot) => {
        await ctx.events.emit({ type: "goal.updated", snapshot, address: "main", sessionId: ctx.sessionId });
      });
    },
  };
}
