/**
 * Exclusive right to run a session.
 *
 * `Session.withRunLock` serializes runs sharing one `Session` OBJECT. That is the whole
 * guarantee — two requests that each open their own Session for the same id run
 * simultaneously, replay history from before each other's writes, and fork their views. Nothing
 * is lost (both write to the log), but neither run sees the other's turn.
 *
 * This is the seam for the distributed counterpart: a lock keyed by session id rather than by
 * object identity. The framework defines the contract and ships an in-process implementation;
 * where the lease lives in a multi-node deployment (a table, a KV entry, a coordination service)
 * is the host's decision, exactly as the session repository is.
 *
 * ## Losing a lease is not the same as releasing it
 *
 * A holder can lose its lease without knowing: a long GC pause or a clock skew is enough for the
 * TTL to expire while the process is frozen, after which another node legitimately takes over.
 * When the frozen process wakes it still believes it holds the lease. Two defenses, and only the
 * second is a mechanism:
 *
 *  - `signal` aborts when renewal fails, so a well-behaved holder stops on its own. Best-effort:
 *    a process that is frozen or wedged never observes it.
 *  - `fence` is a monotonically increasing token, bumped on every acquire. A backend that can
 *    compare-and-set on write rejects anything carrying a fence lower than the current one — the
 *    stale holder is stopped whether or not it cooperates. Backends that cannot enforce this
 *    (a plain append-only file) still surface the token; enforcement is a property of the store,
 *    not of the lock.
 */

/** Raised when the session is being run elsewhere. Retry after the holder finishes. */
export class SessionBusyError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session "${sessionId}" is currently held by another runner`);
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
  }
}

export interface SessionLease {
  readonly sessionId: string;
  /**
   * Monotonic fencing token for this holder, bumped on every successful acquire. Carry it on
   * writes so a backend that can enforce it rejects a stale holder's writes.
   */
  readonly fence: number;
  /** Aborts when the lease is lost or released — runs should treat it as a cancel. */
  readonly signal: AbortSignal;
  /** Extend the lease. `false` means it is gone (taken over, or expired) — stop working. */
  renew(): Promise<boolean>;
  /** Give it up. Idempotent. */
  release(): Promise<void>;
}

export interface AcquireLeaseOptions {
  /** How long the lease stays valid without renewal. Backend default applies when omitted. */
  readonly ttlMs?: number;
  /** Abort waiting/acquiring. */
  readonly signal?: AbortSignal;
}

export interface SessionLock {
  /**
   * Take the lease for `sessionId`, or return `undefined` when a live one is held elsewhere.
   *
   * Never blocks waiting for the current holder: an agent turn can run for many minutes, so
   * queueing behind it inside a request is the wrong default. Callers decide whether to fail
   * fast, retry, or route the work to whoever holds it.
   */
  acquire(sessionId: string, options?: AcquireLeaseOptions): Promise<SessionLease | undefined>;
  /**
   * Is anyone holding this session right now? (optional)
   *
   * Read-only and advisory: the answer can be stale the instant it returns, so it must never
   * gate correctness — that is `acquire`'s job. It exists for observability, where the useful
   * question is "should something be running, and is it?" A session with unprocessed input and
   * no holder is a session nobody is working on, and a client waiting on its stream deserves to
   * be told that rather than watching an idle connection.
   */
  peek?(sessionId: string): Promise<boolean>;
}

const DEFAULT_TTL_MS = 30_000;

interface MemoryEntry {
  readonly controller: AbortController;
  fence: number;
  expiresAt: number;
}

/**
 * Single-process lock: correct for one node, and the default so that the in-process path has the
 * same shape as the distributed one. It is NOT a substitute for a real lease across processes —
 * two Node processes over the same disk session each get their own instance and both succeed.
 */
export class MemorySessionLock implements SessionLock {
  private readonly held = new Map<string, MemoryEntry>();
  private fences = new Map<string, number>();

  async acquire(sessionId: string, options?: AcquireLeaseOptions): Promise<SessionLease | undefined> {
    const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    const now = Date.now();
    const existing = this.held.get(sessionId);
    // A holder that let its TTL lapse is treated as gone — same rule a distributed backend uses,
    // so takeover behaves identically in tests and in production.
    if (existing !== undefined && existing.expiresAt > now) return undefined;
    if (existing !== undefined) this.lose(sessionId, existing);

    const fence = (this.fences.get(sessionId) ?? 0) + 1;
    this.fences.set(sessionId, fence);
    const controller = new AbortController();
    const entry: MemoryEntry = { controller, fence, expiresAt: now + ttlMs };
    this.held.set(sessionId, entry);

    let surrendered = false;
    /** Give up this holder's claim without touching whoever holds the row now. */
    const surrender = (): void => {
      if (surrendered) return;
      surrendered = true;
      if (this.held.get(sessionId) === entry) this.held.delete(sessionId);
      controller.abort();
    };

    const lease: SessionLease = {
      sessionId,
      fence,
      signal: controller.signal,
      renew: async () => {
        if (surrendered) return false;
        const current = this.held.get(sessionId);
        if (current !== entry) {
          // Superseded while we were not looking. Abort, exactly as the durable implementations
          // do — a lease that cannot be renewed has been taken, and the holder must stop. These
          // two behaving differently would make the in-process path a misleading rehearsal for
          // the distributed one.
          surrender();
          return false;
        }
        entry.expiresAt = Date.now() + ttlMs;
        return true;
      },
      release: async () => surrender(),
    };
    return lease;
  }

  async peek(sessionId: string): Promise<boolean> {
    const entry = this.held.get(sessionId);
    return entry !== undefined && entry.expiresAt > Date.now();
  }

  private lose(sessionId: string, entry: MemoryEntry): void {
    this.held.delete(sessionId);
    entry.controller.abort();
  }
}
