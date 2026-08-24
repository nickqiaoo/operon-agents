/**
 * The work table in process memory: correct for one process, and shaped exactly like the
 * Postgres one so a single-node deployment rehearses the multi-node behaviour — a claim loop
 * finds what `append` woke, a holder's `renew` carries the wake, an expired lease is taken over.
 *
 * Not a substitute across processes: two processes over one disk repository each get their own
 * table, and both would claim the same session.
 */
import type { AgentRecord, SessionRepository } from "operon-agents";
import { ManagedSessionNotFoundError } from "./errors.ts";
import type { SessionWork, WorkLease } from "./work.ts";

const DEFAULT_TTL_MS = 30_000;

interface Row {
  woken: boolean;
  fence: number;
  holder?: { readonly controller: AbortController; readonly fence: number; until: number };
}

export interface MemorySessionWorkOptions {
  readonly repository: SessionRepository;
  readonly ttlMs?: number;
}

export class MemorySessionWork implements SessionWork {
  private readonly repository: SessionRepository;
  private readonly ttlMs: number;
  private readonly rows = new Map<string, Row>();

  constructor(options: MemorySessionWorkOptions) {
    this.repository = options.repository;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async append(sessionId: string, record: AgentRecord): Promise<void> {
    const handle = await this.repository.open(sessionId);
    if (handle === undefined) throw new ManagedSessionNotFoundError(sessionId);
    try {
      await handle.store.appendRecord(record);
    } finally {
      await handle.store.close?.();
    }
    this.row(sessionId).woken = true;
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
      row = { woken: false, fence: 0 };
      this.rows.set(sessionId, row);
    }
    return row;
  }

  private take(sessionId: string, row: Row): WorkLease {
    // A holder that let its TTL lapse is gone — same rule the durable table applies — and learns
    // so at its next renew, exactly as it would there.
    row.holder?.controller.abort();
    row.fence += 1;
    row.woken = false;
    const holder = { controller: new AbortController(), fence: row.fence, until: Date.now() + this.ttlMs };
    row.holder = holder;
    const mine = (): boolean => row.holder === holder;
    return {
      sessionId,
      fence: holder.fence,
      signal: holder.controller.signal,
      renew: async () => {
        if (!mine() || holder.until < Date.now()) {
          holder.controller.abort();
          return "lost";
        }
        holder.until = Date.now() + this.ttlMs;
        const woken = row.woken;
        row.woken = false;
        return woken ? "woken" : "quiet";
      },
      release: async () => {
        holder.controller.abort();
        if (!mine()) return;
        row.holder = undefined;
        if (!row.woken) this.rows.delete(sessionId);
      },
    };
  }
}
