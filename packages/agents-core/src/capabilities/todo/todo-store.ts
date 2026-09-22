import { DEFAULT_ADDRESS, type AgentRecord } from "../../store/index.ts";
import { latestToolDetailsByAddress } from "../capability-state.ts";

export const TODO_LIST_TOOL_NAME = "TodoList";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

/** Snapshot carried in the TodoList tool result `details`, folded back on session open. */
export interface TodoDetails {
  readonly todos: readonly TodoItem[];
}

const NO_TODOS: readonly TodoItem[] = [];

/**
 * One todo list PER FRAME, keyed by journal address (`main`, `main/<agentId>`).
 *
 * A task list belongs to the agent working through it, not to the conversation: a subagent plans
 * its own work, and until this was keyed, its first `TodoList` call replaced the main agent's
 * list outright — silently, since the parent's transcript still carried its own last result.
 * The service stays a single session-lived object (it owns nothing that needs closing); what is
 * per-frame is the DATA, so it is indexed rather than duplicated. See docs/state-and-lifetime.md.
 */
export class TodoStore {
  private readonly byFrame = new Map<string, readonly TodoItem[]>();

  /** The list for one frame. Defaults to the root agent's, which is what `session.todo` reads. */
  get(address: string = DEFAULT_ADDRESS): readonly TodoItem[] {
    return this.byFrame.get(address) ?? NO_TODOS;
  }

  set(address: string, todos: readonly TodoItem[]): readonly TodoItem[] {
    const normalized = normalizeTodos(todos);
    this.byFrame.set(address, normalized);
    return normalized;
  }

  /** Every frame that has one, in insertion order. */
  frames(): readonly string[] {
    return [...this.byFrame.keys()];
  }

  /** Rebuild from the log: within each shard, the latest TodoList result is that frame's list. */
  reconstruct(entries: readonly AgentRecord[]): void {
    this.byFrame.clear();
    for (const [address, details] of latestToolDetailsByAddress(entries, TODO_LIST_TOOL_NAME)) {
      if (isTodoDetails(details)) this.byFrame.set(address, normalizeTodos(details.todos));
    }
  }
}

function normalizeTodos(todos: readonly TodoItem[]): readonly TodoItem[] {
  return todos.map((todo) => ({ title: todo.title, status: todo.status }));
}

function isTodoDetails(value: unknown): value is TodoDetails {
  if (typeof value !== "object" || value === null) return false;
  const todos = (value as { todos?: unknown }).todos;
  return Array.isArray(todos) && todos.every(isTodoItem);
}

function isTodoItem(item: unknown): item is TodoItem {
  if (typeof item !== "object" || item === null) return false;
  const record = item as Record<string, unknown>;
  return typeof record["title"] === "string" && isTodoStatus(record["status"]);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "done";
}
