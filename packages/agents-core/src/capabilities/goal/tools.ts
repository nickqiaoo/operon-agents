import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import type { GoalSnapshot, GoalStore } from "./goal-store.ts";

function summarize(snapshot: GoalSnapshot | null): string {
  if (snapshot === null) return "No active goal.";
  const parts = [
    `objective: ${snapshot.objective}`,
    snapshot.completionCriterion ? `completion: ${snapshot.completionCriterion}` : undefined,
    `status: ${snapshot.status}`,
    `turns used: ${snapshot.turnsUsed}`,
    `tokens used: ${snapshot.tokensUsed}`,
  ].filter(Boolean);
  const b = snapshot.budget;
  if (b.turnBudget !== null) parts.push(`turn budget: ${snapshot.turnsUsed}/${b.turnBudget}`);
  if (b.tokenBudget !== null) parts.push(`token budget: ${snapshot.tokensUsed}/${b.tokenBudget}`);
  if (snapshot.terminalReason) parts.push(`reason: ${snapshot.terminalReason}`);
  return parts.join("\n");
}

export function updateGoalTool(store: GoalStore): Tool {
  return defineTool({
    name: "UpdateGoal",
    description:
      "Set or update the current goal. Provide `objective` to (re)state the task, `status` to drive lifecycle (active = pursue autonomously, paused/blocked = stop autonomous work, complete = finish and clear). Mark `complete` only when all required work is done.",
    params: z.object({
      objective: z.string().optional().describe("The task to pursue (required when first creating a goal)."),
      completionCriterion: z.string().optional().describe("How to know the goal is done."),
      status: z.enum(["active", "blocked", "paused", "complete"]).optional(),
      reason: z.string().optional().describe("Why the goal is blocked/paused (terminal reason)."),
    }),
    resolve: (args) => ({
      approvalRule: "UpdateGoal",
      accesses: ToolAccesses.none(),
      display: { title: "Update goal", detail: args.status ?? args.objective },
      run: async (): Promise<ToolResult> => {
        const snapshot = store.update(args);
        // The durable goal record rides in `details` so the log reconstructs it on resume/fork.
        const details = { goal: store.persisted() };
        // No stopTurn on complete: clearing the goal already halts the driver's
        // continuation, while letting the model finish its turn (e.g. a final summary).
        if (snapshot === null) {
          return { content: [{ type: "text", text: "Goal marked complete and cleared." }], details };
        }
        return { content: [{ type: "text", text: `Goal updated.\n${summarize(snapshot)}` }], details };
      },
    }),
  });
}

export function getGoalTool(store: GoalStore): Tool {
  return defineTool({
    name: "GetGoal",
    description: "Read the current goal: objective, completion criterion, status, and budget usage.",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "GetGoal",
      accesses: ToolAccesses.none(),
      display: { title: "Get goal" },
      run: async (): Promise<ToolResult> => ({ content: [{ type: "text", text: summarize(store.snapshot()) }] }),
    }),
  });
}

export function setGoalBudgetTool(store: GoalStore): Tool {
  return defineTool({
    name: "SetGoalBudget",
    description:
      "Set a hard budget for the current goal. The goal is auto-blocked once any set budget is reached. Only set a budget when the user/objective states a clear, reasonable limit.",
    params: z.object({
      turns: z.number().int().positive().optional().describe("Max continuation turns."),
      tokens: z.number().int().positive().optional().describe("Max total tokens."),
      wallClockMs: z.number().int().positive().optional().describe("Max wall-clock time in ms."),
    }),
    resolve: (args) => ({
      approvalRule: "SetGoalBudget",
      accesses: ToolAccesses.none(),
      display: { title: "Set goal budget" },
      run: async (): Promise<ToolResult> => {
        const snapshot = store.setBudget(args);
        if (snapshot === null) return { content: [{ type: "text", text: "No active goal to budget." }], isError: true };
        return { content: [{ type: "text", text: `Budget set.\n${summarize(snapshot)}` }], details: { goal: store.persisted() } };
      },
    }),
  });
}
