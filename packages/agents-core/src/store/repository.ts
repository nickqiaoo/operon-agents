import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { CatalogSessionStore, type DurableSessionState, type SessionCatalogObserver } from "./catalog-store.ts";
import { DiskSessionStore } from "./disk-store.ts";
import { MemoryStore } from "./log-store.ts";
import {
  appendSessionCatalogRecord,
  readSessionCatalog,
  type DiskSessionCatalogEntry,
  type DiskSessionCatalogRecord,
} from "./session-catalog.ts";
import type { SessionStore } from "./store.ts";
import { encodeWorkdirKey, normalizeWorkDir } from "./workdir-key.ts";

export interface SessionMeta {
  readonly id: string;
  readonly workDir: string;
  /** {@link CreateSessionInput.ownerKey} as stamped at create/fork time. */
  readonly ownerKey?: string;
  /** Set when the session was soft-deleted; the durable record is retained. */
  readonly deletedAt?: number;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly durableState?: DurableSessionState;
}

export interface SessionSummary {
  readonly id: string;
  readonly workDir: string;
  /** {@link CreateSessionInput.ownerKey}; absent for sessions created without one. */
  readonly ownerKey?: string;
  /** When this session was soft-deleted, if it was. See {@link SessionRepository.delete}. */
  readonly deletedAt?: number;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Durable control state only. Live `running` belongs to the open HarnessSession. */
  readonly durableState: DurableSessionState;
}

export interface SessionHandle {
  readonly id: string;
  readonly workDir: string;
  readonly createdAt: number;
  readonly store: SessionStore;
}

export interface CreateSessionInput {
  readonly id?: string;
  readonly workDir: string;
  /**
   * Opaque partition key: which owner (tenant / account / workspace) a session belongs to.
   * The framework never interprets it — it stores it and filters `list()` by it, exactly as
   * `workDir` partitions a local deployment by project directory. A server serving many users
   * passes one key per user, so `list()` structurally cannot return another user's sessions.
   *
   * NOT access control: `open()`/`get()` still resolve any id regardless of key. Enforcing who
   * may touch a session stays with the host (see the managed server's `authorize` hook).
   */
  readonly ownerKey?: string;
  readonly title?: string;
}

export interface ForkSessionInput {
  readonly id?: string;
  /** Defaults to the source session's key, so a fork stays in its owner's partition. */
  readonly ownerKey?: string;
  readonly title?: string;
}

export interface ListSessionsFilter {
  readonly workDir?: string;
  /** Return only sessions stamped with this {@link CreateSessionInput.ownerKey}. */
  readonly ownerKey?: string;
  /** Include soft-deleted sessions. Default false — enumeration hides them. */
  readonly includeDeleted?: boolean;
}

export interface OpenSessionOptions {
  /**
   * Open a soft-deleted session anyway. Default false: opening is what makes a session
   * RUNNABLE, and a deleted session must not accept new work. Audit and purge tooling that
   * needs to read the log passes true.
   */
  readonly includeDeleted?: boolean;
}

export interface DeleteSessionOptions {
  /**
   * Destroy the durable record instead of marking it deleted. Irreversible, and the only
   * way to reclaim the storage. Retention policy is the caller's; the repository just obeys.
   */
  readonly purge?: boolean;
}

/**
 * Soft delete, in three rules that hold for every implementation:
 *
 *   `list()`  HIDES a deleted session   — enumeration should not surface it.
 *   `get()`   RETURNS it, `deletedAt` set — a point lookup asked for this exact id; hiding
 *                                           it would lose the fact that it once existed.
 *   `open()`  REFUSES it                 — opening is what makes a session runnable, and a
 *                                           deleted session must never accept new work.
 *
 * `delete()` marks; `delete(id, { purge: true })` destroys. Nothing expires on its own —
 * retention is a policy the host runs, not something the repository decides.
 */
export interface SessionRepository {
  create(input: CreateSessionInput): Promise<SessionHandle>;
  open(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined>;
  /** Read one catalog row without scanning the full session list or opening a runtime. */
  get(id: string): Promise<SessionSummary | undefined>;
  list(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]>;
  fork(sourceId: string, input?: ForkSessionInput): Promise<SessionHandle>;
  delete(id: string, options?: DeleteSessionOptions): Promise<void>;
  /** Clear a soft delete. No-op when the session is absent or was never deleted. */
  restore(id: string): Promise<void>;
}

export class SessionRepositoryNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session "${sessionId}" not found`);
    this.name = "SessionRepositoryNotFoundError";
    this.sessionId = sessionId;
  }
}

export class SessionRepositoryConflictError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`session "${sessionId}" already exists`);
    this.name = "SessionRepositoryConflictError";
    this.sessionId = sessionId;
  }
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
let idCounter = 0;

export function generateSessionId(): string {
  idCounter += 1;
  return `s${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function assertSafeSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`invalid session id "${id}" — only [A-Za-z0-9_-] allowed`);
  }
}

// Repository-owned stores maintain this summary after successful log/KV writes.
function summaryFromMeta(meta: SessionMeta): SessionSummary {
  return {
    id: meta.id,
    workDir: meta.workDir,
    ownerKey: meta.ownerKey,
    deletedAt: meta.deletedAt,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    durableState: meta.durableState ?? "idle",
  };
}

export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, { handle: SessionHandle; meta: SessionMeta }>();

  async create(input: CreateSessionInput): Promise<SessionHandle> {
    const id = input.id ?? generateSessionId();
    assertSafeSessionId(id);
    if (this.sessions.has(id)) throw new SessionRepositoryConflictError(id);
    const now = Date.now();
    const workDir = normalizeWorkDir(input.workDir);
    const meta: SessionMeta = { id, workDir, ownerKey: input.ownerKey, title: input.title, createdAt: now, updatedAt: now, durableState: "idle" };
    const raw = new MemoryStore();
    await raw.putState("meta", meta);
    const store = new CatalogSessionStore(raw, this.memoryObserver(id));
    const handle: SessionHandle = { id, workDir, createdAt: now, store };
    this.sessions.set(id, { handle, meta });
    return handle;
  }

  async open(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined> {
    const entry = this.sessions.get(id);
    if (entry === undefined) return undefined;
    if (entry.meta.deletedAt !== undefined && options?.includeDeleted !== true) return undefined;
    return entry.handle;
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    const entry = this.sessions.get(id);
    return entry === undefined ? undefined : summaryFromMeta(entry.meta);
  }

  async list(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]> {
    const wanted = filter?.workDir !== undefined ? normalizeWorkDir(filter.workDir) : undefined;
    const owner = filter?.ownerKey;
    const deleted = filter?.includeDeleted === true;
    return [...this.sessions.values()]
      .filter(({ meta }) =>
        (wanted === undefined || meta.workDir === wanted)
        && (owner === undefined || meta.ownerKey === owner)
        && (deleted || meta.deletedAt === undefined))
      .map(({ meta }) => summaryFromMeta(meta))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async fork(sourceId: string, input?: ForkSessionInput): Promise<SessionHandle> {
    const source = this.sessions.get(sourceId);
    // A deleted session is not a valid fork source — the copy would outlive the delete.
    if (source === undefined || source.meta.deletedAt !== undefined) throw new SessionRepositoryNotFoundError(sourceId);
    const forked = await this.create({
      id: input?.id,
      workDir: source.meta.workDir,
      ownerKey: input?.ownerKey ?? source.meta.ownerKey,
      title: input?.title ?? source.meta.title,
    });
    const target = forked.store;
    // Copy each address's log in append order (NOT the time-merged no-filter stream) so each
    // shard's linear record sequence is reconstructed exactly, not interleaved across shards.
    const addresses = new Set<string>();
    for await (const record of source.handle.store.readRecords()) addresses.add(record.address ?? "main");
    for (const address of addresses) {
      for await (const record of source.handle.store.readRecords({ address })) await target.appendRecord(record);
    }
    // The log copy above carries everything reduce-derived (subagents, workflows, plan mode);
    // KV is copied in FULL — bg:* task ledgers, goal, tasklist:hwm etc. live only in KV, so an
    // enumerated-handles subset would fork a session missing them (Disk cp's the whole dir and
    // Pg/Redis copy all state rows; Memory must match). The fallback list covers only stores
    // that predate listStateKeys.
    const keys = (await source.handle.store.listStateKeys?.()) ?? ["interrupt", "cron"];
    for (const key of keys) {
      if (key === "meta") continue; // create() above stamped the fork's own meta
      const value = await source.handle.store.getState(key);
      if (value !== null) await target.putState(key, value);
    }
    return forked;
  }

  async delete(id: string, options?: DeleteSessionOptions): Promise<void> {
    if (options?.purge === true) {
      this.sessions.delete(id);
      return;
    }
    const entry = this.sessions.get(id);
    if (entry === undefined || entry.meta.deletedAt !== undefined) return;
    const deletedAt = Date.now();
    entry.meta = { ...entry.meta, deletedAt, updatedAt: deletedAt };
    await entry.handle.store.putState("meta", entry.meta);
  }

  async restore(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry === undefined || entry.meta.deletedAt === undefined) return;
    const { deletedAt: _dropped, ...rest } = entry.meta;
    entry.meta = { ...rest, updatedAt: Date.now() };
    await entry.handle.store.putState("meta", entry.meta);
  }

  private memoryObserver(id: string): SessionCatalogObserver {
    const patch = (values: Partial<SessionMeta>): void => {
      const current = this.sessions.get(id);
      if (current === undefined) return;
      current.meta = { ...current.meta, ...values };
    };
    return {
      activity: (at) => patch({ updatedAt: at }),
      durableState: (durableState, at) => patch({ durableState, updatedAt: at }),
      metadata: (value, at) => {
        const meta = asSessionMeta(value);
        patch({ ...(meta?.title !== undefined ? { title: meta.title } : {}), updatedAt: at });
      },
    };
  }
}

export class DiskSessionRepository implements SessionRepository {
  private readonly sessionsDir: string;
  private catalog?: Promise<Map<string, DiskSessionCatalogEntry>>;
  private reconciled?: Promise<void>;
  private catalogWrite: Promise<void> = Promise.resolve();
  private readonly pendingActivity = new Map<string, number>();
  private activityTimer?: ReturnType<typeof setTimeout>;

  constructor(homeDir: string) {
    this.sessionsDir = join(homeDir, "sessions");
  }

  private sessionDirFor(id: string, workDir: string): string {
    return join(this.sessionsDir, encodeWorkdirKey(workDir), id);
  }

  async create(input: CreateSessionInput): Promise<SessionHandle> {
    await this.ensureReconciled();
    const id = input.id ?? generateSessionId();
    assertSafeSessionId(id);
    const workDir = normalizeWorkDir(input.workDir);
    const dir = this.sessionDirFor(id, workDir);
    if ((await this.ensureCatalog()).has(id) || await pathExists(dir)) throw new SessionRepositoryConflictError(id);

    await mkdir(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const raw = new DiskSessionStore(dir);
    await raw.putState("meta", { id, workDir, ownerKey: input.ownerKey, title: input.title, createdAt: now, updatedAt: now, durableState: "idle" } satisfies SessionMeta);
    const entry: DiskSessionCatalogEntry = {
      sessionId: id,
      sessionDir: dir,
      workDir,
      ...(input.ownerKey !== undefined ? { ownerKey: input.ownerKey } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: now,
      updatedAt: now,
      durableState: "idle",
    };
    await this.writeCatalog({ op: "upsert", entry });
    const store = this.diskStore(id, raw);
    return { id, workDir, createdAt: now, store };
  }

  async open(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined> {
    await this.ensureReconciled();
    const entry = (await this.ensureCatalog()).get(id);
    if (entry === undefined) return undefined;
    if (entry.deletedAt !== undefined && options?.includeDeleted !== true) return undefined;
    return { id, workDir: entry.workDir, createdAt: entry.createdAt, store: this.diskStore(id, new DiskSessionStore(entry.sessionDir)) };
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    await this.ensureReconciled();
    await this.flushActivity();
    const entry = (await this.ensureCatalog()).get(id);
    return entry === undefined ? undefined : summaryFromCatalog(entry);
  }

  async list(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]> {
    await this.ensureReconciled();
    await this.flushActivity();
    const wanted = filter?.workDir !== undefined ? normalizeWorkDir(filter.workDir) : undefined;
    const owner = filter?.ownerKey;
    const deleted = filter?.includeDeleted === true;
    return [...(await this.ensureCatalog()).values()]
      .filter((entry) =>
        (wanted === undefined || entry.workDir === wanted)
        && (owner === undefined || entry.ownerKey === owner)
        && (deleted || entry.deletedAt === undefined))
      .map(summaryFromCatalog)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  }

  async fork(sourceId: string, input?: ForkSessionInput): Promise<SessionHandle> {
    await this.ensureReconciled();
    const source = (await this.ensureCatalog()).get(sourceId);
    if (source === undefined || source.deletedAt !== undefined) throw new SessionRepositoryNotFoundError(sourceId);

    const id = input?.id ?? generateSessionId();
    assertSafeSessionId(id);
    const dir = this.sessionDirFor(id, source.workDir);
    if ((await this.ensureCatalog()).has(id) || await pathExists(dir)) throw new SessionRepositoryConflictError(id);

    // Recursive copy captures every shard + the full KV — including keys we don't enumerate.
    await mkdir(join(this.sessionsDir, encodeWorkdirKey(source.workDir)), { recursive: true, mode: 0o700 });
    await cp(source.sessionDir, dir, { recursive: true });

    const now = Date.now();
    const raw = new DiskSessionStore(dir);
    const sourceMeta = asSessionMeta(await raw.getState("meta"));
    const title = input?.title ?? sourceMeta?.title;
    const ownerKey = input?.ownerKey ?? source.ownerKey ?? sourceMeta?.ownerKey;
    await raw.putState("meta", {
      id,
      workDir: source.workDir,
      ownerKey,
      title,
      createdAt: now,
      updatedAt: now,
      durableState: source.durableState,
    } satisfies SessionMeta);
    await this.writeCatalog({
      op: "upsert",
      entry: {
        sessionId: id,
        sessionDir: dir,
        workDir: source.workDir,
        ...(ownerKey !== undefined ? { ownerKey } : {}),
        ...(title !== undefined ? { title } : {}),
        createdAt: now,
        updatedAt: now,
        durableState: source.durableState,
      },
    });
    const store = this.diskStore(id, raw);
    return { id, workDir: source.workDir, createdAt: now, store };
  }

  async delete(id: string, options?: DeleteSessionOptions): Promise<void> {
    await this.ensureReconciled();
    const entry = (await this.ensureCatalog()).get(id);
    if (entry === undefined) return;
    if (options?.purge === true) {
      await rm(entry.sessionDir, { recursive: true, force: true });
      await this.writeCatalog({ op: "delete", sessionId: id });
      return;
    }
    if (entry.deletedAt !== undefined) return;
    const deletedAt = Date.now();
    // The session directory is authoritative on reconcile, so the mark goes into `meta` too —
    // a catalog rebuilt from disk must not resurrect a deleted session as live.
    await this.markDiskMeta(entry, { deletedAt });
    await this.writeCatalog({ op: "upsert", entry: { ...entry, deletedAt, updatedAt: deletedAt } });
  }

  async restore(id: string): Promise<void> {
    await this.ensureReconciled();
    const entry = (await this.ensureCatalog()).get(id);
    if (entry === undefined || entry.deletedAt === undefined) return;
    await this.markDiskMeta(entry, {});
    const { deletedAt: _dropped, ...rest } = entry;
    await this.writeCatalog({ op: "upsert", entry: { ...rest, updatedAt: Date.now() } });
  }

  /** Rewrite the session's own `meta` state with (or without) the delete mark. */
  private async markDiskMeta(entry: DiskSessionCatalogEntry, patch: { readonly deletedAt?: number }): Promise<void> {
    const raw = new DiskSessionStore(entry.sessionDir);
    const meta = asSessionMeta(await raw.getState("meta"));
    if (meta === undefined) return;
    const { deletedAt: _dropped, ...rest } = meta;
    await raw.putState("meta", {
      ...rest,
      ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt } : {}),
    } satisfies SessionMeta);
  }

  private diskStore(id: string, raw: DiskSessionStore): SessionStore {
    return new CatalogSessionStore(raw, {
      activity: (at) => this.scheduleActivity(id, at),
      durableState: (durableState, at) => this.patchDiskCatalog(id, { durableState, updatedAt: at }),
      metadata: (value, at) => {
        const meta = asSessionMeta(value);
        return this.patchDiskCatalog(id, {
          ...(meta?.title !== undefined ? { title: meta.title } : {}),
          updatedAt: at,
        });
      },
      flush: async () => {
        await this.flushActivity();
        await this.catalogWrite;
      },
    });
  }

  /** One startup pass repairs catalog drift after a process died between state and summary writes. */
  private ensureCatalog(): Promise<Map<string, DiskSessionCatalogEntry>> {
    return (this.catalog ??= readSessionCatalog(this.sessionsDir));
  }

  private ensureReconciled(): Promise<void> {
    return (this.reconciled ??= this.reconcileCatalog());
  }

  private async reconcileCatalog(): Promise<void> {
    const catalog = await this.ensureCatalog();
    for (const [id, entry] of [...catalog]) {
      if (!(await pathExists(entry.sessionDir))) {
        await this.writeCatalogRecord({ op: "delete", sessionId: id }, catalog);
        continue;
      }
      const store = new DiskSessionStore(entry.sessionDir);
      const [meta, interruption, activity] = await Promise.all([
        store.getState("meta").then(asSessionMeta),
        store.getState("interrupt"),
        store.lastActivityMs(),
      ]);
      const { deletedAt: _entryDeleted, ...entryRest } = entry;
      const repaired: DiskSessionCatalogEntry = {
        ...entryRest,
        ...(meta?.deletedAt !== undefined ? { deletedAt: meta.deletedAt } : {}),
        ...(meta?.ownerKey !== undefined ? { ownerKey: meta.ownerKey } : {}),
        ...(meta?.title !== undefined ? { title: meta.title } : {}),
        createdAt: meta?.createdAt ?? entry.createdAt,
        updatedAt: Math.max(entry.updatedAt, meta?.updatedAt ?? 0, activity),
        durableState: interruption === null ? "idle" : "interrupted",
      };
      if (JSON.stringify(repaired) !== JSON.stringify(entry)) {
        await this.writeCatalogRecord({ op: "upsert", entry: repaired }, catalog);
      }
    }
    // The directory + state are authoritative. Recover a session whose process died after
    // creating its directory but before appending the derived catalog upsert.
    for (const sessionDir of await discoverSessionDirs(this.sessionsDir)) {
      const id = basename(sessionDir);
      if (catalog.has(id)) continue;
      const store = new DiskSessionStore(sessionDir);
      const [meta, interruption, activity] = await Promise.all([
        store.getState("meta").then(asSessionMeta),
        store.getState("interrupt"),
        store.lastActivityMs(),
      ]);
      if (meta === undefined || meta.id !== id) continue;
      await this.writeCatalogRecord({
        op: "upsert",
        entry: {
          sessionId: id,
          sessionDir,
          workDir: normalizeWorkDir(meta.workDir),
          ...(meta.deletedAt !== undefined ? { deletedAt: meta.deletedAt } : {}),
          ...(meta.ownerKey !== undefined ? { ownerKey: meta.ownerKey } : {}),
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          createdAt: meta.createdAt,
          updatedAt: Math.max(meta.updatedAt, activity),
          durableState: interruption === null ? "idle" : "interrupted",
        },
      }, catalog);
    }
  }

  private async patchDiskCatalog(
    id: string,
    patch: { readonly title?: string | null; readonly updatedAt?: number; readonly durableState?: DurableSessionState },
  ): Promise<void> {
    const catalog = await this.ensureCatalog();
    if (!catalog.has(id)) return;
    await this.writeCatalogRecord({ op: "patch", sessionId: id, ...patch }, catalog);
  }

  /** Activity is high-frequency and lossy-safe; coalesce it while state transitions stay immediate. */
  private scheduleActivity(id: string, at: number): void {
    this.pendingActivity.set(id, Math.max(this.pendingActivity.get(id) ?? 0, at));
    if (this.activityTimer !== undefined) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = undefined;
      void this.flushActivity().catch(() => undefined);
    }, 100);
    this.activityTimer.unref?.();
  }

  private async flushActivity(): Promise<void> {
    if (this.activityTimer !== undefined) {
      clearTimeout(this.activityTimer);
      this.activityTimer = undefined;
    }
    const pending = [...this.pendingActivity];
    this.pendingActivity.clear();
    for (const [id, updatedAt] of pending) await this.patchDiskCatalog(id, { updatedAt });
  }

  private async writeCatalog(record: DiskSessionCatalogRecord): Promise<void> {
    await this.writeCatalogRecord(record, await this.ensureCatalog());
  }

  private async writeCatalogRecord(
    record: DiskSessionCatalogRecord,
    catalog: Map<string, DiskSessionCatalogEntry>,
  ): Promise<void> {
    const run = this.catalogWrite.then(async () => {
      await appendSessionCatalogRecord(this.sessionsDir, record);
      applyCatalogRecord(catalog, record);
    });
    this.catalogWrite = run.then(() => undefined, () => undefined);
    await run;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function summaryFromCatalog(entry: DiskSessionCatalogEntry): SessionSummary {
  return {
    id: entry.sessionId,
    workDir: entry.workDir,
    ...(entry.ownerKey !== undefined ? { ownerKey: entry.ownerKey } : {}),
    ...(entry.deletedAt !== undefined ? { deletedAt: entry.deletedAt } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    durableState: entry.durableState,
  };
}

function applyCatalogRecord(
  catalog: Map<string, DiskSessionCatalogEntry>,
  record: DiskSessionCatalogRecord,
): void {
  if (record.op === "delete") {
    catalog.delete(record.sessionId);
    return;
  }
  if (record.op === "upsert") {
    catalog.set(record.entry.sessionId, record.entry);
    return;
  }
  const current = catalog.get(record.sessionId);
  if (current === undefined) return;
  catalog.set(record.sessionId, {
    ...current,
    ...(record.title !== undefined ? { title: record.title ?? undefined } : {}),
    ...(record.updatedAt !== undefined ? { updatedAt: Math.max(current.updatedAt, record.updatedAt) } : {}),
    ...(record.durableState !== undefined ? { durableState: record.durableState } : {}),
  });
}

function asSessionMeta(value: unknown): SessionMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const meta = value as Partial<SessionMeta>;
  return typeof meta.id === "string"
    && typeof meta.workDir === "string"
    && typeof meta.createdAt === "number"
    && typeof meta.updatedAt === "number"
    ? meta as SessionMeta
    : undefined;
}

async function discoverSessionDirs(sessionsDir: string): Promise<string[]> {
  let groups;
  try {
    groups = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupDir = join(sessionsDir, group.name);
    let sessions;
    try {
      sessions = await readdir(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (session.isDirectory() && SESSION_ID_RE.test(session.name)) result.push(join(groupDir, session.name));
    }
  }
  return result;
}
