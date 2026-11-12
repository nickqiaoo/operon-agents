/**
 * The work table in process memory: correct for one process, and shaped exactly like the
 * Postgres one so a single-node deployment rehearses the multi-node behaviour — a claim finds
 * what `append` woke, a lapsed lease is taken over, a stale holder's writes are refused.
 *
 * Not a substitute across processes: two processes each get their own table.
 */
import type { ManagedEventResource } from "../protocol/types.ts";
import type { InboxEntry } from "./inbox.ts";
import { isStatusEvent, WorkLeaseLostError, type EventPage, type EventPageOptions, type SessionWork, type WorkLease } from "./work.ts";

const DEFAULT_TTL_MS = 30_000;

interface EventRow {
  readonly sequence: number;
  event: ManagedEventResource;
  /** Present on inputs only. */
  readonly acceptedAt?: number;
}

interface Row {
  woken: boolean;
  fence: number;
  holder?: { readonly controller: AbortController; readonly fence: number; until: number };
  events: EventRow[];
}

export interface MemorySessionWorkOptions {
  readonly ttlMs?: number;
}

export class MemorySessionWork implements SessionWork {
  private readonly ttlMs: number;
  private readonly rows = new Map<string, Row>();
  private sequence = 0;

  constructor(options: MemorySessionWorkOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async append(sessionId: string, entries: readonly InboxEntry[]): Promise<void> {
    const row = this.row(sessionId);
    for (const entry of entries) {
      row.events.push({ sequence: ++this.sequence, event: structuredClone(entry.event), acceptedAt: entry.acceptedAt });
    }
    row.woken = true;
  }

  async wake(sessionId: string): Promise<void> {
    this.row(sessionId).woken = true;
  }

  async pending(sessionId: string): Promise<readonly InboxEntry[]> {
    return (this.rows.get(sessionId)?.events ?? [])
      .filter((row) => row.acceptedAt !== undefined && row.event.processed_at === null)
      .map((row) => structuredClone({ event: row.event, acceptedAt: row.acceptedAt! }) as InboxEntry);
  }

  async acknowledge(sessionId: string, ids: readonly string[], fence: number): Promise<void> {
    const row = this.held(sessionId, fence);
    const done = new Set(ids);
    const now = new Date().toISOString();
    for (const event of row.events) {
      if (event.acceptedAt !== undefined && done.has(event.event.id) && event.event.processed_at === null) {
        event.event = { ...event.event, processed_at: now };
      }
    }
  }

  async recordOutput(sessionId: string, events: readonly ManagedEventResource[], fence: number): Promise<void> {
    const row = this.held(sessionId, fence);
    const known = new Set(row.events.map((event) => event.event.id));
    for (const event of events) {
      if (known.has(event.id)) continue;
      known.add(event.id);
      row.events.push({ sequence: ++this.sequence, event: { ...structuredClone(event), processed_at: new Date().toISOString() } });
    }
  }

  async listEvents(sessionId: string, options: EventPageOptions): Promise<EventPage> {
    const descending = options.order === "desc";
    const after = options.page === undefined ? undefined : Number(options.page);
    const all = [...(this.rows.get(sessionId)?.events ?? [])];
    if (descending) all.reverse();
    const from = after === undefined
      ? all
      : all.filter((row) => (descending ? row.sequence < after : row.sequence > after));
    const page = from.slice(0, options.limit);
    return {
      data: structuredClone(page.map((row) => row.event)),
      ...(from.length > options.limit ? { next: String(page.at(-1)!.sequence) } : {}),
    };
  }

  async latestStatus(sessionId: string): Promise<ManagedEventResource | undefined> {
    const events = this.rows.get(sessionId)?.events ?? [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const row = events[index]!;
      if (row.acceptedAt === undefined && isStatusEvent(row.event)) return structuredClone(row.event);
    }
    return undefined;
  }

  async purge(sessionId: string): Promise<void> {
    this.rows.get(sessionId)?.holder?.controller.abort();
    this.rows.delete(sessionId);
  }

  async claim(): Promise<WorkLease | undefined> {
    const now = Date.now();
    for (const [sessionId, row] of this.rows) {
      const abandoned = row.holder !== undefined && row.holder.until < now;
      const free = row.holder === undefined || abandoned;
      if (free && (row.woken || abandoned)) return this.take(sessionId, row);
    }
    return undefined;
  }

  async acquire(sessionId: string): Promise<WorkLease | undefined> {
    const row = this.row(sessionId);
    if (row.holder !== undefined && row.holder.until > Date.now()) return undefined;
    return this.take(sessionId, row);
  }

  async peek(sessionId: string): Promise<boolean> {
    const holder = this.rows.get(sessionId)?.holder;
    return holder !== undefined && holder.until > Date.now();
  }

  private row(sessionId: string): Row {
    let row = this.rows.get(sessionId);
    if (row === undefined) {
      row = { woken: false, fence: 0, events: [] };
      this.rows.set(sessionId, row);
    }
    return row;
  }

  private held(sessionId: string, fence: number): Row {
    const row = this.rows.get(sessionId);
    if (row?.holder === undefined || row.holder.fence !== fence || row.holder.until <= Date.now()) {
      throw new WorkLeaseLostError(sessionId);
    }
    return row;
  }

  private take(sessionId: string, row: Row): WorkLease {
    // A holder that let its TTL lapse is gone — same rule the durable table applies.
    row.holder?.controller.abort();
    row.fence += 1;
    row.woken = false;
    const holder = { controller: new AbortController(), fence: row.fence, until: Date.now() + this.ttlMs };
    row.holder = holder;
    const mine = (): boolean => this.rows.get(sessionId) === row && row.holder === holder;
    return {
      sessionId,
      fence: holder.fence,
      signal: holder.controller.signal,
      renew: async () => {
        if (!mine() || holder.until < Date.now()) {
          holder.controller.abort();
          return false;
        }
        holder.until = Date.now() + this.ttlMs;
        return true;
      },
      clearWake: async () => {
        if (mine()) row.woken = false;
      },
      release: async () => {
        holder.controller.abort();
        if (mine()) row.holder = undefined;
      },
    };
  }
}
