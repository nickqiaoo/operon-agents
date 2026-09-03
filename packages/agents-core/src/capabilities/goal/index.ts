import type { ShouldContinueAfterStopHook } from "../../loop/types.ts";
import { readSessionLog } from "../capability-state.ts";
import type { Capability } from "../capability.ts";
import { T } from "../../scope/tokens.ts";
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
export function goalCapability(store: GoalStore = new GoalStore()): Capability {
  return {
    name: "goal",
    tools: [updateGoalTool(store), getGoalTool(store), setGoalBudgetTool(store)],
    injectors: [new GoalInjector(store)],
    hooks: { shouldContinueAfterStop: goalDriver(store) },
    provides: [
      {
        token: T.Goal,
        // Rebuild the goal (incl. turn/token counters) by replaying the session log, so resume
        // and fork restore it instead of starting from an empty in-memory store.
        create: async (ctx) => {
          store.reconstruct(await readSessionLog(ctx));
          return store;
        },
      },
    ],
  };
}
