import type { Capability } from "../capability.ts";
import { readSessionLog } from "../capability-state.ts";
import { PlanMode } from "./plan-mode.ts";
import { enterPlanModeTool, exitPlanModeTool } from "./tools.ts";
import {
  exitPlanModeReviewAskPolicy,
  planModeGuardDenyPolicy,
  planModeToolApprovePolicy,
} from "./policies.ts";
import { PlanModeInjector } from "./injector.ts";

export { PlanMode } from "./plan-mode.ts";
export type { PlanData, PlanDetails } from "./plan-mode.ts";

const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(["EnterPlanMode", "ExitPlanMode"]);

export function planCapability(planMode: PlanMode = new PlanMode()): Capability {
  return {
    name: "plan",
    contract: "invariant",
    tools: [enterPlanModeTool(planMode), exitPlanModeTool(planMode)],
    // Plan mode is a negotiation with the human: enter it and the agent stops acting, exit it
    // and a plan is put up for approval. A subagent has no one to negotiate with — and the mode
    // it would be toggling is the whole session's, including its parent's. So the tools are the
    // root agent's, while the MODE stays session-owned (docs/state-and-lifetime.md §6).
    toolFilters: [(tools, ctx) => (ctx.isRootAgent ? tools : tools.filter((tool) => !PLAN_TOOL_NAMES.has(tool.schema.name)))],
    policies: [
      planModeGuardDenyPolicy(planMode),
      exitPlanModeReviewAskPolicy(planMode),
      planModeToolApprovePolicy(planMode),
    ],
    injectors: [new PlanModeInjector(planMode)],
    service: planMode,
    openSession: async (ctx) => {
      planMode.attachEnvironment(ctx.environment);
      // Rebuild plan-mode state from the log's latest enter/exit result (resume/fork aware).
      planMode.reconstruct(await readSessionLog(ctx));
      planMode.attachAnnouncer(async (snapshot) => {
        await ctx.events.emit({ type: "plan.updated", snapshot, address: "main", sessionId: ctx.sessionId });
      });
    },
  };
}
