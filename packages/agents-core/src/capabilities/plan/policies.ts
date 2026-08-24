import type { ToolFileAccess } from "../../tool/access.ts";
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from "../../permission/types.ts";
import type { PlanMode } from "./plan-mode.ts";
import type { PlanReviewDisplay } from "./tools.ts";

function writeFileAccesses(ctx: PermissionPolicyContext): ToolFileAccess[] {
  return (ctx.plan.accesses ?? []).filter(
    (a): a is ToolFileAccess => a.kind === "file" && (a.operation === "write" || a.operation === "readwrite"),
  );
}

function writesOnlyPlanFile(ctx: PermissionPolicyContext, planFilePath: string | null): boolean {
  if (planFilePath === null) return false;
  const writes = writeFileAccesses(ctx);
  if (writes.length === 0) return false;
  return writes.every((a) => a.path === planFilePath);
}

function planReviewDisplay(ctx: PermissionPolicyContext): PlanReviewDisplay | undefined {
  const display = ctx.plan.display as { kind?: unknown } | undefined;
  return display?.kind === "plan_review" ? (display as PlanReviewDisplay) : undefined;
}

export function planModeGuardDenyPolicy(planMode: PlanMode): PermissionPolicy {
  return {
    name: "plan-mode-guard-deny",
    evaluate(ctx): PermissionPolicyResult | undefined {
      if (!planMode.isActive) return undefined;
      const toolName = ctx.toolCall.name;
      if (toolName === "Write" || toolName === "Edit") {
        const planFilePath = planMode.planFilePath;
        if (planFilePath !== null && writesOnlyPlanFile(ctx, planFilePath)) return undefined;
        return {
          kind: "deny",
          message: `Plan mode is active. You may only write to the current plan file: ${planFilePath ?? "(none selected yet)"}. Call ExitPlanMode to exit plan mode before editing other files.`,
        };
      }
      if (toolName === "BackgroundStop" || toolName === "CronCreate" || toolName === "CronDelete") {
        return {
          kind: "deny",
          message: `${toolName} is not available in plan mode. Call ExitPlanMode first.`,
        };
      }
      return undefined;
    },
  };
}

export function exitPlanModeReviewAskPolicy(planMode: PlanMode): PermissionPolicy {
  return {
    name: "exit-plan-mode-review-ask",
    evaluate(ctx): PermissionPolicyResult | undefined {
      if (ctx.toolCall.name !== "ExitPlanMode") return undefined;
      if (!planMode.isActive) return undefined;
      const display = planReviewDisplay(ctx);
      if (!display || display.plan.trim().length === 0) return undefined;
      return {
        kind: "ask",
        reason: { has_options: display.options !== undefined && display.options.length >= 2 },
        // Approved → proceed (the tool's run exits plan mode + returns the plan).
        // Rejected/cancelled → deny; plan mode stays active.
        resolveApproval: (response) =>
          response.decision === "approved"
            ? undefined
            : { kind: "deny", message: response.feedback ?? "Plan rejected by user. Plan mode remains active." },
      };
    },
  };
}

export function planModeToolApprovePolicy(planMode: PlanMode): PermissionPolicy {
  return {
    name: "plan-mode-tool-approve",
    evaluate(ctx): PermissionPolicyResult | undefined {
      const toolName = ctx.toolCall.name;
      if (toolName === "EnterPlanMode") return { kind: "approve" };
      if ((toolName === "Write" || toolName === "Edit") && planMode.isActive && writesOnlyPlanFile(ctx, planMode.planFilePath)) {
        return { kind: "approve" };
      }
      if (toolName === "ExitPlanMode") {
        if (!planMode.isActive) return { kind: "approve" };
        const display = planReviewDisplay(ctx);
        // No reviewable plan → approve (lets the tool exit cleanly); a real plan is
        // handled by exit-plan-mode-review-ask above (which runs earlier in the chain).
        if (!display || display.plan.trim().length === 0) return { kind: "approve" };
        return undefined;
      }
      return undefined;
    },
  };
}
