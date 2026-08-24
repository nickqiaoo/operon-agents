/**
 * The work table in Postgres. See `work.ts` for what the table means; this file is the
 * statements.
 *
 * Every operation is ONE statement, and the conditions in their WHERE clauses are the whole
 * mechanism: `claim` and `acquire` only touch a row whose lease is absent or expired, `renew`
 * and `release` only a row this holder still owns at this fence. `FOR UPDATE SKIP LOCKED` is
 * what lets any number of workers claim at once without handing two of them the same session
 * and without making them wait for each other.
 *
 * ## Why a table and not a queue
 *
 * An agent turn runs for minutes, must be exclusive, and can be cancelled from outside while it
 * runs. A queue hands a message to a consumer; it has no notion of "the consumer is still on
 * it" or "tell that consumer something". The lease does both: it IS the claim, and its heartbeat
 * is the channel back to the holder. Postgres already holds the log, so this costs no second
 * system and no second source of truth — the wake and the record it announces are one commit.
 */
import type { AgentRecord, PgExecutor, PgSessionRepository } from "operon-agents";
import type { SessionWork, WorkLease } from "./work.ts";

const DEFAULT_TTL_MS = 30_000;

export interface PgSessionWorkOptions {
  readonly pool: PgExecutor;
  /** The repository the log lives in — `append` joins its write and the wake in one transaction. */
  readonly repository: PgSessionRepository;
  /** Identifies this holder in the table. Use something a restart changes — a pod name plus a
   *  boot id — so a restarted node does not look like its old self. */
  readonly ownerId: string;
  readonly table?: string;
  readonly ttlMs?: number;
}

/** DDL for the work table. Idempotent; run it once per deployment, before any worker starts. */
export function sessionWorkTableDDL(table = "session_work"): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  session_id  TEXT PRIMARY KEY,
  woken       BOOLEAN NOT NULL DEFAULT false,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  fence       BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS woken BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ${table} DROP COLUMN IF EXISTS pending_since;
-- Partial: only rows a claim could take are indexed, so a claim costs a range read over the
-- backlog and the sessions currently running — never over every session that ever existed.
CREATE INDEX IF NOT EXISTS ${table}_claim_idx
  ON ${table} (lease_until)
  WHERE woken OR lease_owner IS NOT NULL;
`;
}

export class PgSessionWork implements SessionWork {
  private readonly pool: PgExecutor;
  private readonly repository: PgSessionRepository;
  private readonly ownerId: string;
  private readonly table: string;
  private readonly ttlMs: number;

  constructor(options: PgSessionWorkOptions) {
    this.pool = options.pool;
    this.repository = options.repository;
    this.ownerId = options.ownerId;
    this.table = options.table ?? "session_work";
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async append(sessionId: string, record: AgentRecord): Promise<void> {
    await this.repository.transaction(async (tx) => {
      await tx.store(sessionId).appendRecord(record);
      await tx.exec.query(
        `INSERT INTO ${this.table} (session_id, woken) VALUES ($1, true)
         ON CONFLICT (session_id) DO UPDATE SET woken = true`,
        [sessionId],
      );
    });
  }

  async claim(): Promise<WorkLease | undefined> {
    // Woken and unheld, or held past its TTL by a holder that never released: both are work.
    // The subquery picks one such row and locks it; `SKIP LOCKED` steps over rows another
    // claim is taking at this moment instead of waiting for it.
    const { rows } = await this.pool.query(
      `UPDATE ${this.table}
          SET lease_owner = $1, lease_until = now() + make_interval(secs => $2),
              fence = fence + 1, woken = false
        WHERE session_id = (
          SELECT session_id FROM ${this.table}
           WHERE (woken OR lease_owner IS NOT NULL)
             AND (lease_until IS NULL OR lease_until < now())
           ORDER BY lease_until NULLS FIRST
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING session_id, fence`,
      [this.ownerId, this.ttlMs / 1000],
    );
    const row = rows[0];
    return row === undefined ? undefined : this.lease(String(row.session_id), Number(row.fence));
  }

  async acquire(sessionId: string): Promise<WorkLease | undefined> {
    // Insert the row if absent, take it if free or expired. The WHERE on the DO UPDATE is the
    // compare-and-set: a live lease held elsewhere leaves the row untouched and returns nothing.
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.table} (session_id, lease_owner, lease_until, fence, woken)
       VALUES ($1, $2, now() + make_interval(secs => $3), 1, false)
       ON CONFLICT (session_id) DO UPDATE
         SET lease_owner = EXCLUDED.lease_owner,
             lease_until = EXCLUDED.lease_until,
             fence = ${this.table}.fence + 1,
             woken = false
         WHERE ${this.table}.lease_until IS NULL OR ${this.table}.lease_until < now()
       RETURNING fence`,
      [sessionId, this.ownerId, this.ttlMs / 1000],
    );
    const fence = rows[0]?.fence;
    return fence === undefined ? undefined : this.lease(sessionId, Number(fence));
  }

  async peek(sessionId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM ${this.table} WHERE session_id = $1 AND lease_until IS NOT NULL AND lease_until > now()`,
      [sessionId],
    );
    return rows.length > 0;
  }

  private lease(sessionId: string, fence: number): WorkLease {
    const controller = new AbortController();
    let gone = false;
    const lose = (): void => {
      if (gone) return;
      gone = true;
      controller.abort();
    };
    return {
      sessionId,
      fence,
      signal: controller.signal,
      renew: async () => {
        if (gone) return "lost";
        // Owner AND fence: a node that reclaimed and released this row must not let the old
        // holder extend a lease that has moved on. The self-join locks the row first and reads
        // `woken` before clearing it, so a wake committed at this very moment either shows up
        // here or lands after our clear — never under it.
        const { rows } = await this.pool.query(
          `UPDATE ${this.table} AS w
              SET lease_until = now() + make_interval(secs => $3), woken = false
             FROM (SELECT session_id, woken FROM ${this.table} WHERE session_id = $1 FOR UPDATE) AS before
            WHERE w.session_id = before.session_id AND w.lease_owner = $2 AND w.fence = $4
            RETURNING before.woken AS woken`,
          [sessionId, this.ownerId, this.ttlMs / 1000, fence],
        );
        const row = rows[0];
        if (row === undefined) {
          lose();
          return "lost";
        }
        return row.woken === true ? "woken" : "quiet";
      },
      release: async () => {
        if (gone) return;
        lose();
        // Only our own hold, at our fence: if the row moved on, it is someone else's now.
        // `woken` is left alone — a wake that arrived since our last look is the next claim's.
        await this.pool.query(
          `UPDATE ${this.table} SET lease_owner = NULL, lease_until = NULL
            WHERE session_id = $1 AND lease_owner = $2 AND fence = $3`,
          [sessionId, this.ownerId, fence],
        );
      },
    };
  }
}
