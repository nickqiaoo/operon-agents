import type {
  AgentRecord,
  ReadRecordPageOptions,
  ReadRecordsFilter,
  RecordPage,
  SessionStore,
  StateKey,
} from "./store.ts";

export type DurableSessionState = "idle" | "interrupted";

export interface SessionCatalogObserver {
  activity(at: number, source: "log" | "state"): void | Promise<void>;
  durableState(state: DurableSessionState, at: number): void | Promise<void>;
  metadata?(value: unknown, at: number): void | Promise<void>;
  flush?(): Promise<void>;
}

/**
 * Decorates a repository-owned store with catalog maintenance. The session KV/log remains
 * authoritative: callbacks run only after the corresponding write succeeds, and a broken
 * derived catalog never turns that durable write into a reported failure. Repository startup
 * reconciliation repairs the resulting stale summary.
 */
export class CatalogSessionStore implements SessionStore {
  private readonly inner: SessionStore;
  private readonly observer: SessionCatalogObserver;
  readonly listStateKeys?: () => Promise<readonly StateKey[]>;
  readonly storageDir?: () => string | undefined;

  constructor(inner: SessionStore, observer: SessionCatalogObserver) {
    this.inner = inner;
    this.observer = observer;
    if (inner.listStateKeys !== undefined) this.listStateKeys = () => inner.listStateKeys!();
    if (inner.storageDir !== undefined) this.storageDir = () => inner.storageDir!();
  }

  async appendRecord(record: AgentRecord): Promise<string> {
    const sequence = await this.inner.appendRecord(record);
    await this.notify(() => this.observer.activity(Date.now(), "log"));
    return sequence;
  }

  readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    return this.inner.readRecords(filter);
  }

  readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage> {
    return this.inner.readRecordPage(options);
  }

  async putState(key: StateKey, value: unknown): Promise<void> {
    await this.inner.putState(key, value);
    const at = Date.now();
    await this.notify(() => {
      if (key === "interrupt") return this.observer.durableState("interrupted", at);
      if (key === "meta" && this.observer.metadata !== undefined) return this.observer.metadata(value, at);
      return this.observer.activity(at, "state");
    });
  }

  getState(key: StateKey): Promise<unknown | null> {
    return this.inner.getState(key);
  }

  async deleteState(key: StateKey): Promise<void> {
    await this.inner.deleteState(key);
    const at = Date.now();
    await this.notify(() => key === "interrupt"
      ? this.observer.durableState("idle", at)
      : this.observer.activity(at, "state"));
  }

  async flush(): Promise<void> {
    await this.inner.flush?.();
    await this.observer.flush?.();
  }

  async close(): Promise<void> {
    await this.inner.close?.();
    await this.observer.flush?.();
  }

  async rewrite(address?: string): Promise<void> {
    await this.inner.rewrite?.(address);
    await this.notify(() => this.observer.activity(Date.now(), "log"));
  }

  private async notify(callback: () => void | Promise<void>): Promise<void> {
    try {
      await callback();
    } catch {
      // Catalog is a rebuildable read model. The authoritative write above already committed.
    }
  }
}
