/**
 * A capability's own durable data: a key/value `state` and a stream of named `records`, each
 * partitioned by the capability's name. What `SessionContext.state` / `records` / `record` are
 * built from — one `CapabilityData` per session, one view per capability.
 *
 * The partition prefix is `extension:<owner>:`, not `capability:`, on purpose: extensions wrote
 * their state and records under that prefix before they became capabilities, and keeping it is
 * what lets a session written by an extension read back after the extension is a capability.
 */
import type { AgentRecord, AgentRecordBody, SessionStore } from "../store/index.ts";

/** Durable per-capability key/value state (SessionStore-backed; in memory for a storeless session). */
export interface CapabilityState {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One record a capability wrote with `record(name, data)`, as `records()` hands it back. */
export interface CapabilityRecord {
  readonly name: string;
  readonly data?: unknown;
}

const PREFIX = "extension:";

export interface CapabilityDataOptions {
  readonly store?: SessionStore;
  /** The session's memoized log read — the same one the log-folding capabilities share. */
  readonly readLog: () => Promise<readonly AgentRecord[]>;
  /** Journal a record into the session's main conversation. */
  readonly append: (body: AgentRecordBody) => void;
}

export class CapabilityData {
  private readonly store: SessionStore | undefined;
  private readonly readLog: () => Promise<readonly AgentRecord[]>;
  private readonly append: (body: AgentRecordBody) => void;
  /** Storeless sessions keep state here, for the session's lifetime. */
  private readonly memoryState = new Map<string, unknown>();
  /** Records written in THIS session, per owner, in write order. */
  private readonly writes = new Map<string, CapabilityRecord[]>();
  /** Records from earlier processes, per owner — bucketed once, on the first `records()` call. */
  private snapshot: Promise<Map<string, CapabilityRecord[]>> | undefined;
  /**
   * The line between "earlier" and "this session". A log read taken AFTER a write has been
   * persisted would otherwise return that write a second time, alongside its copy in `writes`.
   */
  private readonly openedAt = Date.now();

  constructor(options: CapabilityDataOptions) {
    this.store = options.store;
    this.readLog = options.readLog;
    this.append = options.append;
  }

  stateFor(owner: string): CapabilityState {
    const prefix = `${PREFIX}${owner}:`;
    const store = this.store;
    return {
      get: async <T>(key: string) => {
        const full = prefix + key;
        return ((store !== undefined ? await store.getState(full) : this.memoryState.get(full)) ?? null) as T | null;
      },
      set: async (key, value) => {
        const full = prefix + key;
        if (store !== undefined) await store.putState(full, value);
        else this.memoryState.set(full, value);
      },
      delete: async (key) => {
        const full = prefix + key;
        if (store !== undefined) await store.deleteState(full);
        else this.memoryState.delete(full);
      },
    };
  }

  recordsFor(owner: string): () => Promise<readonly CapabilityRecord[]> {
    return async () => {
      const earlier = (await this.earlier()).get(owner) ?? [];
      return [...earlier, ...(this.writes.get(owner) ?? [])];
    };
  }

  recorderFor(owner: string): (name: string, data?: unknown) => void {
    return (name, data) => {
      this.append({ type: "custom", name: `${PREFIX}${owner}:${name}`, data });
      const bucket = this.writes.get(owner) ?? [];
      if (!this.writes.has(owner)) this.writes.set(owner, bucket);
      bucket.push({ name, ...(data !== undefined ? { data } : {}) });
    };
  }

  /** One pass over the log buckets every owner's records; owners are colon-free slugs, so the
   *  prefix parse is unambiguous. */
  private earlier(): Promise<Map<string, CapabilityRecord[]>> {
    this.snapshot ??= this.readLog().then((log) => {
      const buckets = new Map<string, CapabilityRecord[]>();
      for (const record of log) {
        if (record.type !== "custom" || (record.time ?? 0) >= this.openedAt) continue;
        const full = (record as { readonly name?: unknown }).name;
        if (typeof full !== "string" || !full.startsWith(PREFIX)) continue;
        const rest = full.slice(PREFIX.length);
        const sep = rest.indexOf(":");
        if (sep <= 0) continue;
        const owner = rest.slice(0, sep);
        const data = (record as { readonly data?: unknown }).data;
        const bucket = buckets.get(owner) ?? [];
        if (!buckets.has(owner)) buckets.set(owner, bucket);
        bucket.push({ name: rest.slice(sep + 1), ...(data !== undefined ? { data } : {}) });
      }
      return buckets;
    });
    return this.snapshot;
  }
}
