import type { SessionStore, StateKey } from "../../store/index.ts";

/**
 * Structured task list (TaskCreate/Update/List/Get) — a
 * richer replacement for the flat TodoList, with per-task records, statuses, dependencies
 * (blocks/blockedBy), owner, and metadata. Unlike TodoList (a fold of the latest TodoList tool
 * result), the task list is a dedicated per-task store, so it survives resume without folding
 * the conversation. Storage is backend-selected (like background tasks): disk sessions keep one
 * JSON file per task under `<sessionDir>/tasklist/`, other backends use KV state.
 *
 * There is deliberately no swarm/team layer (task claiming, agent-busy checks, team files) —
 * this framework has no team model. The `owner` / `blocks` / `blockedBy` fields are kept so the
 * data model stays complete and dependencies work.
 */

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  /** Present-continuous form for a spinner (e.g. "Running tests"). */
  readonly activeForm?: string;
  /** Agent id that owns the task (optional; no team-claim logic is ported). */
  readonly owner?: string;
  readonly status: TaskStatus;
  /** Task ids this task blocks. */
  readonly blocks: readonly string[];
  /** Task ids that block this task. */
  readonly blockedBy: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface TaskListPersistence {
  writeTask(task: Task): Promise<void>;
  readTask(id: string): Promise<Task | undefined>;
  listTasks(): Promise<Task[]>;
  deleteTask(id: string): Promise<void>;
  /** The highest task id ever assigned (survives deletes, so ids are never reused). */
  readHighWaterMark(): Promise<number>;
  writeHighWaterMark(value: number): Promise<void>;
}

export function isValidTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length === 0) return false;
  if (typeof o["subject"] !== "string") return false;
  if (typeof o["description"] !== "string") return false;
  if (typeof o["status"] !== "string" || !(TASK_STATUSES as readonly string[]).includes(o["status"])) return false;
  if (!Array.isArray(o["blocks"]) || !o["blocks"].every((x) => typeof x === "string")) return false;
  if (!Array.isArray(o["blockedBy"]) || !o["blockedBy"].every((x) => typeof x === "string")) return false;
  if (o["activeForm"] !== undefined && typeof o["activeForm"] !== "string") return false;
  if (o["owner"] !== undefined && typeof o["owner"] !== "string") return false;
  return true;
}

// ── SessionStore KV backend ──────────────────────────────────────────────────
// One key per task + an index + the high-water-mark, mirroring the background task store's KV
// backend. Kept off the Machine (agent bookkeeping, per the cron/background rule).

const INDEX_KEY: StateKey = "tasklist:index";
const HWM_KEY: StateKey = "tasklist:hwm";
const taskKey = (id: string): StateKey => `tasklist:task:${id}`;

export class StoreTaskListPersistence implements TaskListPersistence {
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  async writeTask(task: Task): Promise<void> {
    await this.store.putState(taskKey(task.id), task);
    const index = await this.readIndex();
    if (!index.includes(task.id)) await this.store.putState(INDEX_KEY, [...index, task.id]);
  }

  async readTask(id: string): Promise<Task | undefined> {
    const value = await this.store.getState(taskKey(id));
    return isValidTask(value) ? value : undefined;
  }

  async listTasks(): Promise<Task[]> {
    const out: Task[] = [];
    for (const id of await this.readIndex()) {
      const task = await this.readTask(id);
      if (task !== undefined) out.push(task);
    }
    return out;
  }

  async deleteTask(id: string): Promise<void> {
    await this.store.deleteState(taskKey(id));
    const index = await this.readIndex();
    if (index.includes(id)) await this.store.putState(INDEX_KEY, index.filter((x) => x !== id));
  }

  async readHighWaterMark(): Promise<number> {
    const value = await this.store.getState(HWM_KEY);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  async writeHighWaterMark(value: number): Promise<void> {
    await this.store.putState(HWM_KEY, value);
  }

  private async readIndex(): Promise<readonly string[]> {
    const value = await this.store.getState(INDEX_KEY);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  }
}
