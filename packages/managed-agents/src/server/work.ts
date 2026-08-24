/**
 * The work table: which sessions have something to do, and who is doing it.
 *
 * One row per session that has been appended to or is being run. A row says two things — "new
 * inbox since a holder last looked" (`woken`) and "who holds the lease" — and every operation
 * here is one atomic step over that row, which is what makes this both the queue and the lock:
 *
 *  - `append` puts a record in the session's log AND wakes the row, in one transaction where
 *    the backing has them. There is no moment where the log has an input the table does not
 *    know about, so nothing ever has to scan the log to find forgotten work.
 *  - `claim` takes the lease on one woken (or abandoned) session. Taking it IS the claim; there
 *    is no separate "dispatched" state that could disagree with "held".
 *  - `renew` is the holder's heartbeat, and carries the only signal a holder gets from other
 *    nodes: whether anything was appended since it last looked. A cancel reaches the machine
 *    running the turn this way — no address for that machine is needed anywhere.
 *
 * A worker that dies leaves its row held past its TTL. The next `claim` takes such a row like
 * any other: an abandoned session is work, whether or not anything new was appended to it.
 */
import type { AgentRecord } from "operon-agents";

export interface WorkLease {
  readonly sessionId: string;
  /** Monotonic fencing token, bumped on every take of this row. */
  readonly fence: number;
  /** Aborts when the lease is lost or released. Treat it as a cancel. */
  readonly signal: AbortSignal;
  /**
   * Heartbeat. `"woken"`: something was appended since the last renew (or the claim) — read the
   * inbox. `"quiet"`: still held, nothing new. `"lost"`: gone — taken over, or expired — and the
   * signal has been aborted.
   */
  renew(): Promise<"woken" | "quiet" | "lost">;
  /** Give the row back. Idempotent. A wake that arrived meanwhile stays on the row. */
  release(): Promise<void>;
}

export interface SessionWork {
  /** Put `record` in the session's log and the session in line for a worker — one durable step. */
  append(sessionId: string, record: AgentRecord): Promise<void>;
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
