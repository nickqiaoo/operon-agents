import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import { globApproval } from "../../tool/support/tool-path.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import { isBackgroundTaskTerminal, type BackgroundTaskInfo } from "./task.ts";
import type { BackgroundManager } from "./manager.ts";

function text(s: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: s }], isError };
}

function formatPlainObject(record: object): string {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key.replaceAll(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}: ${typeof value === "string" ? value : String(value)}`)
    .join("\n");
}

function formatTaskInfo(info: BackgroundTaskInfo): string {
  return formatPlainObject({
    ...info,
    outputRef: undefined,
    outputKind: info.outputRef?.kind,
    outputPath: info.outputRef?.kind === "file" ? info.outputRef.path : undefined,
    outputAddress:
      info.outputRef?.kind === "conversation" || info.outputRef?.kind === "workflow-run"
        ? info.outputRef.address
        : undefined,
  });
}

export function backgroundListTool(manager: BackgroundManager): Tool {
  return defineTool({
    // The whole background trio is `Background*` (List/Output/Stop) so it never blurs with the
    // structured todo `Task*` tools: this lists RUNNING BACKGROUND tasks; TaskList lists the todos.
    name: "BackgroundList",
    description: [
      "Host-facing helper that lists this session's background tasks and their current status (id, kind, status, description). It is not exposed by backgroundCapability; applications may construct it explicitly for an administrative surface.",
      "- By default only non-terminal (running) tasks; set active_only=false to also include completed/failed/killed/lost ones (lost = left over from a previous process that can no longer be inspected or controlled; treat as terminated).",
      "- After a context compaction, or whenever you are unsure which tasks are running or what their ids are, call this to re-enumerate instead of guessing a task_id.",
      "- limit caps how many tasks are returned (1–100, default 20). This tool is read-only and safe to call anytime, including in plan mode.",
      "- This lists background RUNTIME tasks. For the structured to-do task list, use TaskList instead.",
    ].join("\n"),
    parameters: z.object({
      active_only: z.boolean().default(true).describe("List only non-terminal tasks.").optional(),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum tasks to return.").optional(),
    }),
    resolve: (args) => ({
      ...globApproval("BackgroundList", (args.active_only ?? true) ? "active" : "all"),
      accesses: ToolAccesses.none(),
      display: { title: "List background tasks" },
      run: async (): Promise<ToolResult> => {
        const activeOnly = args.active_only ?? true;
        const tasks = manager.list(activeOnly, args.limit ?? 20);
        const label = activeOnly ? "active_background_tasks" : "background_tasks";
        const header = `${label}: ${String(tasks.length)}`;
        if (tasks.length === 0) return text(`${header}\nNo background tasks found.`);
        return text(`${header}\n${tasks.map(formatTaskInfo).join("\n---\n")}`);
      },
    }),
  });
}

const DEFAULT_STOP_REASON = "Stopped by BackgroundStop";

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? "Task already in terminal state" : trimmed;
}

export function backgroundStopTool(manager: BackgroundManager): Tool {
  return defineTool({
    name: "BackgroundStop",
    description: [
      "Stop a running background task (SIGTERM, then SIGKILL after a grace period). This is a general-purpose stop for any background task, not a bash-specific kill.",
      "- Only use this when a task must genuinely be cancelled — for one finishing normally, wait for its completion notification.",
      "- Stopping is destructive: it may leave partial side effects behind.",
      "- If the task has already finished, this simply returns its current status.",
    ].join("\n"),
    parameters: z.object({
      task_id: z.string().describe("The background task ID to stop."),
      reason: z.string().default(DEFAULT_STOP_REASON).describe("Short reason recorded when the task is stopped.").optional(),
    }),
    resolve: (args) => ({
      ...globApproval("BackgroundStop", args.task_id),
      accesses: ToolAccesses.none(),
      display: { title: `Stop task ${args.task_id}` },
      run: async (): Promise<ToolResult> => {
        const info = manager.getTask(args.task_id);
        if (!info) return text(`Task not found: ${args.task_id}`, true);

        const trimmed = args.reason?.trim();
        const reason = trimmed === undefined || trimmed.length === 0 ? DEFAULT_STOP_REASON : trimmed;

        if (isBackgroundTaskTerminal(info.status)) {
          return text(`task_id: ${info.taskId}\nstatus: ${info.status}\nreason: ${terminalStopReason(info.stopReason)}`);
        }

        await manager.suppressTerminalNotification(args.task_id);
        const result = await manager.stop(args.task_id, reason);
        if (!result) return text(`Failed to stop task: ${args.task_id}`, true);
        return text(`task_id: ${result.taskId}\nstatus: ${result.status}\nreason: ${result.stopReason ?? reason}`);
      },
    }),
  });
}
