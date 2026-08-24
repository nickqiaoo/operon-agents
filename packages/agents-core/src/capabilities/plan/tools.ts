import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import type { Tool, ToolDisplay, ToolResult } from "../../tool/types.ts";
import type { PlanMode } from "./plan-mode.ts";

const RESERVED_LABELS = new Set(["approve", "reject", "reject and exit", "revise"]);

export interface PlanReviewDisplay extends ToolDisplay {
  readonly kind: "plan_review";
  readonly title: string;
  readonly plan: string;
  readonly path?: string;
  readonly options?: readonly { readonly label: string; readonly description: string }[];
}

export function enterPlanModeTool(planMode: PlanMode): Tool {
  return defineTool({
    name: "EnterPlanMode",
    description:
      "Enter plan mode: switch to read-only investigation and write a plan to the plan file before making changes. Exit with ExitPlanMode for user approval.",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "EnterPlanMode",
      accesses: ToolAccesses.none(),
      display: { title: "Enter plan mode" },
      run: async (): Promise<ToolResult> => {
        if (planMode.isActive) {
          return { content: [{ type: "text", text: "Already in plan mode." }], details: planMode.details() };
        }
        await planMode.enter();
        return {
          content: [
            {
              type: "text",
              text: `Plan mode active. Plan file: ${planMode.planFilePath ?? "(none)"}. Investigate with read-only tools, write the plan to that file, then call ExitPlanMode.`,
            },
          ],
          // Plan-mode state rides in `details` so resume/fork reconstructs it from the log.
          details: planMode.details(),
        };
      },
    }),
  });
}

export function exitPlanModeTool(planMode: PlanMode): Tool {
  return defineTool({
    name: "ExitPlanMode",
    description:
      "Present the finalized plan for user approval and exit plan mode. The plan must already be written to the plan file. Pass `options` when the plan contains multiple distinct approaches so the user can choose.",
    params: z.object({
      options: z
        .array(
          z.object({
            label: z.string().min(1).max(80).describe('Short name (1-8 words). Append "(Recommended)" if recommended.'),
            description: z.string().default("").describe("Brief summary of this approach and its trade-offs."),
          }),
        )
        .min(1)
        .max(3)
        .refine((opts) => new Set(opts.map((o) => o.label.toLowerCase())).size === opts.length, "Option labels must be unique.")
        .refine((opts) => opts.every((o) => !RESERVED_LABELS.has(o.label.toLowerCase())), "Option labels must not use reserved approval labels.")
        .optional()
        .describe("Up to 3 distinct approaches from the plan for the user to choose between."),
    }),
    resolve: async (args) => {
      const data = await planMode.data();
      const planContent = data?.content?.trim() ?? "";
      const display: PlanReviewDisplay | { title: string } =
        planMode.isActive && planContent.length > 0
          ? {
              kind: "plan_review",
              title: "Review plan",
              plan: planContent,
              path: data?.path,
              ...(args.options && args.options.length >= 2 ? { options: args.options } : {}),
            }
          : { title: "Exit plan mode" };
      return {
        approvalRule: "ExitPlanMode",
        accesses: ToolAccesses.none(),
        display,
        run: async (): Promise<ToolResult> => {
          const wasActive = planMode.isActive;
          planMode.exit();
          if (!wasActive) {
            return { content: [{ type: "text", text: "Plan mode was not active. All tools available." }], details: planMode.details() };
          }
          const savedTo = data?.path ? `Plan saved to: ${data.path}\n\n` : "";
          return {
            content: [
              {
                type: "text",
                text: `Exited plan mode. All tools are now available.\n${savedTo}## Approved Plan:\n${planContent || "(empty)"}`,
              },
            ],
            details: planMode.details(),
          };
        },
      };
    },
  });
}
