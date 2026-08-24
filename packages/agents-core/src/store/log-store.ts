import { BlobStore, offloadRecord, rehydrateRecord } from "./blob-store.ts";
import { migrateRecord, WIRE_PROTOCOL_VERSION, WIRE_VERSION_KEY } from "./migrate.ts";
import {
  type AgentRecord,
  DEFAULT_ADDRESS,
  type ReadRecordPageOptions,
  type ReadRecordsFilter,
  type RecordPage,
  type SessionStore,
  type StateKey,
  type StoredAgentRecord,
} from "./store.ts";

export interface LogStoreOptions {
  /** Inline image data (base64) longer than this is offloaded to a blob. Default 4096. */
  readonly blobThreshold?: number;
}

export interface StoredLogLine {
  readonly sequence: string;
  readonly line: string;
}

export interface ReadLinesPageOptions {
  /** Strictly past this sequence, in `order`. Omit to start from the end `order` begins at. */
  readonly after?: string;
  readonly limit: number;
  readonly order: "asc" | "desc";
}

/**
 * The **linear** session log implemented once over a tiny physical machine
 * (raw line append/read/rewrite + key-value state + content-addressed blobs). A new backing
 * (disk, Postgres, Redis, S3…) implements only those primitives; the flat append log, first-
 * record `metadata` prepend, wire migration, and blob offload are written once here. Records are
 * JSON lines in append order per address; a shard's conversation is those records reduced.
 */
export abstract class LogSessionStore implements SessionStore {
  // ECMAScript-private so a subclass field can never clobber these.
  readonly #blobs: BlobStore;
  #versionCache: number | undefined;
  #versionStamped = false;
  #appendWrite: Promise<void> = Promise.resolve();
  // Addresses whose shard has been checked for the leading `metadata` record this process.
  readonly #metadataChecked = new Set<string>();

  constructor(options: LogStoreOptions = {}) {
    this.#blobs = new BlobStore({
      io: { read: (sha) => this.readBlobBytes(sha), write: (sha, bytes) => this.writeBlobBytes(sha, bytes) },
      ...(options.blobThreshold !== undefined ? { threshold: options.blobThreshold } : {}),
    });
  }

  // ── physical primitives each backing implements ──
  /** Append a raw line to an address's log. */
  protected abstract appendLine(address: string, line: string): Promise<string>;
  /** The address's log lines in append order. A torn trailing line (crash) is tolerated. */
  protected abstract readLines(address: string): AsyncIterable<StoredLogLine>;
  /**
   * One page of an address's lines (optional). A backing that can seek — an indexed table —
   * implements this so `readRecordPage` costs a range read instead of the whole shard; one that
   * cannot (a flat file) leaves it out and pages in memory. Either way the result is the same.
   */
  protected readLinesPage?(address: string, options: ReadLinesPageOptions): Promise<readonly StoredLogLine[]>;
  /** Atomically replace an address's whole log. */
  protected abstract rewriteLines(address: string, lines: readonly StoredLogLine[]): Promise<void>;
  /** Every address that has a log. */
  protected abstract listShardAddresses(): Promise<readonly string[]>;
  /** Content-addressed blob bytes (`undefined` if absent). */
  protected abstract readBlobBytes(sha: string): Promise<Buffer | undefined>;
  protected abstract writeBlobBytes(sha: string, bytes: Buffer): Promise<void>;

  // Session-wide key-value state (each op atomic on its own key) — implemented by the backing.
  abstract getState(key: StateKey): Promise<unknown | null>;
  abstract putState(key: StateKey, value: unknown): Promise<void>;
  abstract deleteState(key: StateKey): Promise<void>;

  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }

  // ── ① append log (flat, linear; first record of a shard is `metadata`) ──

  appendRecord(record: AgentRecord): Promise<string> {
    const run = this.#appendWrite.then(() => this.appendRecordNow(record), () => this.appendRecordNow(record));
    this.#appendWrite = run.then(() => undefined, () => undefined);
    return run;
  }

  private async appendRecordNow(record: AgentRecord): Promise<string> {
    await this.ensureVersionStamped();
    const address = record.address ?? DEFAULT_ADDRESS;
    if (record.type === "metadata") this.#metadataChecked.add(address);
    else await this.ensureMetadata(address);
    const stamped: AgentRecord = record.time !== undefined ? record : { ...record, time: Date.now() };
    const stored = await offloadRecord(stamped, this.#blobs);
    return this.appendLine(address, JSON.stringify(stored));
  }

  async *readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    for (const item of await this.storedRecords(filter?.address)) yield item.record;
  }

  async readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage> {
    if (options.address !== undefined && this.readLinesPage !== undefined) {
      return this.readRecordPageSeeking(options.address, options);
    }
    return pageRecords(await this.storedRecords(options.address), options);
  }

  /** `readRecordPage` over a backing that can seek: read `limit + 1` lines to learn whether a
   *  next page exists, parse only those. Same validation and cursor semantics as `pageRecords`. */
  private async readRecordPageSeeking(address: string, options: ReadRecordPageOptions): Promise<RecordPage> {
    assertPageLimit(options.limit);
    if (options.after !== undefined) parseSequence(options.after);
    const lines = await this.readLinesPage!(address, {
      ...(options.after !== undefined ? { after: options.after } : {}),
      limit: options.limit + 1,
      order: options.order ?? "asc",
    });
    const page = lines.slice(0, options.limit);
    const version = await this.version();
    const data: StoredAgentRecord[] = [];
    for (const storedLine of page) {
      const migrated = migrateRecord(JSON.parse(storedLine.line) as AgentRecord, version);
      if (migrated === null) continue;
      data.push({ sequence: storedLine.sequence, record: await rehydrateRecord(migrated, this.#blobs) });
    }
    // The cursor is the last LINE read, not the last record returned: a line a migration dropped
    // still has to be stepped over, or the next page would read it again.
    const last = page[page.length - 1];
    return {
      data,
      ...(lines.length > page.length && last !== undefined ? { next: last.sequence } : {}),
    };
  }

  listAddresses(): Promise<readonly string[]> {
    return this.listShardAddresses();
  }

  // ── ② KV state — provided by the backing (abstract above) ──

  /** Re-emit a shard's log compactly: migrated to the current wire version + blob-offloaded. */
  rewrite(address?: string): Promise<void> {
    const run = this.#appendWrite.then(() => this.rewriteNow(address), () => this.rewriteNow(address));
    this.#appendWrite = run.then(() => undefined, () => undefined);
    return run;
  }

  private async rewriteNow(address?: string): Promise<void> {
    const addresses = address !== undefined ? [address] : [...(await this.listShardAddresses())];
    const fromVersion = await this.version();
    for (const addr of addresses) {
      const lines: StoredLogLine[] = [];
      for await (const storedLine of this.readLines(addr)) {
        const migrated = migrateRecord(JSON.parse(storedLine.line) as AgentRecord, fromVersion);
        if (migrated === null) continue; // a migration may drop a record
        lines.push({ sequence: storedLine.sequence, line: JSON.stringify(await offloadRecord(migrated, this.#blobs)) });
      }
      await this.rewriteLines(addr, withLeadingMetadata(lines, addr));
      this.#metadataChecked.add(addr);
    }
    await this.stampVersion();
  }

  // ── internals ──

  /** Parsed + wire-migrated records for an address, in append order (NOT blob-rehydrated).
   *  Records dropped by a migration are skipped. */
  private async parsedRecords(address: string): Promise<StoredAgentRecord[]> {
    const version = await this.version();
    const out: StoredAgentRecord[] = [];
    for await (const storedLine of this.readLines(address)) {
      const migrated = migrateRecord(JSON.parse(storedLine.line) as AgentRecord, version);
      if (migrated !== null) {
        out.push({ sequence: storedLine.sequence, record: await rehydrateRecord(migrated, this.#blobs) });
      }
    }
    return out;
  }

  private async storedRecords(address?: string): Promise<StoredAgentRecord[]> {
    if (address !== undefined) return this.parsedRecords(address);
    const all: StoredAgentRecord[] = [];
    for (const shard of await this.listShardAddresses()) all.push(...(await this.parsedRecords(shard)));
    all.sort((a, b) => compareSequence(a.sequence, b.sequence));
    return all;
  }

  /** Ensure the shard's log opens with a `metadata` record. Cheap after first touch. */
  private async ensureMetadata(address: string): Promise<void> {
    if (this.#metadataChecked.has(address)) return;
    this.#metadataChecked.add(address);
    if (!(await this.shardIsEmpty(address))) return;
    await this.appendLine(address, JSON.stringify(metadataRecord(address)));
  }

  private async shardIsEmpty(address: string): Promise<boolean> {
    // A seeking backing answers with one row; a streaming one is stopped after its first line.
    if (this.readLinesPage !== undefined) {
      return (await this.readLinesPage(address, { limit: 1, order: "asc" })).length === 0;
    }
    for await (const _ of this.readLines(address)) return false;
    return true;
  }

  private async version(): Promise<number> {
    if (this.#versionCache !== undefined) return this.#versionCache;
    const stored = await this.getState(WIRE_VERSION_KEY);
    this.#versionCache = typeof stored === "number" ? stored : WIRE_PROTOCOL_VERSION;
    return this.#versionCache;
  }

  private async ensureVersionStamped(): Promise<void> {
    if (this.#versionStamped) return;
    // Set synchronously so a second caller returns early instead of re-running the migration.
    // Narrow window: that early return does NOT await the in-flight rewrite()/stampVersion()
    // below, so a concurrent first-write during a version upgrade could append before the
    // rewrite lands. In practice a single context's writes are serialized upstream by
    // ConversationContext.writeChain, so this only bites on cross-context first-write races
    // over a shared store mid-upgrade — low risk, noted rather than locked.
    this.#versionStamped = true;
    const stored = await this.getState(WIRE_VERSION_KEY);
    if (stored === null) {
      await this.stampVersion();
      return;
    }
    if (typeof stored === "number" && stored < WIRE_PROTOCOL_VERSION) {
      this.#versionCache = stored;
      await this.rewriteNow();
      await this.stampVersion();
    }
  }

  private async stampVersion(): Promise<void> {
    await this.putState(WIRE_VERSION_KEY, WIRE_PROTOCOL_VERSION);
    this.#versionCache = WIRE_PROTOCOL_VERSION;
  }
}

/** The leading `metadata` record stamped at the head of a shard's log. */
function metadataRecord(address: string): AgentRecord {
  return { type: "metadata", protocol_version: WIRE_PROTOCOL_VERSION, created_at: Date.now(), time: Date.now(), address };
}

/** Keep an existing leading metadata record and correct its informational address in place.
 *  New-format stores always create metadata before their first data record; rewrite therefore
 *  never needs to invent one (which would have no valid earlier sequence). */
function withLeadingMetadata(lines: readonly StoredLogLine[], address: string): StoredLogLine[] {
  const first = lines[0];
  if (first !== undefined) {
    try {
      const parsed = JSON.parse(first.line) as { type?: string; address?: string };
      if (parsed.type === "metadata") {
        if (parsed.address === address) return [...lines];
        return [{ sequence: first.sequence, line: JSON.stringify({ ...parsed, address }) }, ...lines.slice(1)];
      }
    } catch {
      /* malformed records are handled by the reader before rewrite */
    }
  }
  // Current stores always stamp metadata before the first real append. There is deliberately
  // no legacy repair here: inventing a new leading record would require renumbering an existing
  // record, violating sequence stability.
  return [...lines];
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** In-process session store: logs, state, and blobs in process memory (gone on restart). */
export class MemoryStore extends LogSessionStore {
  private readonly logs = new Map<string, StoredLogLine[]>();
  private readonly kv = new Map<string, unknown>();
  private readonly blobBytes = new Map<string, Buffer>();
  private sequence = 0n;

  protected async appendLine(address: string, line: string): Promise<string> {
    const sequence = String(++this.sequence);
    const stored = { sequence, line };
    const log = this.logs.get(address);
    if (log === undefined) this.logs.set(address, [stored]);
    else log.push(stored);
    return sequence;
  }
  protected async *readLines(address: string): AsyncIterable<StoredLogLine> {
    yield* this.logs.get(address) ?? [];
  }
  protected async rewriteLines(address: string, lines: readonly StoredLogLine[]): Promise<void> {
    this.logs.set(address, [...lines]);
  }
  protected async listShardAddresses(): Promise<readonly string[]> {
    return [...this.logs.keys()];
  }
  protected async readBlobBytes(sha: string): Promise<Buffer | undefined> {
    return this.blobBytes.get(sha);
  }
  protected async writeBlobBytes(sha: string, bytes: Buffer): Promise<void> {
    this.blobBytes.set(sha, bytes);
  }
  async getState(key: StateKey): Promise<unknown | null> {
    return this.kv.has(key) ? clone(this.kv.get(key)) : null;
  }
  async putState(key: StateKey, value: unknown): Promise<void> {
    this.kv.set(key, clone(value));
  }
  async deleteState(key: StateKey): Promise<void> {
    this.kv.delete(key);
  }
  async listStateKeys(): Promise<readonly StateKey[]> {
    return [...this.kv.keys()];
  }
}

export function compareSequence(a: string, b: string): number {
  const left = parseSequence(a);
  const right = parseSequence(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function pageRecords(
  records: readonly StoredAgentRecord[],
  options: ReadRecordPageOptions,
): RecordPage {
  assertPageLimit(options.limit);
  const order = options.order ?? "asc";
  const cursor = options.after === undefined ? undefined : parseSequence(options.after);
  const ordered = order === "asc" ? [...records] : [...records].reverse();
  const eligible = cursor === undefined
    ? ordered
    : ordered.filter(({ sequence }) => order === "asc" ? parseSequence(sequence) > cursor : parseSequence(sequence) < cursor);
  const data = eligible.slice(0, options.limit);
  return {
    data,
    ...(eligible.length > data.length && data.length > 0 ? { next: data[data.length - 1]!.sequence } : {}),
  };
}

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("record page limit must be a positive integer");
  }
}

function parseSequence(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`invalid record sequence "${value}"`);
  return BigInt(value);
}
