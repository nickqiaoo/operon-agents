import { LogSessionStore, type ReadLinesPageOptions, type StoredLogLine } from "./log-store.ts";
import { CatalogSessionStore, type DurableSessionState, type SessionCatalogObserver } from "./catalog-store.ts";
import {
  type CreateSessionInput,
  type ForkSessionInput,
  generateSessionId,
  type ListSessionsFilter,
  type OpenSessionOptions,
  type DeleteSessionOptions,
  type SessionHandle,
  type SessionMeta,
  type SessionRepository,
  SessionRepositoryConflictError,
  SessionRepositoryNotFoundError,
  type SessionSummary,
} from "./repository.ts";
import { storageOver, type SessionStorage } from "./storage.ts";
import type { SessionStore, StateKey } from "./store.ts";
import { normalizeWorkDir } from "./workdir-key.ts";

/**
 * Postgres backing for {@link SessionStorage}. You inject a constructed `pg.Pool` (the driver is
 * never imported here, so core stays dependency-free); the pool is shared across every session.
 * Logs/state/blobs/catalog live in four tables; blobs are content-addressed and global, so a fork
 * shares them (no copy). Log lines are stored as `text` (not jsonb) on purpose — jsonb rejects
 * `NUL`, which can appear in tool output. The log is flat and linear (one append-only record
 * stream per address); {@link LogSessionStore} reduces it to conversation state on read.
 *
 *   import { Pool } from "pg";
 *   const storage = pgStorage({ pool: new Pool({ connectionString: process.env.DATABASE_URL }), ownsPool: true });
 */

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function assertSafeSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id "${id}" — only [A-Za-z0-9_-] allowed`);
}

/** The slice of `pg.Pool` this backing uses — a real `pg.Pool` satisfies it structurally. */
/** Anything that can run a statement — the pool itself, or a connection pinned to a transaction. */
export interface PgExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A connection pinned out of the pool, so BEGIN/COMMIT apply to the statements in between. */
export interface PgClient extends PgExecutor {
  release(): void;
}

export interface PgPool extends PgExecutor {
  /**
   * Pin a connection. `pg.Pool` provides exactly this; a minimal duck-typed pool may not, and
   * multi-statement writes then fall back to running unwrapped (see {@link PgSessionRepository}).
   */
  connect?(): Promise<PgClient>;
  end?(): Promise<void>;
}

export interface PgStorageOptions {
  /** A constructed `pg.Pool` (or compatible). Shared by all sessions. */
  readonly pool: PgPool;
  /** When true, `storage.close()` ends the pool. Default false (you constructed it; you close it). */
  readonly ownsPool?: boolean;
}

// Separate statements (not one multi-statement string) — a single `create ... if not exists` per call works everywhere.
const SCHEMA_STATEMENTS = [
  `create table if not exists session_log (
     session_id text   not null,
     address    text   not null,
     seq        bigint generated always as identity,
     line       text   not null,
     primary key (seq)
   )`,
  `create index if not exists session_log_sess_addr_seq on session_log (session_id, address, seq)`,
  `create table if not exists session_state (
     session_id text  not null,
     key        text  not null,
     value      jsonb,
     primary key (session_id, key)
   )`,
  `create table if not exists session_blob (
     sha   text  primary key,
     bytes bytea not null
   )`,
  `create table if not exists session_meta (
     id         text   primary key,
     work_dir   text   not null,
     owner_key  text,
     deleted_at bigint,
     title      text,
     created_at bigint not null,
     updated_at bigint not null
   )`,
  `create index if not exists session_meta_workdir on session_meta (work_dir)`,
  // Ordered to match list()'s `order by updated_at desc, id desc`, so an owner-filtered
  // listing is an index scan rather than a filter + sort over the whole fleet.
  `create index if not exists session_meta_owner on session_meta (owner_key, updated_at desc, id desc)`,
  // Soft-deleted rows are retained for audit, so every listing filters them out; a partial
  // index keeps that predicate from touching them at all.
  `create index if not exists session_meta_live on session_meta (updated_at desc, id desc) where deleted_at is null`,
  `create index if not exists session_meta_recency on session_meta (updated_at desc, id desc)`,
];

/** Tree session store for one session over a shared pool. Tree/migration/blobs live in LogSessionStore. */
export class PgSessionStore extends LogSessionStore {
  private readonly pool: PgExecutor;
  private readonly id: string;

  constructor(pool: PgExecutor, id: string) {
    super();
    this.pool = pool;
    this.id = id;
  }

  protected async appendLine(address: string, line: string): Promise<string> {
    const { rows } = await this.pool.query(
      `insert into session_log(session_id, address, line) values($1, $2, $3) returning seq`,
      [this.id, address, line],
    );
    // Advance the activity stamp so list() ("most recently active" first) is honest — stamped
    // once at create otherwise. No-op (0 rows) when meta doesn't exist (a store used standalone).
    await this.pool.query(`update session_meta set updated_at = $2 where id = $1`, [this.id, Date.now()]);
    return String(rows[0]!.seq);
  }

  protected async *readLines(address: string): AsyncIterable<StoredLogLine> {
    const { rows } = await this.pool.query(
      `select seq, line from session_log where session_id=$1 and address=$2 order by seq`,
      [this.id, address],
    );
    for (const row of rows) yield { sequence: String(row.seq), line: row.line as string };
  }

  /** A range read on `session_log_sess_addr_seq`: the page, and nothing before or after it. */
  protected async readLinesPage(address: string, options: ReadLinesPageOptions): Promise<readonly StoredLogLine[]> {
    const beyond = options.order === "asc" ? ">" : "<";
    const { rows } = await this.pool.query(
      `select seq, line from session_log
        where session_id=$1 and address=$2${options.after !== undefined ? ` and seq ${beyond} $4` : ""}
        order by seq ${options.order} limit $3`,
      [this.id, address, options.limit, ...(options.after !== undefined ? [options.after] : [])],
    );
    return rows.map((row) => ({ sequence: String(row.seq), line: row.line as string }));
  }

  protected async rewriteLines(address: string, lines: readonly StoredLogLine[]): Promise<void> {
    // Rewrites update the existing physical rows and remove migration-dropped rows. Their
    // store-assigned sequence is never regenerated, so already-issued cursors stay valid.
    for (const entry of lines) {
      await this.pool.query(
        `update session_log set line=$4 where session_id=$1 and address=$2 and seq=$3`,
        [this.id, address, entry.sequence, entry.line],
      );
    }
    await this.pool.query(
      `delete from session_log where session_id=$1 and address=$2 and not (seq = any($3::bigint[]))`,
      [this.id, address, lines.map((entry) => entry.sequence)],
    );
  }

  protected async listShardAddresses(): Promise<readonly string[]> {
    const { rows } = await this.pool.query(`select distinct address from session_log where session_id=$1`, [this.id]);
    return rows.map((r) => r.address as string);
  }

  async getState(key: StateKey): Promise<unknown | null> {
    const { rows } = await this.pool.query(`select value from session_state where session_id=$1 and key=$2`, [this.id, key]);
    return rows.length > 0 ? (rows[0]!.value ?? null) : null;
  }

  async putState(key: StateKey, value: unknown): Promise<void> {
    await this.pool.query(
      `insert into session_state(session_id, key, value) values($1, $2, $3::jsonb)
       on conflict (session_id, key) do update set value = excluded.value`,
      [this.id, key, JSON.stringify(value ?? null)],
    );
  }

  async deleteState(key: StateKey): Promise<void> {
    await this.pool.query(`delete from session_state where session_id=$1 and key=$2`, [this.id, key]);
  }

  async listStateKeys(): Promise<readonly StateKey[]> {
    const { rows } = await this.pool.query(`select key from session_state where session_id=$1`, [this.id]);
    return rows.map((r) => r.key as string);
  }

  protected async readBlobBytes(sha: string): Promise<Buffer | undefined> {
    const { rows } = await this.pool.query(`select bytes from session_blob where sha=$1`, [sha]);
    // `bytea` comes back as a Buffer from node-pg but a Uint8Array from some drivers; normalize.
    return rows.length > 0 ? Buffer.from(rows[0]!.bytes as Uint8Array) : undefined;
  }

  protected async writeBlobBytes(sha: string, bytes: Buffer): Promise<void> {
    await this.pool.query(`insert into session_blob(sha, bytes) values($1, $2) on conflict (sha) do nothing`, [sha, bytes]);
  }
}

/** One transaction in progress. Statements on `exec` and writes through `store(id)` share it. */
export interface PgTransaction {
  readonly exec: PgExecutor;
  store(id: string): SessionStore;
}

export class PgSessionRepository implements SessionRepository {
  private readonly pool: PgPool;
  private readonly ownsPool: boolean;
  private schemaReady?: Promise<void>;

  constructor(pool: PgPool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  /** Create the tables on first use (idempotent); memoized so it runs once per repository. */
  private ready(): Promise<void> {
    return (this.schemaReady ??= (async () => {
      for (const stmt of SCHEMA_STATEMENTS) await this.pool.query(stmt);
    })());
  }

  /**
   * Run `fn` inside BEGIN/COMMIT on a pinned connection, rolling back on any throw.
   *
   * Falls back to running unwrapped when the injected pool exposes no `connect()` — a minimal
   * duck-typed pool still works, it just keeps the old non-atomic behaviour. That is the one
   * place this class degrades, and it degrades loudly only in the sense that the caller chose
   * the pool: `pg.Pool` has `connect`, so a real deployment always gets the transaction.
   */
  private async inTransaction<T>(fn: (exec: PgExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect?.();
    if (client === undefined) return fn(this.pool);
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run `fn` as one transaction: everything it does through `tx` commits together or not at all.
   *
   * This is how a host makes a session write and a write of its own atomic — a record appended
   * to the log and a row in the host's own table, with no moment in between where one exists
   * without the other. Same fallback as the repository's own multi-statement operations: a pool
   * with no `connect()` runs `fn` unwrapped.
   */
  async transaction<T>(fn: (tx: PgTransaction) => Promise<T>): Promise<T> {
    await this.ready();
    return this.inTransaction((exec) => fn({ exec, store: (id) => this.storeFor(id, exec) }));
  }

  private storeFor(id: string, exec: PgExecutor = this.pool): SessionStore {
    const raw = new PgSessionStore(exec, id);
    const patch = async (values: { readonly durableState?: DurableSessionState; readonly updatedAt: number }): Promise<void> => {
      await exec.query(
        values.durableState === undefined
          ? `update session_meta set updated_at=$2 where id=$1`
          : `update session_meta set durable_state=$2, updated_at=$3 where id=$1`,
        values.durableState === undefined
          ? [id, values.updatedAt]
          : [id, values.durableState, values.updatedAt],
      );
    };
    const observer: SessionCatalogObserver = {
      // appendLine and interruption state transitions already advance metadata atomically.
      activity: (updatedAt, source) => source === "state" ? patch({ updatedAt }) : undefined,
      durableState: (_durableState, updatedAt) => patch({ updatedAt }),
      metadata: async (value, updatedAt) => {
        const title = sessionMetaTitle(value);
        if (title === undefined) return patch({ updatedAt });
        await exec.query(`update session_meta set title=$2, updated_at=$3 where id=$1`, [id, title, updatedAt]);
      },
    };
    return new CatalogSessionStore(raw, observer);
  }

  // create/fork/purge are multi-statement, so they run inside BEGIN/COMMIT on a pinned connection
  // (`inTransaction`). With a pool that exposes no `connect()` they degrade to the old unwrapped
  // behaviour: a mid-sequence failure can leave a partial session (meta row without the meta state;
  // a fork with a partly copied log). The meta row is inserted first and gates existence, so even
  // then a partial is inert (open() still resolves) rather than corrupt, and recovery is
  // delete-then-recreate. Inject a real `pg.Pool` and none of that applies.
  async create(input: CreateSessionInput): Promise<SessionHandle> {
    await this.ready();
    const id = input.id ?? generateSessionId();
    assertSafeSessionId(id);
    const workDir = normalizeWorkDir(input.workDir);
    const now = Date.now();
    await this.inTransaction(async (exec) => {
      const { rows } = await exec.query(
        `insert into session_meta(id, work_dir, owner_key, title, created_at, updated_at) values($1, $2, $3, $4, $5, $5)
         on conflict (id) do nothing returning id`,
        [id, workDir, input.ownerKey ?? null, input.title ?? null, now],
      );
      // Rolls the (empty) transaction back and propagates — the id was already taken.
      if (rows.length === 0) throw new SessionRepositoryConflictError(id);
      await this.storeFor(id, exec).putState(
        "meta",
        { id, workDir, ownerKey: input.ownerKey, title: input.title, createdAt: now, updatedAt: now } satisfies SessionMeta,
      );
    });
    return { id, workDir, createdAt: now, store: this.storeFor(id) };
  }

  async open(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined> {
    await this.ready();
    const { rows } = await this.pool.query(
      options?.includeDeleted === true
        ? `select work_dir, created_at from session_meta where id=$1`
        : `select work_dir, created_at from session_meta where id=$1 and deleted_at is null`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return { id, workDir: rows[0]!.work_dir as string, createdAt: Number(rows[0]!.created_at), store: this.storeFor(id) };
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    await this.ready();
    const { rows } = await this.pool.query(
      `select m.id, m.work_dir, m.owner_key, m.deleted_at, m.title, m.created_at, m.updated_at,
              case when s.session_id is null then 'idle' else 'interrupted' end as durable_state
         from session_meta m left join session_state s on s.session_id=m.id and s.key='interrupt'
        where m.id=$1`,
      [id],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id as string,
          workDir: row.work_dir as string,
          ownerKey: (row.owner_key as string | null) ?? undefined,
          deletedAt: row.deleted_at === null || row.deleted_at === undefined ? undefined : Number(row.deleted_at),
          title: (row.title as string | null) ?? undefined,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          durableState: parseDurableState(row.durable_state),
        };
  }

  async list(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]> {
    await this.ready();
    const wanted = filter?.workDir !== undefined ? normalizeWorkDir(filter.workDir) : undefined;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (wanted !== undefined) {
      params.push(wanted);
      conditions.push(`m.work_dir=$${params.length}`);
    }
    if (filter?.ownerKey !== undefined) {
      params.push(filter.ownerKey);
      conditions.push(`m.owner_key=$${params.length}`);
    }
    if (filter?.includeDeleted !== true) conditions.push("m.deleted_at is null");
    const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")} `;
    const { rows } = await this.pool.query(
      `select m.id, m.work_dir, m.owner_key, m.deleted_at, m.title, m.created_at, m.updated_at,
              case when s.session_id is null then 'idle' else 'interrupted' end as durable_state
         from session_meta m left join session_state s on s.session_id=m.id and s.key='interrupt'
        ${where}order by m.updated_at desc, m.id desc`,
      params,
    );
    return rows.map((r) => ({
      id: r.id as string,
      workDir: r.work_dir as string,
      ownerKey: (r.owner_key as string | null) ?? undefined,
      deletedAt: r.deleted_at === null || r.deleted_at === undefined ? undefined : Number(r.deleted_at),
      title: (r.title as string | null) ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      durableState: parseDurableState(r.durable_state),
    }));
  }

  async fork(sourceId: string, input?: ForkSessionInput): Promise<SessionHandle> {
    await this.ready();
    const src = await this.pool.query(
      `select m.work_dir, m.owner_key, m.title,
              case when s.session_id is null then 'idle' else 'interrupted' end as durable_state
         from session_meta m left join session_state s on s.session_id=m.id and s.key='interrupt'
        where m.id=$1 and m.deleted_at is null`,
      [sourceId],
    );
    if (src.rows.length === 0) throw new SessionRepositoryNotFoundError(sourceId);
    const workDir = src.rows[0]!.work_dir as string;
    const ownerKey = input?.ownerKey ?? ((src.rows[0]!.owner_key as string | null) ?? undefined);
    const id = input?.id ?? generateSessionId();
    assertSafeSessionId(id);
    const now = Date.now();
    const title = input?.title ?? ((src.rows[0]!.title as string | null) ?? undefined);
    const durableState = parseDurableState(src.rows[0]!.durable_state);
    await this.inTransaction(async (exec) => {
      const ins = await exec.query(
        `insert into session_meta(id, work_dir, owner_key, title, created_at, updated_at) values($1, $2, $3, $4, $5, $5)
         on conflict (id) do nothing returning id`,
        [id, workDir, ownerKey ?? null, title ?? null, now],
      );
      if (ins.rows.length === 0) throw new SessionRepositoryConflictError(id);
      // Copy log + state into the new id; blobs are content-addressed + global, so they're shared.
      await exec.query(
        `insert into session_log(session_id, address, line) select $1, address, line from session_log where session_id=$2 order by seq`,
        [id, sourceId],
      );
      await exec.query(
        `insert into session_state(session_id, key, value) select $1, key, value from session_state where session_id=$2`,
        [id, sourceId],
      );
      await this.storeFor(id, exec).putState(
        "meta",
        { id, workDir, ownerKey, title, createdAt: now, updatedAt: now, durableState } satisfies SessionMeta,
      );
    });
    return { id, workDir, createdAt: now, store: this.storeFor(id) };
  }

  async delete(id: string, options?: DeleteSessionOptions): Promise<void> {
    await this.ready();
    if (options?.purge !== true) {
      await this.pool.query(
        `update session_meta set deleted_at=$2, updated_at=$2 where id=$1 and deleted_at is null`,
        [id, Date.now()],
      );
      return;
    }
    await this.inTransaction(async (exec) => {
      await exec.query(`delete from session_log where session_id=$1`, [id]);
      await exec.query(`delete from session_state where session_id=$1`, [id]);
      await exec.query(`delete from session_meta where id=$1`, [id]);
    });
    // Blobs are content-addressed and possibly shared across sessions; left in place (no GC).
  }

  async restore(id: string): Promise<void> {
    await this.ready();
    await this.pool.query(
      `update session_meta set deleted_at=null, updated_at=$2 where id=$1 and deleted_at is not null`,
      [id, Date.now()],
    );
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }
}

/** Postgres-backed {@link SessionStorage}. Inject a `pg.Pool`; tables are created on first use. */
export function pgStorage(options: PgStorageOptions): SessionStorage {
  return storageOver(new PgSessionRepository(options.pool, options.ownsPool ?? false));
}

function parseDurableState(value: unknown): DurableSessionState {
  return value === "interrupted" ? "interrupted" : "idle";
}

function sessionMetaTitle(value: unknown): string | null | undefined {
  if (typeof value !== "object" || value === null || !("title" in value)) return undefined;
  const title = (value as { readonly title?: unknown }).title;
  return typeof title === "string" ? title : title === undefined ? null : undefined;
}
