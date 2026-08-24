/**
 * Managed session metadata in Postgres.
 *
 * The memory and disk stores are single-process by construction: with the memory one a restart
 * loses every session's identity, and with the disk one a second node cannot resolve sessions
 * the first created. Since the default is the memory store, a multi-node deployment that never
 * supplies one appears to work until the first restart — this is the implementation that makes
 * "more than one process" actually hold.
 *
 * The row is a write-ahead identity record: it is claimed before the repository row is created,
 * so a crash in between leaves a resolvable-but-unused id rather than a durable session the
 * managed layer cannot name.
 */
import type { PgExecutor } from "operon-agents";
import type { ManagedSessionMetadata, ManagedSessionMetadataStore } from "./metadata.ts";

export interface PgManagedSessionMetadataStoreOptions {
  readonly pool: PgExecutor;
  readonly table?: string;
}

export function managedSessionMetadataTableDDL(table = "managed_session_metadata"): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  session_id TEXT PRIMARY KEY,
  document   JSONB NOT NULL
);
`;
}

export class PgManagedSessionMetadataStore implements ManagedSessionMetadataStore {
  private readonly pool: PgExecutor;
  private readonly table: string;

  constructor(options: PgManagedSessionMetadataStoreOptions) {
    this.pool = options.pool;
    this.table = options.table ?? "managed_session_metadata";
  }

  async get(sessionId: string): Promise<ManagedSessionMetadata | undefined> {
    const { rows } = await this.pool.query(
      `SELECT document FROM ${this.table} WHERE session_id = $1`,
      [sessionId],
    );
    return rows[0] === undefined ? undefined : parse(rows[0].document);
  }

  async getMany(sessionIds: readonly string[]): Promise<ReadonlyMap<string, ManagedSessionMetadata>> {
    if (sessionIds.length === 0) return new Map();
    // One statement rather than N: listing is the hot read, and a per-row round trip would make
    // its cost scale with page size on top of the catalog query that produced the ids.
    const { rows } = await this.pool.query(
      `SELECT session_id, document FROM ${this.table} WHERE session_id = ANY($1)`,
      [[...sessionIds]],
    );
    const out = new Map<string, ManagedSessionMetadata>();
    for (const row of rows) {
      const parsed = parse(row.document);
      if (parsed !== undefined) out.set(String(row.session_id), parsed);
    }
    return out;
  }

  /** Atomic claim: false means another creator already owns this id. */
  async create(metadata: ManagedSessionMetadata): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.table} (session_id, document) VALUES ($1, $2)
       ON CONFLICT (session_id) DO NOTHING
       RETURNING session_id`,
      [metadata.sessionId, JSON.stringify(metadata)],
    );
    return rows.length > 0;
  }

  async delete(sessionId: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE session_id = $1`, [sessionId]);
  }
}

function parse(document: unknown): ManagedSessionMetadata | undefined {
  // `pg` returns jsonb already parsed; a driver that hands back text is still accepted.
  const value = typeof document === "string" ? safeParse(document) : document;
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Partial<ManagedSessionMetadata>;
  if (typeof record.sessionId !== "string" || record.agent === undefined || record.environment === undefined) {
    return undefined;
  }
  return record as ManagedSessionMetadata;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
