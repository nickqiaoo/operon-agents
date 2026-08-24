import type { AgentRecord } from "../../store/index.ts";
import { latestToolDetails } from "../capability-state.ts";

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

export class TodoStore {
  private todos: readonly TodoItem[] = [];

  get(): readonly TodoItem[] {
    return this.todos;
  }

  set(todos: readonly TodoItem[]): readonly TodoItem[] {
    this.todos = normalizeTodos(todos);
    return this.todos;
  }

  /** Rebuild from the log: the latest TodoList tool result is the current list. */
  reconstruct(entries: readonly AgentRecord[]): void {
    const details = latestToolDetails(entries, TODO_LIST_TOOL_NAME);
    this.todos = isTodoDetails(details) ? normalizeTodos(details.todos) : [];
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
