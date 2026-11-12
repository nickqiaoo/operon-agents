/**
 * The work table in Postgres. See `work.ts` for what the table means; this file is the
 * statements.
 *
 * Every operation is ONE statement, and the conditions in their WHERE clauses are the whole
 * mechanism: `claim` and `acquire` only touch a row whose lease is absent or expired; fenced
 * writes only land while this holder still owns the row at this fence. `FOR UPDATE SKIP LOCKED`
 * is what lets any number of workers claim at once without handing two of them the same
 * session and without making them wait for each other.
 *
 * The history lives next to the lease (`<table>_events`), not in the framework's journal: what
 * a client sent and what it is shown are the managed layer's records, in its own vocabulary.
 */
import type { PgExecutor } from "operon-agents/advanced";
import type { ManagedEventResource } from "../protocol/types.ts";
import type { InboxEntry } from "./inbox.ts";
import { WorkLeaseLostError, type EventPage, type EventPageOptions, type SessionWork, type WorkLease } from "./work.ts";

const DEFAULT_TTL_MS = 30_000;

export interface PgSessionWorkOptions {
  readonly pool: PgExecutor;
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
CREATE TABLE IF NOT EXISTS ${table}_events (
  sequence     BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  input        BOOLEAN NOT NULL,
  payload      JSONB NOT NULL,
  accepted_at  TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  UNIQUE (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS ${table}_events_session_idx ON ${table}_events (session_id, sequence);
CREATE INDEX IF NOT EXISTS ${table}_events_pending_idx
  ON ${table}_events (session_id, sequence)
  WHERE input AND processed_at IS NULL;
`;
}

export class PgSessionWork implements SessionWork {
  private readonly pool: PgExecutor;
  private readonly ownerId: string;
  private readonly table: string;
  private readonly events: string;
  private readonly ttlMs: number;

  constructor(options: PgSessionWorkOptions) {
    this.pool = options.pool;
    this.ownerId = options.ownerId;
    this.table = options.table ?? "session_work";
    this.events = `${this.table}_events`;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async append(sessionId: string, entries: readonly InboxEntry[]): Promise<void> {
    // One statement: the events and the wake commit together, so no claim can see the wake
    // without the events or the events without the wake.
    await this.pool.query(
      `WITH wake AS (
         INSERT INTO ${this.table} (session_id, woken) VALUES ($1, true)
         ON CONFLICT (session_id) DO UPDATE SET woken = true
         RETURNING session_id)
       INSERT INTO ${this.events} (session_id, event_id, input, payload, accepted_at)
       SELECT wake.session_id, entry->>'id', true, entry - 'processed_at' - 'accepted_at',
              to_timestamp((entry->>'accepted_at')::double precision / 1000)
         FROM wake CROSS JOIN jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(entry, n)
        ORDER BY n`,
      [sessionId, JSON.stringify(entries.map((entry) => ({ ...entry.event, accepted_at: entry.acceptedAt })))],
    );
  }

  async wake(sessionId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table} (session_id, woken) VALUES ($1, true)
       ON CONFLICT (session_id) DO UPDATE SET woken = true`,
      [sessionId],
    );
  }

  async pending(sessionId: string): Promise<readonly InboxEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT payload, accepted_at FROM ${this.events}
        WHERE session_id = $1 AND input AND processed_at IS NULL
        ORDER BY sequence`,
      [sessionId],
    );
    return rows.map((row) => {
      const { accepted_at: _, ...event } = json(row.payload);
      return {
        event: { ...event, processed_at: null } as InboxEntry["event"],
        acceptedAt: new Date(row.accepted_at as string).getTime(),
      };
    });
  }

  async acknowledge(sessionId: string, ids: readonly string[], fence: number): Promise<void> {
    const { rows } = await this.pool.query(
      `WITH holder AS (${this.holderQuery()}),
            done AS (
              UPDATE ${this.events} SET processed_at = now()
               WHERE session_id IN (SELECT session_id FROM holder)
                 AND event_id = ANY($4::text[]) AND input AND processed_at IS NULL)
       SELECT session_id FROM holder`,
      [sessionId, this.ownerId, fence, [...ids]],
    );
    if (rows.length === 0) throw new WorkLeaseLostError(sessionId);
  }

  async recordOutput(sessionId: string, events: readonly ManagedEventResource[], fence: number): Promise<void> {
    if (events.length === 0) return;
    const { rows } = await this.pool.query(
      `WITH holder AS (${this.holderQuery()}),
            saved AS (
              INSERT INTO ${this.events} (session_id, event_id, input, payload, processed_at)
              SELECT holder.session_id, e->>'id', false, e - 'processed_at', now()
                FROM holder CROSS JOIN jsonb_array_elements($4::jsonb) WITH ORDINALITY AS t(e, n)
               ORDER BY n
              ON CONFLICT (session_id, event_id) DO NOTHING)
       SELECT session_id FROM holder`,
      [sessionId, this.ownerId, fence, JSON.stringify(events)],
    );
    if (rows.length === 0) throw new WorkLeaseLostError(sessionId);
  }

  async listEvents(sessionId: string, options: EventPageOptions): Promise<EventPage> {
    const descending = options.order === "desc";
    const params: unknown[] = [sessionId, options.limit + 1];
    let bound = "";
    if (options.page !== undefined) {
      params.push(options.page);
      bound = `AND sequence ${descending ? "<" : ">"} $3::bigint`;
    }
    const { rows } = await this.pool.query(
      `SELECT sequence, payload, accepted_at, processed_at FROM ${this.events}
        WHERE session_id = $1 ${bound}
        ORDER BY sequence ${descending ? "DESC" : "ASC"}
        LIMIT $2`,
      params,
    );
    const page = rows.slice(0, options.limit);
    return {
      data: page.map((row) => toResource(row)),
      ...(rows.length > options.limit ? { next: String(page.at(-1)!.sequence) } : {}),
    };
  }

  async latestStatus(sessionId: string): Promise<ManagedEventResource | undefined> {
    const { rows } = await this.pool.query(
      `SELECT payload, accepted_at, processed_at FROM ${this.events}
        WHERE session_id = $1 AND NOT input AND payload->>'type' LIKE 'session.status\\_%'
        ORDER BY sequence DESC LIMIT 1`,
      [sessionId],
    );
    return rows[0] === undefined ? undefined : toResource(rows[0]);
  }

  async purge(sessionId: string): Promise<void> {
    await this.pool.query(
      `WITH gone AS (DELETE FROM ${this.events} WHERE session_id = $1)
       DELETE FROM ${this.table} WHERE session_id = $1`,
      [sessionId],
    );
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

  /** `$1` session, `$2` owner, `$3` fence: the row, locked, only while this holder has it. */
  private holderQuery(): string {
    return `SELECT session_id FROM ${this.table}
             WHERE session_id = $1 AND lease_owner = $2 AND fence = $3 AND lease_until > now()
             FOR UPDATE`;
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
        if (gone) return false;
        // Owner AND fence: a node that reclaimed and released this row must not let the old
        // holder extend a lease that has moved on.
        const { rows } = await this.pool.query(
          `UPDATE ${this.table} SET lease_until = now() + make_interval(secs => $3)
            WHERE session_id = $1 AND lease_owner = $2 AND fence = $4 AND lease_until > now()
            RETURNING 1`,
          [sessionId, this.ownerId, this.ttlMs / 1000, fence],
        );
        if (rows.length === 0) {
          lose();
          return false;
        }
        return true;
      },
      clearWake: async () => {
        if (gone) return;
        // Its own statement, committed before the caller's next `pending` read starts: an
        // append that commits after this either shows up in that read or wakes the row again.
        await this.pool.query(
          `UPDATE ${this.table} SET woken = false WHERE session_id = $1 AND lease_owner = $2 AND fence = $3`,
          [sessionId, this.ownerId, fence],
        );
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

function json(value: unknown): Record<string, unknown> {
  return (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
}

function toResource(row: Record<string, unknown>): ManagedEventResource {
  const { accepted_at: _, ...event } = json(row.payload);
  return {
    ...event,
    processed_at: row.processed_at ? new Date(row.processed_at as string).toISOString() : null,
  } as ManagedEventResource;
}
