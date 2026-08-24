import type { Task, TaskListPersistence, TaskStatus } from "./persist.ts";

export type { Task, TaskStatus } from "./persist.ts";
export { TASK_STATUSES } from "./persist.ts";

export interface TaskCreateInput {
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly status?: TaskStatus;
  readonly metadata?: Record<string, unknown>;
}

/** Scalar-field updates (dependency edges go through `block`). */
export interface TaskScalarUpdate {
  readonly subject?: string;
  readonly description?: string;
  readonly activeForm?: string;
  readonly owner?: string;
  readonly status?: TaskStatus;
  readonly metadata?: Record<string, unknown>;
}

/**
 * In-memory task list backed by a `TaskListPersistence`. Loaded once at session open, then kept
 * in memory for synchronous reads (the injector) while every mutation writes through to the
 * backend. A session has a single live loop (one writer), so whole-record writes cannot race —
 * no locking is needed. Insertion order is preserved by the Map.
 */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private highWaterMark = 0;
  private persistence?: TaskListPersistence;

  attach(persistence: TaskListPersistence | undefined): void {
    this.persistence = persistence;
  }

  /** Rehydrate from the backend (session open). Ids stay sequential across the high-water-mark. */
  async load(): Promise<void> {
    this.tasks.clear();
    this.highWaterMark = 0;
    if (this.persistence === undefined) return;
    const loaded = await this.persistence.listTasks();
    loaded.sort((a, b) => Number(a.id) - Number(b.id));
    for (const task of loaded) this.tasks.set(task.id, task);
    const maxId = loaded.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    this.highWaterMark = Math.max(await this.persistence.readHighWaterMark(), maxId);
  }

  list(): readonly Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  async create(input: TaskCreateInput): Promise<Task> {
    this.highWaterMark += 1;
    const id = String(this.highWaterMark);
    const task: Task = {
      id,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      owner: input.owner,
      status: input.status ?? "pending",
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
    };
    this.tasks.set(id, task);
    await this.persistence?.writeTask(task);
    await this.persistence?.writeHighWaterMark(this.highWaterMark);
    return task;
  }

  async update(id: string, updates: TaskScalarUpdate): Promise<Task | undefined> {
    const existing = this.tasks.get(id);
    if (existing === undefined) return undefined;
    const updated: Task = { ...existing, ...pruneUndefined(updates), id };
    this.tasks.set(id, updated);
    await this.persistence?.writeTask(updated);
    return updated;
  }

  /** Delete a task and cascade-remove references to it from every other task's edges. */
  async delete(id: string): Promise<boolean> {
    if (!this.tasks.has(id)) return false;
    this.tasks.delete(id);
    await this.persistence?.deleteTask(id);
    for (const task of [...this.tasks.values()]) {
      const blocks = task.blocks.filter((x) => x !== id);
      const blockedBy = task.blockedBy.filter((x) => x !== id);
      if (blocks.length !== task.blocks.length || blockedBy.length !== task.blockedBy.length) {
        await this.writeEdges(task.id, blocks, blockedBy);
      }
    }
    return true;
  }

  /** Record that `fromId` blocks `toId` (updates both endpoints' edge lists). */
  async block(fromId: string, toId: string): Promise<boolean> {
    const from = this.tasks.get(fromId);
    const to = this.tasks.get(toId);
    if (from === undefined || to === undefined) return false;
    if (!from.blocks.includes(toId)) await this.writeEdges(fromId, [...from.blocks, toId], from.blockedBy);
    const toNow = this.tasks.get(toId)!;
    if (!toNow.blockedBy.includes(fromId)) await this.writeEdges(toId, toNow.blocks, [...toNow.blockedBy, fromId]);
    return true;
  }

  private async writeEdges(id: string, blocks: readonly string[], blockedBy: readonly string[]): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing === undefined) return;
    const updated: Task = { ...existing, blocks, blockedBy };
    this.tasks.set(id, updated);
    await this.persistence?.writeTask(updated);
  }
}

function pruneUndefined(updates: TaskScalarUpdate): TaskScalarUpdate {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) if (value !== undefined) out[key] = value;
  return out as TaskScalarUpdate;
}
