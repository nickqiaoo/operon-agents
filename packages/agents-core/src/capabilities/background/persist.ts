import type { SessionStore, StateKey } from "../../store/index.ts";
import { TERMINAL_STATUSES, type BackgroundTaskInfo, type BackgroundTaskStatus, type TaskOutputRef } from "./task.ts";

/**
 * Background-task persistence — the durable, per-task STATUS record that survives a process
 * restart, replacing the old fold-over-the-conversation reconstruction. On reopen the manager
 * lists these records: any task still in a non-terminal status is an orphan whose spawning
 * process died, so it is reclassified `lost` (see `manager.reconcile`). This is a dedicated
 * task store (SessionStore-backed), NOT a fold of the append log — an intentional departure
 * from the "append log is the only record" rule, documented in `store.ts`.
 *
 * A `PersistedTask` is the task's serializable status projection plus one stable `outputRef`.
 * Result bytes never live here: Bash points at a file, Agent at its conversation shard, and
 * Workflow at its journal. `schemaVersion: 2` is an intentional clean cut; older shapes are not
 * accepted or migrated.
 */
export type PersistedTask = BackgroundTaskInfo & {
  readonly schemaVersion: 2;
  /** Monotonic within one manager. Writes are serialized, so later lifecycle snapshots cannot
   *  be overwritten by an older in-flight write. */
  readonly revision: number;
  /**
   * The settle-notification ledger, in two stamps. Queuing alone proves nothing — the SteerBus
   * is in memory, so a crash between enqueue and drain loses the notification while the task
   * record survives as terminal.
   *
   *   queued, never confirmed  ⇒ lost in the crash window ⇒ redelivered on reopen
   *   never queued             ⇒ nothing was owed (suppressed settle) ⇒ left alone
   *   confirmed                ⇒ the model saw it ⇒ done
   *
   * Two stamps rather than one flag is what makes both negatives distinguishable: neither
   * stamp means the terminal notification was intentionally suppressed and nothing is owed.
   *
   * `notifiedAt` is stamped from the recipient's `message.appended`, mirroring how peer
   * delivery settles its ledger on consumption rather than on hand-off.
   */
  readonly notificationQueuedAt?: number;
  readonly notifiedAt?: number;
};

export interface BackgroundTaskPersistence {
  /** Write (create or overwrite) a task's status record. BackgroundManager serializes all
   *  calls so whole-record writes and the backend's shared index update cannot race. */
  writeTask(task: PersistedTask): Promise<void>;
  readTask(taskId: string): Promise<PersistedTask | undefined>;
  /** Every persisted task, in unspecified order. */
  listTasks(): Promise<readonly PersistedTask[]>;
  deleteTask(taskId: string): Promise<void>;
}

/** Non-terminal = the spawning process never wrote a terminal status → orphan on reopen. */
export function isPersistedTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const TASK_KINDS: ReadonlySet<string> = new Set(["process", "agent", "question", "workflow"]);
const STATUSES: ReadonlySet<string> = new Set([
  "running",
  "completed",
  "failed",
  "paused",
  "timed_out",
  "killed",
  "lost",
]);

/** Validate an untrusted persisted record (older wire versions, corrupt files). */
export function isValidPersistedTask(value: unknown): value is PersistedTask {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (o["schemaVersion"] !== 2) return false;
  if (typeof o["revision"] !== "number" || !Number.isInteger(o["revision"]) || o["revision"] < 1) return false;
  if (typeof o["taskId"] !== "string" || o["taskId"].length === 0) return false;
  if (typeof o["kind"] !== "string" || !TASK_KINDS.has(o["kind"])) return false;
  if (typeof o["status"] !== "string" || !STATUSES.has(o["status"])) return false;
  if (typeof o["description"] !== "string") return false;
  if (o["parentAddress"] !== undefined && typeof o["parentAddress"] !== "string") return false;
  if (o["toolCallId"] !== undefined && typeof o["toolCallId"] !== "string") return false;
  if (typeof o["startedAt"] !== "number") return false;
  if (o["endedAt"] !== null && typeof o["endedAt"] !== "number") return false;
  if (!isValidOutputRef(o["outputRef"])) return false;
  if (o["kind"] === "process" && (o["outputRef"] as TaskOutputRef | undefined)?.kind !== "file") return false;
  if (o["kind"] === "agent" && (o["outputRef"] as TaskOutputRef | undefined)?.kind !== "conversation") return false;
  if (o["kind"] === "workflow" && (o["outputRef"] as TaskOutputRef | undefined)?.kind !== "workflow-run") return false;
  if (o["kind"] === "question" && o["outputRef"] !== undefined) return false;
  if (o["notificationQueuedAt"] !== undefined && typeof o["notificationQueuedAt"] !== "number") return false;
  if (o["notifiedAt"] !== undefined && typeof o["notifiedAt"] !== "number") return false;
  return true;
}

function isValidOutputRef(value: unknown): value is TaskOutputRef | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  if (ref["kind"] === "file") return typeof ref["path"] === "string" && ref["path"].length > 0;
  if (ref["kind"] === "conversation" || ref["kind"] === "workflow-run") {
    return typeof ref["address"] === "string" && ref["address"].length > 0;
  }
  return false;
}

// ── SessionStore KV backend ──────────────────────────────────────────────────
//
// Works on every SessionStore backend (disk/pg/redis/memory): status lives in KV state,
// mirroring how cron persists its registry (`cron/persist.ts`). Kept off the Machine
// for the same reason cron is — bookkeeping must be readable with no workspace attached and
// must sit outside the space agent-run code can touch. One index key + one key per task
// (tasks carry a large output tail elsewhere, so unlike cron they are not one whole blob).

const INDEX_KEY: StateKey = "bg:index";
const taskKey = (taskId: string): StateKey => `bg:task:${taskId}`;

export class StoreBackgroundTaskPersistence implements BackgroundTaskPersistence {
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  async writeTask(task: PersistedTask): Promise<void> {
    await this.store.putState(taskKey(task.taskId), task);
    const index = await this.readIndex();
    if (!index.includes(task.taskId)) {
      await this.store.putState(INDEX_KEY, [...index, task.taskId]);
    }
  }

  async readTask(taskId: string): Promise<PersistedTask | undefined> {
    const value = await this.store.getState(taskKey(taskId));
    return isValidPersistedTask(value) ? value : undefined;
  }

  async listTasks(): Promise<readonly PersistedTask[]> {
    const index = await this.readIndex();
    const out: PersistedTask[] = [];
    for (const id of index) {
      const task = await this.readTask(id);
      if (task !== undefined) out.push(task);
    }
    return out;
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.store.deleteState(taskKey(taskId));
    const index = await this.readIndex();
    if (index.includes(taskId)) {
      await this.store.putState(INDEX_KEY, index.filter((id) => id !== taskId));
    }
  }

  private async readIndex(): Promise<readonly string[]> {
    const value = await this.store.getState(INDEX_KEY);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  }
}
