import type { Machine } from "../../tool/machine.ts";
import type { AgentBackgroundTaskInfo } from "./agent-task.ts";
import type { CommandBackgroundTaskInfo } from "./command-task.ts";
import type { QuestionBackgroundTaskInfo } from "./question-task.ts";
import type { WorkflowBackgroundTaskInfo } from "./workflow-task.ts";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "paused" | "timed_out" | "killed" | "lost";

export const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  "completed",
  "failed",
  "paused",
  "timed_out",
  "killed",
  "lost",
]);

export type BackgroundTaskSettlementStatus = "completed" | "failed" | "paused" | "timed_out" | "killed";

export interface BackgroundTaskSettlement {
  readonly status: BackgroundTaskSettlementStatus;
  readonly stopReason?: string;
}

export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  /** Conversation line + assistant tool call that created this task. Together they are unique
   *  inside a session and let crash recovery find the task even when its spawn acknowledgement
   *  never made it into the parent conversation. */
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
  /** Stable pointer to the task's complete output. This is the wire/store shape: unlike
   *  {@link TaskOutputLocation}, it contains no live Machine handle and survives restart. */
  readonly outputRef?: TaskOutputRef;
}

export type BackgroundTaskInfo =
  | CommandBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo
  | WorkflowBackgroundTaskInfo;

export interface BackgroundTaskSink {
  readonly signal: AbortSignal;
  settle(settlement: BackgroundTaskSettlement): Promise<boolean>;
}

/**
 * Where a task's output already lives — a FACT the task states, never a copy it holds.
 *
 * The variants exist because output has several native homes and none is this process. A
 * command's bytes are written by the OS into a file on the machine; a sub-agent's messages are
 * appended by its conversation into a shard of the session store. In both cases the substance
 * is already somewhere durable, addressable, and (for the shard) shared with every other view
 * of the same data — the projection a UI subscribes to reads that identical record.
 *
 * Declaring the location instead of mirroring the content is what keeps a task from paying for
 * observation nobody asked for, from capping history at whatever a buffer holds, and from
 * creating a second copy whose authority is ambiguous. Production background work must
 * declare one of these locations. The sole exception is a question: its answer is
 * unreproducible user input and therefore rides along with its settle notification instead
 * of pretending to be a separately retrievable result.
 */
export type TaskOutputRef =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "conversation"; readonly address: string }
  | { readonly kind: "workflow-run"; readonly address: string };

export type TaskOutputLocation =
  /** Redirected on the machine: `<home>/.operon/tasks/<id>.log` and the like. */
  | { readonly kind: "file"; readonly machine: Machine; readonly path: string }
  /** A sub-agent's own conversation shard, read back and reduced to its latest answer. */
  | { readonly kind: "conversation"; readonly address: string }
  /** A workflow run's journal: inputs, every agent result, and the outcome. */
  | { readonly kind: "workflow-run"; readonly address: string };

/** Strip runtime-only handles at the persistence/event boundary. */
export function taskOutputRef(location: TaskOutputLocation | undefined): TaskOutputRef | undefined {
  if (location === undefined) return undefined;
  return location.kind === "file"
    ? { kind: "file", path: location.path }
    : { kind: location.kind, address: location.address };
}

export interface BackgroundTaskOutputSnapshot {
  /** The bounded output window returned by this read. */
  readonly content: string;
  /** Total UTF-8 bytes in the authoritative output. */
  readonly sizeBytes: number;
  /** UTF-8 bytes present in `content` after boundary alignment. */
  readonly contentBytes: number;
  readonly truncated: boolean;
}

export interface BackgroundTaskOutputDelta {
  readonly content: string;
  /** Opaque cursor to pass to the next delta read. */
  readonly nextCursor: number;
  /** False when this task's output has no byte-addressable incremental view. */
  readonly followable: boolean;
}

export interface BackgroundTask {
  readonly idPrefix: string;
  readonly kind: BackgroundTaskInfo["kind"];
  readonly description: string;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  readonly timeoutMs?: number;

  /** Aborting `sink.signal` is the whole stop protocol — there is no second, harder step.
   *  A task that drives a command forwards the signal to `machine.run`, where SIGTERM →
   *  grace → SIGKILL escalation lives. */
  start(sink: BackgroundTaskSink): void | Promise<void>;
  toInfo(base: BackgroundTaskInfoBase): BackgroundTaskInfo;
  /** Where this task's output already lives. Required by the manager for every kind except a
   *  question. Readers window it on demand; see {@link TaskOutputLocation}. */
  readonly outputLocation?: TaskOutputLocation;
}

export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
