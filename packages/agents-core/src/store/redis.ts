import { createHash } from "node:crypto";
import { LogSessionStore, type StoredLogLine } from "./log-store.ts";
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
import type { SessionStore } from "./store.ts";
import { encodeWorkdirKey, normalizeWorkDir } from "./workdir-key.ts";

/**
 * Redis backing for {@link SessionStorage}. You inject a constructed `ioredis` client (the driver
 * is never imported here, so core stays dependency-free); the client is shared across every
 * session. Per session: a LIST per address for the log, a SET of addresses, and a HASH for state.
 * Blobs are content-addressed STRINGs under a global `blob:` namespace, so a fork shares them (no
 * copy). The catalog is a ZSET of session ids (scored by updatedAt) plus a per-workdir index SET.
 * The log is flat and linear (one append-only record stream per address); {@link LogSessionStore}
 * reduces it to conversation state on read.
 *
 *   import Redis from "ioredis";
 *   const storage = redisStorage({ client: new Redis(process.env.REDIS_URL), ownsClient: true });
 */

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function assertSafeSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id "${id}" — only [A-Za-z0-9_-] allowed`);
}

/** The slice of an `ioredis` client this backing uses — a real client satisfies it structurally. */
export interface RedisClient {
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, ...args: (string | Record<string, string>)[]): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  pipeline?(): {
    hgetall(key: string): unknown;
    exec(): Promise<Array<readonly [Error | null, unknown]>>;
  };
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: string | Buffer): Promise<unknown>;
  exists(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  quit?(): Promise<unknown>;
}

export interface RedisStorageOptions {
  /** A constructed `ioredis` client (or compatible). Shared by all sessions. */
  readonly client: RedisClient;
  /** Namespace for every key this backing writes. Default `"agents"`. */
  readonly keyPrefix?: string;
  /** When true, `storage.close()` quits the client. Default false (you constructed it; you close it). */
  readonly ownsClient?: boolean;
}

const DEFAULT_PREFIX = "agents";
// Atomic whole-log replace: clear the list, then re-push every line, in one round trip.
const REWRITE_LUA = "redis.call('del', KEYS[1]); for i=1,#ARGV do redis.call('rpush', KEYS[1], ARGV[i]) end; return 1";
// One atomic step for appendLine: push the line AND register the address (so the addrs set can
// never miss a shard that has log lines), then — only if the session's meta exists — advance
// updated_at + the catalog ZSET score so list() ordering ("most recently active") stays honest.
// KEYS: log, addrs, meta, sessions, sequence   ARGV: line, address, nowMs, id
const APPEND_LUA =
  "local seq=redis.call('incr', KEYS[5]); local stored=tostring(seq)..'|'..ARGV[1]; " +
  "redis.call('rpush', KEYS[1], stored); redis.call('sadd', KEYS[2], ARGV[2]); " +
  "if redis.call('exists', KEYS[3]) == 1 then redis.call('hset', KEYS[3], 'updated_at', ARGV[3]); redis.call('zadd', KEYS[4], ARGV[3], ARGV[4]); end; return tostring(seq)";

const PUT_INTERRUPT_LUA =
  "redis.call('hset',KEYS[1],ARGV[1],ARGV[2]); if redis.call('exists',KEYS[2])==1 then " +
  "redis.call('hset',KEYS[2],'durable_state','interrupted','updated_at',ARGV[3]); " +
  "redis.call('zadd',KEYS[3],ARGV[3],ARGV[4]); end; return 1";

const DELETE_INTERRUPT_LUA =
  "redis.call('hdel',KEYS[1],ARGV[1]); if redis.call('exists',KEYS[2])==1 then " +
  "redis.call('hset',KEYS[2],'durable_state','idle','updated_at',ARGV[2]); " +
  "redis.call('zadd',KEYS[3],ARGV[2],ARGV[3]); end; return 1";

/** Tree session store for one session over a shared client. Tree/migration/blobs live in LogSessionStore. */
export class RedisSessionStore extends LogSessionStore {
  private readonly client: RedisClient;
  private readonly p: string;
  private readonly id: string;

  constructor(client: RedisClient, prefix: string, id: string) {
    super();
    this.client = client;
    this.p = prefix;
    this.id = id;
  }

  private logKey(address: string): string {
    return `${this.p}:s:${this.id}:log:${address}`;
  }
  private get addrsKey(): string {
    return `${this.p}:s:${this.id}:addrs`;
  }
  private get stateKey(): string {
    return `${this.p}:s:${this.id}:state`;
  }
  private get sequenceKey(): string {
    return `${this.p}:s:${this.id}:sequence`;
  }
  // Mirrors RedisSessionRepository's key layout — the store advances the session's activity
  // stamp (see APPEND_LUA), which lives in the repository's meta hash + catalog ZSET.
  private get metaKey(): string {
    return `${this.p}:s:${this.id}:meta`;
  }
  private get sessionsKey(): string {
    return `${this.p}:sessions`;
  }
  private blobKey(sha: string): string {
    return `${this.p}:blob:${sha}`;
  }

  protected async appendLine(address: string, line: string): Promise<string> {
    const sequence = await this.client.eval(
      APPEND_LUA,
      5,
      this.logKey(address),
      this.addrsKey,
      this.metaKey,
      this.sessionsKey,
      this.sequenceKey,
      line,
      address,
      String(Date.now()),
      this.id,
    );
    return normalizeRedisSequence(String(sequence));
  }

  protected async *readLines(address: string): AsyncIterable<StoredLogLine> {
    for (const raw of await this.client.lrange(this.logKey(address), 0, -1)) {
      const separator = raw.indexOf("|");
      const rawSequence = separator < 0 ? "" : raw.slice(0, separator);
      let sequence: string;
      try {
        sequence = normalizeRedisSequence(rawSequence);
      } catch {
        throw new Error(`invalid stored Redis log entry for session "${this.id}"`);
      }
      yield { sequence, line: raw.slice(separator + 1) };
    }
  }

  protected async rewriteLines(address: string, lines: readonly StoredLogLine[]): Promise<void> {
    await this.client.eval(REWRITE_LUA, 1, this.logKey(address), ...lines.map((line) => `${line.sequence}|${line.line}`));
  }

  protected async listShardAddresses(): Promise<readonly string[]> {
    return this.client.smembers(this.addrsKey);
  }

  async getState(key: string): Promise<unknown | null> {
    const raw = await this.client.hget(this.stateKey, key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  }

  async putState(key: string, value: unknown): Promise<void> {
    if (key === "interrupt") {
      await this.client.eval(
        PUT_INTERRUPT_LUA,
        3,
        this.stateKey,
        this.metaKey,
        this.sessionsKey,
        key,
        JSON.stringify(value ?? null),
        String(Date.now()),
        this.id,
      );
      return;
    }
    await this.client.hset(this.stateKey, key, JSON.stringify(value ?? null));
  }

  async deleteState(key: string): Promise<void> {
    if (key === "interrupt") {
      await this.client.eval(
        DELETE_INTERRUPT_LUA,
        3,
        this.stateKey,
        this.metaKey,
        this.sessionsKey,
        key,
        String(Date.now()),
        this.id,
      );
      return;
    }
    await this.client.hdel(this.stateKey, key);
  }

  async listStateKeys(): Promise<readonly string[]> {
    // hgetall (not HKEYS) so the RedisClient slice stays unchanged; state hashes are small.
    return Object.keys(await this.client.hgetall(this.stateKey));
  }

  protected async readBlobBytes(sha: string): Promise<Buffer | undefined> {
    return (await this.client.getBuffer(this.blobKey(sha))) ?? undefined;
  }

  protected async writeBlobBytes(sha: string, bytes: Buffer): Promise<void> {
    await this.client.set(this.blobKey(sha), bytes);
  }
}

export class RedisSessionRepository implements SessionRepository {
  private readonly client: RedisClient;
  private readonly p: string;
  private readonly ownsClient: boolean;

  constructor(client: RedisClient, prefix: string = DEFAULT_PREFIX, ownsClient = false) {
    this.client = client;
    this.p = prefix;
    this.ownsClient = ownsClient;
  }

  private metaKey(id: string): string {
    return `${this.p}:s:${id}:meta`;
  }
  private get sessionsKey(): string {
    return `${this.p}:sessions`;
  }
  private wdKey(workDir: string): string {
    return `${this.p}:wd:${encodeWorkdirKey(workDir)}`;
  }
  /** Owner index. Hashed, not embedded: ownerKey is opaque to us and may contain ':'. */
  private okKey(ownerKey: string): string {
    return `${this.p}:ok:${createHash("sha256").update(ownerKey).digest("hex").slice(0, 32)}`;
  }
  private addrsKey(id: string): string {
    return `${this.p}:s:${id}:addrs`;
  }
  private logKey(id: string, address: string): string {
    return `${this.p}:s:${id}:log:${address}`;
  }
  private stateKey(id: string): string {
    return `${this.p}:s:${id}:state`;
  }
  private sequenceKey(id: string): string {
    return `${this.p}:s:${id}:sequence`;
  }
  private storeFor(id: string): SessionStore {
    const raw = new RedisSessionStore(this.client, this.p, id);
    const observer: SessionCatalogObserver = {
      // APPEND_LUA and interruption state scripts already advance metadata atomically.
      activity: async (updatedAt, source) => {
        if (source === "log" || (await this.client.exists(this.metaKey(id))) === 0) return;
        await this.client.hset(this.metaKey(id), "updated_at", String(updatedAt));
        await this.client.zadd(this.sessionsKey, updatedAt, id);
      },
      durableState: () => undefined,
      metadata: async (value, updatedAt) => {
        const title = sessionMetaTitle(value);
        if ((await this.client.exists(this.metaKey(id))) === 0) return;
        await this.client.hset(
          this.metaKey(id),
          ...(title !== undefined ? ["title", title ?? ""] : []),
          "updated_at",
          String(updatedAt),
        );
        await this.client.zadd(this.sessionsKey, updatedAt, id);
      },
    };
    return new CatalogSessionStore(raw, observer);
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    await this.client.hset(this.metaKey(meta.id), {
      id: meta.id,
      work_dir: meta.workDir,
      owner_key: meta.ownerKey ?? "",
      deleted_at: meta.deletedAt !== undefined ? String(meta.deletedAt) : "",
      title: meta.title ?? "",
      created_at: String(meta.createdAt),
      updated_at: String(meta.updatedAt),
      durable_state: meta.durableState ?? "idle",
    });
    await this.client.zadd(this.sessionsKey, meta.updatedAt, meta.id);
    await this.client.sadd(this.wdKey(meta.workDir), meta.id);
    if (meta.ownerKey !== undefined) await this.client.sadd(this.okKey(meta.ownerKey), meta.id);
  }

  private summarize(m: Record<string, string>): SessionSummary {
    return {
      id: m.id!,
      workDir: m.work_dir!,
      ownerKey: m.owner_key ? m.owner_key : undefined,
      deletedAt: m.deleted_at ? Number(m.deleted_at) : undefined,
      title: m.title ? m.title : undefined,
      createdAt: Number(m.created_at),
      updatedAt: Number(m.updated_at),
      durableState: parseDurableState(m.durable_state),
    };
  }

  // Known limitation (create/fork): the commands below are not wrapped in a MULTI/transaction,
  // so a mid-sequence failure can leave a partial session (meta without state; a fork with a
  // partly copied log). writeMeta runs first and gates existence, so a partial is inert (open()
  // still resolves) rather than corrupt; recovery is delete-then-recreate. The per-append work
  // (log line + addrs + activity stamp) IS atomic — see APPEND_LUA. Acceptable for a secondary backend.
  async create(input: CreateSessionInput): Promise<SessionHandle> {
    const id = input.id ?? generateSessionId();
    assertSafeSessionId(id);
    if ((await this.client.exists(this.metaKey(id))) > 0) throw new SessionRepositoryConflictError(id);
    const workDir = normalizeWorkDir(input.workDir);
    const now = Date.now();
    const meta: SessionMeta = { id, workDir, ownerKey: input.ownerKey, title: input.title, createdAt: now, updatedAt: now };
    await this.writeMeta(meta);
    const store = this.storeFor(id);
    await store.putState("meta", meta);
    return { id, workDir, createdAt: now, store };
  }

  async open(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined> {
    const m = await this.client.hgetall(this.metaKey(id));
    if (m.id === undefined) return undefined;
    if (m.deleted_at && options?.includeDeleted !== true) return undefined;
    return { id, workDir: m.work_dir!, createdAt: Number(m.created_at), store: this.storeFor(id) };
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    const metadata = await this.client.hgetall(this.metaKey(id));
    return metadata.id === undefined ? undefined : this.summarize(metadata);
  }

  async list(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]> {
    const wanted = filter?.workDir !== undefined ? normalizeWorkDir(filter.workDir) : undefined;
    // Each filter narrows through its own index set; with none, fall back to the recency zset.
    const indexed: string[][] = [];
    if (wanted !== undefined) indexed.push(await this.client.smembers(this.wdKey(wanted)));
    if (filter?.ownerKey !== undefined) indexed.push(await this.client.smembers(this.okKey(filter.ownerKey)));
    const ids = indexed.length === 0
      ? await this.client.zrevrange(this.sessionsKey, 0, -1)
      : indexed.reduce((left, right) => {
          const keep = new Set(right);
          return left.filter((id) => keep.has(id));
        });
    if (ids.length === 0) return [];
    const pipeline = this.client.pipeline?.();
    let rows: SessionSummary[];
    if (pipeline !== undefined) {
      for (const id of ids) pipeline.hgetall(this.metaKey(id));
      const results = await pipeline.exec();
      rows = results.flatMap(([error, value]) => {
        const meta = !error && typeof value === "object" && value !== null
          ? value as Record<string, string>
          : undefined;
        return meta?.id === undefined ? [] : [this.summarize(meta)];
      });
    } else {
      // Minimal compatible clients may not expose pipeline; keep correctness as the fallback.
      rows = (await Promise.all(ids.map((id) => this.client.hgetall(this.metaKey(id)))))
        .filter((meta) => meta.id !== undefined)
        .map((meta) => this.summarize(meta));
    }
    return rows
      .filter((row) => filter?.includeDeleted === true || row.deletedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  }

  async fork(sourceId: string, input?: ForkSessionInput): Promise<SessionHandle> {
    const src = await this.client.hgetall(this.metaKey(sourceId));
    if (src.id === undefined || src.deleted_at) throw new SessionRepositoryNotFoundError(sourceId);
    const workDir = src.work_dir!;
    const id = input?.id ?? generateSessionId();
    assertSafeSessionId(id);
    if ((await this.client.exists(this.metaKey(id))) > 0) throw new SessionRepositoryConflictError(id);
    const now = Date.now();
    // Copy each address's log + the state hash; blobs are global (content-addressed), so shared.
    for (const address of await this.client.smembers(this.addrsKey(sourceId))) {
      const lines = await this.client.lrange(this.logKey(sourceId, address), 0, -1);
      if (lines.length > 0) await this.client.rpush(this.logKey(id, address), ...lines);
      await this.client.sadd(this.addrsKey(id), address);
    }
    const srcState = await this.client.hgetall(this.stateKey(sourceId));
    for (const [field, value] of Object.entries(srcState)) await this.client.hset(this.stateKey(id), field, value);
    const sourceSequence = await this.client.getBuffer(this.sequenceKey(sourceId));
    if (sourceSequence !== null) await this.client.set(this.sequenceKey(id), sourceSequence);
    const title = input?.title ?? (src.title ? src.title : undefined);
    const meta: SessionMeta = {
      id,
      workDir,
      ownerKey: input?.ownerKey ?? (src.owner_key ? src.owner_key : undefined),
      title,
      createdAt: now,
      updatedAt: now,
      durableState: parseDurableState(src.durable_state),
    };
    await this.writeMeta(meta);
    const store = this.storeFor(id);
    await store.putState("meta", meta);
    return { id, workDir, createdAt: now, store };
  }

  async delete(id: string, options?: DeleteSessionOptions): Promise<void> {
    if (options?.purge !== true) {
      if ((await this.client.exists(this.metaKey(id))) === 0) return;
      const deletedAt = Date.now();
      await this.client.hset(this.metaKey(id), "deleted_at", String(deletedAt), "updated_at", String(deletedAt));
      await this.client.zadd(this.sessionsKey, deletedAt, id);
      return;
    }
    const m = await this.client.hgetall(this.metaKey(id));
    const addrs = await this.client.smembers(this.addrsKey(id));
    const keys = [this.stateKey(id), this.sequenceKey(id), this.addrsKey(id), this.metaKey(id), ...addrs.map((a) => this.logKey(id, a))];
    await this.client.del(...keys);
    await this.client.zrem(this.sessionsKey, id);
    if (m.work_dir !== undefined) await this.client.srem(this.wdKey(m.work_dir), id);
    if (m.owner_key) await this.client.srem(this.okKey(m.owner_key), id);
    // Blobs are content-addressed and possibly shared across sessions; left in place (no GC).
  }

  async restore(id: string): Promise<void> {
    if ((await this.client.exists(this.metaKey(id))) === 0) return;
    const now = Date.now();
    await this.client.hset(this.metaKey(id), "deleted_at", "", "updated_at", String(now));
    await this.client.zadd(this.sessionsKey, now, id);
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.quit?.();
  }
}

/** Redis-backed {@link SessionStorage}. Inject an `ioredis` client; no schema setup is needed. */
export function redisStorage(options: RedisStorageOptions): SessionStorage {
  return storageOver(new RedisSessionRepository(options.client, options.keyPrefix ?? DEFAULT_PREFIX, options.ownsClient ?? false));
}

/** ioredis-mock's embedded Lua renders integer numbers as `1.0`; Redis itself renders `1`.
 *  Normalize both without weakening the public integer sequence contract. */
function normalizeRedisSequence(value: string): string {
  const normalized = value.replace(/\.0$/, "");
  if (!/^[1-9]\d*$/.test(normalized)) throw new Error(`invalid Redis sequence "${value}"`);
  return normalized;
}

function parseDurableState(value: unknown): DurableSessionState {
  return value === "interrupted" ? "interrupted" : "idle";
}

function sessionMetaTitle(value: unknown): string | null | undefined {
  if (typeof value !== "object" || value === null || !("title" in value)) return undefined;
  const title = (value as { readonly title?: unknown }).title;
  return typeof title === "string" ? title : title === undefined ? null : undefined;
}
