import type { Message } from "../../protocol/index.ts";
import { BoundaryInjector, type InjectionContext, type InjectionResult } from "../injection.ts";
import type { TodoStore } from "./todo-store.ts";
import { renderTodoList, TODO_LIST_TOOL_NAME } from "./tools.ts";

// Occasional-nudge cadence: remind only when the model hasn't touched the list
// for a while AND we haven't just reminded — so the reminder is a sparse, recorded nudge, not a
// per-turn state mirror (the current list already rides in each TodoList tool result).
const TURNS_SINCE_WRITE = 10;
const TURNS_BETWEEN_REMINDERS = 10;

export class TodoListInjector extends BoundaryInjector {
  readonly id = "todo";
  private readonly store: TodoStore;

  constructor(store: TodoStore) {
    super();
    this.store = store;
  }

  protected getInjection(ctx: InjectionContext): InjectionResult | null {
    this.restoreInjectedAt(ctx, ["todo_reminder"]);
    const todos = this.store.get();
    if (todos.length === 0) return null;

    const turnsSinceWrite = assistantTurnsSinceTodoWrite(ctx.history);
    // Reminder spacing is tracked by `injectedAt` (the position of the last reminder) + role
    // counting — no need to read message origin, so this holds under origin-on-Entry-only.
    const turnsSinceReminder = this.injectedAt === null ? Number.POSITIVE_INFINITY : assistantTurnsSince(ctx.history, this.injectedAt);
    if (turnsSinceWrite < TURNS_SINCE_WRITE || turnsSinceReminder < TURNS_BETWEEN_REMINDERS) return null;

    return {
      variant: "todo_reminder",
      text: [
        "The TodoList tool has not been updated recently. If you are working on tasks that benefit from progress tracking, consider using TodoList to update task status. Also consider clearing or rewriting the list if it has gone stale. Only use it if relevant — this is a gentle reminder, ignore if not applicable. Never mention this reminder to the user.",
        "",
        "Current todo list:",
        renderTodoList(todos),
      ].join("\n"),
    };
  }
}

/** Assistant messages between `from` (exclusive) and the end of history. */
function assistantTurnsSince(history: readonly Message[], from: number): number {
  let count = 0;
  for (let i = from + 1; i < history.length; i++) {
    if (history[i]?.role === "assistant") count += 1;
  }
  return count;
}

/** Assistant messages since the last TodoList write (a TodoList tool call or its result).
 *  `Infinity` when there is no write in history (so a fresh list nudges only after enough turns). */
function assistantTurnsSinceTodoWrite(history: readonly Message[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === undefined) continue;
    if (isTodoWrite(msg)) return count;
    if (msg.role === "assistant") count += 1;
  }
  return Number.POSITIVE_INFINITY;
}

function isTodoWrite(msg: Message): boolean {
  if (msg.role === "toolResult") return msg.toolName === TODO_LIST_TOOL_NAME;
  if (msg.role === "assistant") return msg.content.some((p) => p.type === "toolCall" && p.name === TODO_LIST_TOOL_NAME);
  return false;
}
