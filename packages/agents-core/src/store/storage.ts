import { DiskSessionRepository, MemorySessionRepository } from "./repository.ts";
import type {
  CreateSessionInput,
  ForkSessionInput,
  ListSessionsFilter,
  OpenSessionOptions,
  DeleteSessionOptions,
  SessionHandle,
  SessionRepository,
  SessionSummary,
} from "./repository.ts";
import type { SessionStore } from "./store.ts";

/**
 * The single public door to persistence. A `SessionStorage` IS the session catalog
 * (create / open / list / fork / delete) AND a producer of one-shot stores. Pick exactly one
 * backing: `memoryStorage()` / `diskStorage()` / `pgStorage()` / `redisStorage()`.
 */
export interface SessionStorage extends SessionRepository {
  /**
   * A one-shot store with no tracked id — for ephemeral runs (`new Runner({ store })`) where you
   * don't need create/open/list. The session still exists in the storage; you just don't keep a
   * handle to reopen it.
   */
  scratch(workDir?: string): Promise<SessionStore>;
  /** Release shared resources (e.g. a connection pool). No-op for memory/disk. */
  close(): Promise<void>;
}

/** Default workdir for an anonymous {@link SessionStorage.scratch} session. */
const SCRATCH_WORKDIR = "/";

/** Adapts a bare {@link SessionRepository} into the public {@link SessionStorage} door. */
class RepositoryStorage implements SessionStorage {
  private readonly repo: SessionRepository;

  constructor(repo: SessionRepository) {
    this.repo = repo;
  }

  create(input: CreateSessionInput): Promise<SessionHandle> {
    return this.repo.create(input);
  }
  open(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined> {
    return this.repo.open(id, options);
  }
  get(id: string): Promise<SessionSummary | undefined> {
    return this.repo.get(id);
  }
  list(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]> {
    return this.repo.list(filter);
  }
  fork(sourceId: string, input?: ForkSessionInput): Promise<SessionHandle> {
    return this.repo.fork(sourceId, input);
  }
  delete(id: string, options?: DeleteSessionOptions): Promise<void> {
    return this.repo.delete(id, options);
  }
  restore(id: string): Promise<void> {
    return this.repo.restore(id);
  }
  async scratch(workDir: string = SCRATCH_WORKDIR): Promise<SessionStore> {
    return (await this.repo.create({ workDir })).store;
  }
  async close(): Promise<void> {
    // Forward to the repository if it owns resources (pg/redis do); memory/disk don't.
    await (this.repo as { close?: () => Promise<void> }).close?.();
  }
}

/**
 * Wrap a bare {@link SessionRepository} as the public {@link SessionStorage} door. Used by the
 * built-in factories and by add-on backings (pg/redis) so they don't re-implement scratch/close.
 */
export function storageOver(repo: SessionRepository): SessionStorage {
  return new RepositoryStorage(repo);
}

/** In-process storage: sessions, stores, and blobs live in memory (gone on restart). */
export function memoryStorage(): SessionStorage {
  return storageOver(new MemorySessionRepository());
}

/** Filesystem storage rooted at `homeDir` (sharded logs + state.json + blobs per session). */
export function diskStorage(homeDir: string): SessionStorage {
  return storageOver(new DiskSessionRepository(homeDir));
}
