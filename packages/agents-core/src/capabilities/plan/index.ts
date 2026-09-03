import { readSessionLog } from "../capability-state.ts";
import type { Capability } from "../capability.ts";
import { T } from "../../scope/tokens.ts";
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

export function planCapability(planMode: PlanMode = new PlanMode()): Capability {
  return {
    name: "plan",
    tools: [enterPlanModeTool(planMode), exitPlanModeTool(planMode)],
    policies: [
      planModeGuardDenyPolicy(planMode),
      exitPlanModeReviewAskPolicy(planMode),
      planModeToolApprovePolicy(planMode),
    ],
    injectors: [new PlanModeInjector(planMode)],
    provides: [
      {
        token: T.Plan,
        create: async (ctx) => {
          planMode.attachMachine(ctx.scope.require(T.Machine));
          // Rebuild plan-mode state from the log's latest enter/exit result (resume/fork aware).
          planMode.reconstruct(await readSessionLog(ctx));
          return planMode;
        },
      },
    ],
  };
}
