import type { Message } from "../../protocol/index.ts";
import { BoundaryInjector, type InjectionContext, type InjectionResult } from "../injection.ts";
import type { TaskStore } from "./task-store.ts";
import { renderTaskList, TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME } from "./tools.ts";

// Occasional-nudge cadence (todo-aligned): remind only when the model hasn't touched the task
// list for a while AND we haven't just reminded — a sparse recorded nudge, not a per-turn mirror.
const TURNS_SINCE_WRITE = 10;
const TURNS_BETWEEN_REMINDERS = 10;

const WRITE_TOOLS: ReadonlySet<string> = new Set([TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME]);

export class TaskListInjector extends BoundaryInjector {
  readonly id = "task";
  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    super();
    this.store = store;
  }

  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    this.restoreInjectedAt(ctx, ["task_reminder"]);
    const tasks = this.store.list();
    if (tasks.length === 0) return null;

    const turnsSinceWrite = assistantTurnsSinceTaskWrite(ctx.history);
    const turnsSinceReminder = this.injectedAt === null ? Number.POSITIVE_INFINITY : assistantTurnsSince(ctx.history, this.injectedAt);
    if (turnsSinceWrite < TURNS_SINCE_WRITE || turnsSinceReminder < TURNS_BETWEEN_REMINDERS) return null;

    return {
      variant: "task_reminder",
      text: [
        "The task list has not been updated recently. If you are working on tasks that benefit from tracking, use TaskUpdate to move them through pending → in_progress → completed (keep one in_progress when work is underway). Only if relevant — a gentle reminder, ignore if not applicable. Never mention this reminder to the user.",
        "",
        renderTaskList(tasks),
      ].join("\n"),
    };
  }
}

function assistantTurnsSince(history: readonly Message[], from: number): number {
  let count = 0;
  for (let i = from + 1; i < history.length; i++) {
    if (history[i]?.role === "assistant") count += 1;
  }
  return count;
}

function assistantTurnsSinceTaskWrite(history: readonly Message[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === undefined) continue;
    if (isTaskWrite(msg)) return count;
    if (msg.role === "assistant") count += 1;
  }
  return Number.POSITIVE_INFINITY;
}

function isTaskWrite(msg: Message): boolean {
  if (msg.role === "toolResult") return WRITE_TOOLS.has(msg.toolName);
  if (msg.role === "assistant") return msg.content.some((p) => p.type === "toolCall" && WRITE_TOOLS.has(p.name));
  return false;
}
