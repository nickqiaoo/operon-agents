import { DEFAULT_ADDRESS } from "../../store/index.ts";

export const TODO_LIST_TOOL_NAME = "TodoList";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

/** The frame's whole list: carried in the TodoList tool result `details` for the transcript,
 *  and what is stored as the frame's durable state. */
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
  /** Persists one frame's list after a change. Absent in a bare store (tests). */
  private persist: ((address: string) => void) | undefined;

  /** Where a change to a frame's list becomes durable (`SessionContext.persistState`). */
  attachPersistence(persist: (address: string) => void): void {
    this.persist = persist;
  }

  /** The list for one frame. Defaults to the root agent's, which is what `session.todo` reads. */
  get(address: string = DEFAULT_ADDRESS): readonly TodoItem[] {
    return this.byFrame.get(address) ?? NO_TODOS;
  }

  set(address: string, todos: readonly TodoItem[]): readonly TodoItem[] {
    const normalized = normalizeTodos(todos);
    this.byFrame.set(address, normalized);
    this.persist?.(address);
    return normalized;
  }

  /** Every frame that has one, in insertion order. */
  frames(): readonly string[] {
    return [...this.byFrame.keys()];
  }

  /** One frame's list as its durable state; undefined when the frame has none. */
  snapshot(address: string): TodoDetails | undefined {
    const todos = this.byFrame.get(address);
    return todos === undefined ? undefined : { todos };
  }

  /**
   * Restore one frame's list from the value stored for it (undefined: none). A frame's list is
   * restored when its shard is reopened — `main` at open, a subagent's on resume.
   */
  restore(address: string, value: unknown): void {
    if (isTodoDetails(value)) this.byFrame.set(address, normalizeTodos(value.todos));
    else this.byFrame.delete(address);
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
