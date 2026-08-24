import { z } from "zod";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import type { Task, TaskStore } from "./task-store.ts";

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_GET_TOOL_NAME = "TaskGet";

const MetadataSchema = z.record(z.string(), z.unknown());

// ── TaskCreate ────────────────────────────────────────────────────────────────

const TaskCreateInput = z.object({
  subject: z.string().min(1).describe("A brief, actionable title for the task."),
  description: z.string().describe("What needs to be done."),
  activeForm: z.string().optional().describe('Present-continuous form shown while in_progress (e.g. "Running tests").'),
  metadata: MetadataSchema.optional().describe("Arbitrary metadata to attach to the task."),
});

export function taskCreateTool(store: TaskStore): Tool {
  return defineTool({
    name: TASK_CREATE_TOOL_NAME,
    description: "Create a task in the structured task list. Returns its id. Use TaskUpdate to set status/dependencies later.",
    params: TaskCreateInput,
    resolve: (args) => ({
      approvalRule: TASK_CREATE_TOOL_NAME,
      accesses: ToolAccesses.none(),
      display: { title: `Create task: ${args.subject}` },
      run: async (): Promise<ToolResult> => {
        const task = await store.create({
          subject: args.subject,
          description: args.description,
          activeForm: args.activeForm,
          metadata: args.metadata,
        });
        return { content: [{ type: "text", text: `Task #${task.id} created: ${task.subject}` }], details: { task } };
      },
    }),
  });
}

// ── TaskUpdate ────────────────────────────────────────────────────────────────

const TaskUpdateStatus = z.enum(["pending", "in_progress", "completed", "deleted"]);

const TaskUpdateInput = z.object({
  taskId: z.string().describe("The id of the task to update."),
  subject: z.string().optional().describe("New subject."),
  description: z.string().optional().describe("New description."),
  activeForm: z.string().optional().describe("New present-continuous form."),
  status: TaskUpdateStatus.optional().describe('New status. "deleted" removes the task.'),
  owner: z.string().optional().describe("New owner (agent id)."),
  addBlocks: z.array(z.string()).optional().describe("Task ids this task should now block."),
  addBlockedBy: z.array(z.string()).optional().describe("Task ids that should now block this task."),
  metadata: MetadataSchema.optional().describe("Metadata to merge in."),
});

export function taskUpdateTool(store: TaskStore): Tool {
  return defineTool({
    name: TASK_UPDATE_TOOL_NAME,
    description: "Update a task: fields, status (including \"deleted\"), owner, or dependency edges (addBlocks/addBlockedBy).",
    params: TaskUpdateInput,
    resolve: (args) => ({
      approvalRule: TASK_UPDATE_TOOL_NAME,
      accesses: ToolAccesses.none(),
      display: { title: args.status === "deleted" ? `Delete task #${args.taskId}` : `Update task #${args.taskId}` },
      run: async (): Promise<ToolResult> => {
        const before = store.get(args.taskId);
        if (before === undefined) {
          return { content: [{ type: "text", text: `Unknown task id "${args.taskId}".` }], isError: true };
        }

        if (args.status === "deleted") {
          await store.delete(args.taskId);
          return { content: [{ type: "text", text: `Task #${args.taskId} deleted.` }], details: { taskId: args.taskId, deleted: true } };
        }

        const scalar = {
          subject: args.subject,
          description: args.description,
          activeForm: args.activeForm,
          owner: args.owner,
          status: args.status,
          metadata: args.metadata === undefined ? undefined : { ...before.metadata, ...args.metadata },
        };
        await store.update(args.taskId, scalar);
        for (const blocked of args.addBlocks ?? []) await store.block(args.taskId, blocked);
        for (const blocker of args.addBlockedBy ?? []) await store.block(blocker, args.taskId);

        const after = store.get(args.taskId)!;
        const updatedFields = updatedFieldNames(before, after);
        const statusChange = before.status !== after.status ? { from: before.status, to: after.status } : undefined;
        return {
          content: [{ type: "text", text: `Task #${args.taskId} updated${updatedFields.length > 0 ? `: ${updatedFields.join(", ")}` : "."}` }],
          details: { task: after, updatedFields, statusChange },
        };
      },
    }),
  });
}

// ── TaskList ──────────────────────────────────────────────────────────────────

export function taskListTool(store: TaskStore): Tool {
  return defineTool({
    name: TASK_LIST_TOOL_NAME,
    description: "List all tasks in the structured task list, with status and dependencies.",
    params: z.object({}),
    resolve: () => ({
      approvalRule: TASK_LIST_TOOL_NAME,
      accesses: ToolAccesses.none(),
      display: { title: "List tasks" },
      run: async (): Promise<ToolResult> => {
        const tasks = store.list();
        return { content: [{ type: "text", text: renderTaskList(tasks) }], details: { tasks } };
      },
    }),
  });
}

// ── TaskGet ───────────────────────────────────────────────────────────────────

export function taskGetTool(store: TaskStore): Tool {
  return defineTool({
    name: TASK_GET_TOOL_NAME,
    description: "Get one task by id, with its full description, status, and dependencies.",
    params: z.object({ taskId: z.string().describe("The id of the task to read.") }),
    resolve: (args) => ({
      approvalRule: TASK_GET_TOOL_NAME,
      accesses: ToolAccesses.none(),
      display: { title: `Get task #${args.taskId}` },
      run: async (): Promise<ToolResult> => {
        const task = store.get(args.taskId);
        if (task === undefined) {
          return { content: [{ type: "text", text: `Unknown task id "${args.taskId}".` }], isError: true };
        }
        return { content: [{ type: "text", text: renderTask(task) }], details: { task } };
      },
    }),
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export function renderTaskList(tasks: readonly Task[], title = "Task list:"): string {
  if (tasks.length === 0) return "Task list is empty.";
  return [title, ...tasks.map(renderTaskRow)].join("\n");
}

function renderTaskRow(task: Task): string {
  const deps = task.blockedBy.length > 0 ? ` (blockedBy: ${task.blockedBy.join(", ")})` : "";
  const owner = task.owner !== undefined ? ` @${task.owner}` : "";
  return `  #${task.id} [${task.status}] ${task.subject}${owner}${deps}`;
}

function renderTask(task: Task): string {
  const lines = [`#${task.id} [${task.status}] ${task.subject}`, task.description];
  if (task.owner !== undefined) lines.push(`owner: ${task.owner}`);
  if (task.blocks.length > 0) lines.push(`blocks: ${task.blocks.join(", ")}`);
  if (task.blockedBy.length > 0) lines.push(`blockedBy: ${task.blockedBy.join(", ")}`);
  return lines.join("\n");
}

function updatedFieldNames(before: Task, after: Task): string[] {
  const fields: string[] = [];
  for (const key of ["subject", "description", "activeForm", "owner", "status"] as const) {
    if (before[key] !== after[key]) fields.push(key);
  }
  if (JSON.stringify(before.blocks) !== JSON.stringify(after.blocks)) fields.push("blocks");
  if (JSON.stringify(before.blockedBy) !== JSON.stringify(after.blockedBy)) fields.push("blockedBy");
  if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) fields.push("metadata");
  return fields;
}
