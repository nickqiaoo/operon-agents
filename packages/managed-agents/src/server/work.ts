/**
 * The work table: a session's managed event log, and who is running the session.
 *
 * Two kinds of rows, one per session plus one per event:
 *
 *  - The session row says "something was sent since a holder last looked" (`woken`) and who
 *    holds the lease. Taking the lease IS the claim; there is no separate dispatched state.
 *  - Event rows are the session's history in the managed vocabulary: every event a client sent
 *    (pending until processed, see `inbox.ts`) and every event a worker emitted.
 *
 * Input moves by PULL. `append` persists inputs and wakes the session row in one commit, so an
 * accepted event is never invisible to a claim. Idle workers claim woken sessions; a worker
 * that already holds a session polls `pending` on its own schedule. Nothing in the API knows
 * which node runs a session, and nothing pushes to one.
 *
 * Writes a holder makes (`acknowledge`, `recordOutput`) are fenced: a holder whose lease was
 * taken over cannot write into its successor's history.
 */
import type { ManagedEventResource } from "../protocol/types.ts";
import type { InboxEntry } from "./inbox.ts";

export interface WorkLease {
  readonly sessionId: string;
  /** Monotonic fencing token, bumped on every take of this row. */
  readonly fence: number;
  /** Aborts when the lease is lost or released. Treat it as a cancel. */
  readonly signal: AbortSignal;
  /** Heartbeat. False when the lease is gone — taken over, or expired — and the signal aborted. */
  renew(): Promise<boolean>;
  /**
   * Clear this session's wake before a final look at `pending`. Anything appended after this
   * call wakes the row again, so a holder that finds nothing to do and releases cannot strand
   * an input that arrived meanwhile — the next claim takes it.
   */
  clearWake(): Promise<void>;
  /** Give the row back. Idempotent. A wake that arrived meanwhile stays on the row. */
  release(): Promise<void>;
}

export interface EventPageOptions {
  readonly limit: number;
  /** Opaque cursor from a previous page's `next`. */
  readonly page?: string;
  readonly order?: "asc" | "desc";
}

export interface EventPage {
  readonly data: readonly ManagedEventResource[];
  readonly next?: string;
}

export interface SessionWork {
  /** Persist sent events and wake the session, in one commit. */
  append(sessionId: string, entries: readonly InboxEntry[]): Promise<void>;
  /** Wake the session without sending anything (deletion uses it to reach a worker). */
  wake(sessionId: string): Promise<void>;
  /** Unprocessed inputs, in the order they were accepted. */
  pending(sessionId: string): Promise<readonly InboxEntry[]>;
  /** Mark inputs processed. Fenced: throws when `fence` no longer holds the session. */
  acknowledge(sessionId: string, ids: readonly string[], fence: number): Promise<void>;
  /** Append emitted events to the history; an id already present is skipped. Fenced. */
  recordOutput(sessionId: string, events: readonly ManagedEventResource[], fence: number): Promise<void>;
  /** The history, inputs and outputs interleaved in the order they were written. */
  listEvents(sessionId: string, options: EventPageOptions): Promise<EventPage>;
  /** The most recent `session.status_*` event, if any. */
  latestStatus(sessionId: string): Promise<ManagedEventResource | undefined>;
  /** Forget the session: its row and its whole history. */
  purge(sessionId: string): Promise<void>;
  /**
   * Lease the next session that is woken, or whose holder let its lease lapse. Undefined when
   * there is none. Concurrent callers never receive the same session.
   */
  claim(): Promise<WorkLease | undefined>;
  /** Lease this one session, or undefined while a live lease is held elsewhere. */
  acquire(sessionId: string): Promise<WorkLease | undefined>;
  /** Advisory: is a live lease held right now? Stale the instant it returns — never gate on it. */
  peek(sessionId: string): Promise<boolean>;
}

/** Thrown by fenced writes from a holder that no longer holds the session. */
export class WorkLeaseLostError extends Error {
  constructor(sessionId: string) {
    super(`lease on session "${sessionId}" was lost`);
    this.name = "WorkLeaseLostError";
  }
}

export function isStatusEvent(event: { readonly type: string }): boolean {
  return event.type.startsWith("session.status_");
}
