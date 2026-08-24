import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import { globApproval } from "../../tool/support/tool-path.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import { isBackgroundTaskTerminal, type BackgroundTaskInfo, type BackgroundTaskStatus } from "./task.ts";
import type { BackgroundManager } from "./manager.ts";

const OUTPUT_PREVIEW_BYTES = 32 * 1024; // 32 KiB

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
    params: z.object({
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

function retrievalStatus(status: BackgroundTaskStatus, block: boolean | undefined): "success" | "timeout" | "not_ready" {
  if (isBackgroundTaskTerminal(status)) return "success";
  return block ? "timeout" : "not_ready";
}

/** The full, never-truncated log path for tasks whose authoritative output is a file. */
function taskLogPath(info: BackgroundTaskInfo): string | undefined {
  return info.outputRef?.kind === "file" ? info.outputRef.path : undefined;
}

function terminalReason(info: BackgroundTaskInfo): "timed_out" | "stopped" | "failed" | undefined {
  if (info.status === "timed_out") return "timed_out";
  if (info.status === "killed" && info.stopReason !== undefined) return "stopped";
  if (info.status === "failed" && info.stopReason !== undefined) return "failed";
  return undefined;
}

export function backgroundOutputTool(manager: BackgroundManager): Tool {
  return defineTool({
    name: "BackgroundOutput",
    description: [
      "Read a background AGENT's or WORKFLOW's result, taken from where it already lives — a sub-agent's own conversation, a workflow run's journal. Works while it is still running: you get whatever it has produced so far.",
      "- You do NOT need to poll. Every background task sends a completion notification on its own; call this when you want the answer before that arrives, or after a notification tells you the agent is done.",
      "- For a background BASH command this returns status only, plus output_path. The command's output is a file on the machine — Read that path instead, which also gives you offset/limit paging over a large log.",
      "- For a background WORKFLOW this returns the run's story from its journal: each phase, each agent's result, any failure, and the final outcome — for a running one, everything so far.",
      "- For a background question this returns the user's answer in full — the place to read the rest when the completion notification truncated it.",
      "- For a terminal task the metadata explains why it ended: status=timed_out when aborted by its deadline, and reason when it was explicitly stopped; terminal_reason is a categorical label (timed_out | stopped | failed). A task that ended on its own emits none of these.",
      "- block=true waits for completion (optional timeout in seconds). Rarely needed — the notification already wakes you.",
    ].join("\n"),
    params: z.object({
      task_id: z.string().describe("The background task ID to inspect."),
      block: z.boolean().default(false).describe("Wait for the task to finish before returning.").optional(),
      timeout: z.number().int().min(0).max(3600).default(30).describe("Max seconds to wait when block=true.").optional(),
    }),
    resolve: (args) => ({
      ...globApproval("BackgroundOutput", args.task_id),
      accesses: ToolAccesses.none(),
      display: { title: `Read output of task ${args.task_id}` },
      run: async (): Promise<ToolResult> => {
        const info = manager.getTask(args.task_id);
        if (!info) return text(`Task not found: ${args.task_id}`, true);

        if (args.block && !isBackgroundTaskTerminal(info.status)) {
          await manager.wait(args.task_id, (args.timeout ?? 30) * 1000);
        }
        const current = manager.getTask(args.task_id);
        if (!current) return text(`Task not found: ${args.task_id}`, true);

        // A file-backed task's bytes are NOT served here: the file is the output, and `Read`
        // pages it properly. Serving a second, worse view of the same file would invite the
        // model to read it the truncating way. Everything else reports what it has.
        const logPath = taskLogPath(current);
        const output = logPath !== undefined ? undefined : await manager.readOutput(args.task_id, OUTPUT_PREVIEW_BYTES);
        const lines = [
          formatPlainObject({
            retrievalStatus: retrievalStatus(current.status, args.block),
            ...current,
            // Re-emit the task's log file (process kind) under the `output_path` name; suppress
            // the raw `log_path` from the spread so there's a single, discoverable full-log key.
            outputRef: undefined,
            // A question's answer is served through the [output] section below (via readOutput);
            // spreading it here too would print it twice.
            answer: undefined,
            outputKind: current.outputRef?.kind,
            outputAddress:
              current.outputRef?.kind === "conversation" || current.outputRef?.kind === "workflow-run"
                ? current.outputRef.address
                : undefined,
            terminalReason: terminalReason(current),
            outputSizeBytes: output?.sizeBytes,
            outputContentBytes: output?.contentBytes,
            outputTruncated: output?.truncated,
            outputPath: logPath,
          }),
          "",
        ];
        if (logPath !== undefined) {
          lines.push(`This command's output is the file above. Read ${logPath} to see it.`);
          return text(lines.join("\n"));
        }
        if (output !== undefined && output.truncated) {
          lines.push(
            current.kind === "agent"
              ? "[Truncated — the beginning is shown. The whole record is the agent's conversation.]"
              : "[Truncated — the beginning is shown.]",
          );
        }
        lines.push("[output]", output?.content || "[no output available]");
        return text(lines.join("\n"));
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
      "- Only use this when a task must genuinely be cancelled — for one finishing normally, wait for its completion notification or inspect it with BackgroundOutput instead.",
      "- Stopping is destructive: it may leave partial side effects behind.",
      "- If the task has already finished, this simply returns its current status.",
    ].join("\n"),
    params: z.object({
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
