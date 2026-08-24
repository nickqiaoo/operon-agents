import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore, offloadRecord, rehydrateRecord } from "./blob-store.ts";
import { compareSequence, pageRecords } from "./log-store.ts";
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

const AGENTS_DIR = "agents";
const BLOBS_DIR = "blobs";
const LOG_FILE = "log.jsonl";
const STATE_FILE = "state.json";

interface StoredDiskRecord {
  readonly sequence: string;
  readonly record: Record<string, unknown>;
}

export interface DiskSessionStoreOptions {
  /** Inline image data (base64) longer than this is offloaded to a blob. Default 4096. */
  readonly blobThreshold?: number;
}

export class DiskSessionStore implements SessionStore {
  private readonly sessionDir: string;
  private readonly blobStore: BlobStore;
  // The wire version this log was written at; cached after first read.
  private versionCache: number | undefined;
  // Whether we've reconciled the log to the current wire version this process.
  private upgraded = false;
  // Addresses whose shard has been checked for the leading `metadata` record this process.
  private readonly metadataChecked = new Set<string>();
  // Serializes state.json read-modify-write across concurrent putState/deleteState calls.
  private stateWrite: Promise<void> = Promise.resolve();
  // One sequence space spans every shard. Keeping allocation + append in this chain makes
  // the sequence order identical to durable append order within this store instance.
  private logWrite: Promise<void> = Promise.resolve();
  private lastSequence: bigint | undefined;

  constructor(sessionDir: string, options: DiskSessionStoreOptions = {}) {
    this.sessionDir = sessionDir;
    this.blobStore = new BlobStore({ blobsDir: join(sessionDir, BLOBS_DIR), threshold: options.blobThreshold });
  }

  storageDir(): string {
    return this.sessionDir;
  }

  /**
   * Best-effort "last written" time: the newest mtime among state.json and the shard logs,
   * which appendRecord/putState touch. Advances with activity — unlike the meta's stored
   * updatedAt, stamped once at create. The repository's list() uses this for "most recently
   * active" ordering. 0 if nothing is on disk yet.
   */
  async lastActivityMs(): Promise<number> {
    let latest = 0;
    const consider = async (p: string): Promise<void> => {
      try {
        const s = await stat(p);
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      } catch {
        /* missing — ignore */
      }
    };
    await consider(join(this.sessionDir, STATE_FILE));
    try {
      const shards = await readdir(join(this.sessionDir, AGENTS_DIR), { withFileTypes: true });
      for (const entry of shards) {
        if (entry.isDirectory()) await consider(join(this.sessionDir, AGENTS_DIR, entry.name, LOG_FILE));
      }
    } catch {
      /* no shards yet — ignore */
    }
    return latest;
  }

  appendRecord(record: AgentRecord): Promise<string> {
    return this.withLogLock(async () => {
      await this.ensureCurrentVersion();
      const address = record.address ?? DEFAULT_ADDRESS;
      const dir = join(this.sessionDir, AGENTS_DIR, shardName(address));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (record.type === "metadata") this.metadataChecked.add(address);
      else await this.ensureMetadata(address, dir);
      const stamped: AgentRecord = record.time !== undefined ? record : { ...record, time: Date.now() };
      const stored = await offloadRecord(stamped, this.blobStore);
      return this.appendStored(dir, stored);
    });
  }

  async *readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    const shards = filter?.address !== undefined ? [shardName(filter.address)] : await this.listShards();
    for (const item of await this.readStored(shards)) yield item.record;
  }

  async readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage> {
    const shards = options.address !== undefined ? [shardName(options.address)] : await this.listShards();
    return pageRecords(await this.readStored(shards), options);
  }

  async putState(key: StateKey, value: unknown): Promise<void> {
    // Serialize the read-modify-write on state.json so concurrent writes to different keys
    // (e.g. the wire-version stamp and the subagent registry) don't clobber each other.
    await this.withStateLock(async () => {
      const state = await this.readState();
      state[key] = value;
      await this.writeState(state);
    });
  }

  async getState(key: StateKey): Promise<unknown | null> {
    const state = await this.readState();
    return key in state ? (state[key] ?? null) : null;
  }

  async deleteState(key: StateKey): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.readState();
      if (!(key in state)) return;
      delete state[key];
      await this.writeState(state);
    });
  }

  async listStateKeys(): Promise<readonly StateKey[]> {
    return Object.keys(await this.readState());
  }

  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateWrite.then(fn, fn);
    this.stateWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Force shard logs and state to disk. */
  async flush(): Promise<void> {
    await Promise.all([this.logWrite, this.stateWrite]);
    for (const shard of await this.listShards()) {
      await fsyncFile(join(this.sessionDir, AGENTS_DIR, shard, LOG_FILE));
    }
    await fsyncFile(join(this.sessionDir, STATE_FILE));
  }

  async close(): Promise<void> {
    await this.flush();
  }

  /** Re-emit shard logs compactly: migrated to the current wire version, blob-offloaded, and
   *  free of any torn trailing line. Records dropped by migration are removed; each shard is
   *  kept opening with a `metadata` record. */
  async rewrite(address?: string): Promise<void> {
    await this.withLogLock(async () => {
      const shards = address !== undefined ? [shardName(address)] : await this.listShards();
      const fromVersion = await this.version();
      for (const shard of shards) await this.rewriteShard(shard, fromVersion);
      await this.stampVersion();
    });
  }

  // ── internals ──

  /** Read a shard's raw lines and bring each record up to the current wire version + rehydrate
   *  any offloaded blobs. Records dropped by a migration are skipped. */
  private async *readShardDecoded(shard: string): AsyncIterable<StoredAgentRecord> {
    const version = await this.version();
    for await (const stored of readRawLines(join(this.sessionDir, AGENTS_DIR, shard, LOG_FILE))) {
      const migrated = migrateRecord(stored.record, version);
      if (migrated !== null) {
        yield { sequence: stored.sequence, record: await rehydrateRecord(migrated, this.blobStore) };
      }
    }
  }

  private async readStored(shards: readonly string[]): Promise<StoredAgentRecord[]> {
    const all: StoredAgentRecord[] = [];
    for (const shard of shards) for await (const item of this.readShardDecoded(shard)) all.push(item);
    all.sort((a, b) => compareSequence(a.sequence, b.sequence));
    return all;
  }

  /** Ensure the shard's log opens with a `metadata` record. */
  private async ensureMetadata(address: string, dir: string): Promise<void> {
    if (this.metadataChecked.has(address)) return;
    this.metadataChecked.add(address);
    for await (const _ of readRawLines(join(dir, LOG_FILE))) return; // shard already has ≥1 line
    await this.appendStored(dir, metadataRecord(address));
  }

  /** The version this log was written at; an absent stamp defaults to 0. */
  private async version(): Promise<number> {
    if (this.versionCache !== undefined) return this.versionCache;
    const stored = await this.getState(WIRE_VERSION_KEY);
    this.versionCache = typeof stored === "number" ? stored : 0;
    return this.versionCache;
  }

  /** On the first write of the process, reconcile a stale log to the current version. */
  private async ensureCurrentVersion(): Promise<void> {
    if (this.upgraded) return;
    this.upgraded = true;
    const hasLog = (await this.listShards()).length > 0;
    if (!hasLog) {
      // Brand-new session: stamp current; nothing to migrate.
      await this.stampVersion();
      return;
    }
    const version = await this.version();
    if (version < WIRE_PROTOCOL_VERSION) {
      // Legacy/stale log: migrate every record and re-emit before appending current-shape ones,
      // so the log never mixes versions.
      for (const shard of await this.listShards()) await this.rewriteShard(shard, version);
      await this.stampVersion();
    }
  }

  private async stampVersion(): Promise<void> {
    await this.putState(WIRE_VERSION_KEY, WIRE_PROTOCOL_VERSION);
    this.versionCache = WIRE_PROTOCOL_VERSION;
  }

  private async rewriteShard(shard: string, fromVersion: number): Promise<void> {
    const dir = join(this.sessionDir, AGENTS_DIR, shard);
    const target = join(dir, LOG_FILE);
    const lines: StoredDiskRecord[] = [];
    for await (const stored of readRawLines(target)) {
      // Migrate to current, then offload (without rehydrating — existing blob refs pass through).
      const migrated = migrateRecord(stored.record, fromVersion);
      if (migrated === null) continue; // a migration may drop a record
      const offloaded = await offloadRecord(migrated, this.blobStore);
      lines.push({ sequence: stored.sequence, record: offloaded as Record<string, unknown> });
    }
    const withMeta = withLeadingMetadata(lines, shardAddress(shard));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, withMeta.length > 0 ? `${withMeta.map((line) => JSON.stringify(line)).join("\n")}\n` : "", { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, target);
    this.metadataChecked.add(shardAddress(shard));
  }

  private async listShards(): Promise<string[]> {
    try {
      const dirents = await readdir(join(this.sessionDir, AGENTS_DIR), { withFileTypes: true });
      return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  private async readState(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(join(this.sessionDir, STATE_FILE), "utf-8");
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async writeState(state: Record<string, unknown>): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const target = join(this.sessionDir, STATE_FILE);
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, target);
  }

  private async withLogLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.logWrite.then(fn, fn);
    this.logWrite = run.then(() => undefined, () => undefined);
    return run;
  }

  private async appendStored(dir: string, record: Record<string, unknown>): Promise<string> {
    const sequence = String(await this.nextSequence());
    await appendFile(join(dir, LOG_FILE), `${JSON.stringify({ sequence, record } satisfies StoredDiskRecord)}\n`, "utf-8");
    return sequence;
  }

  // The counter lives only in memory: every log line embeds its sequence, so the last
  // allocated value is recoverable from the shard tails (allocation is globally monotonic,
  // hence each shard's final line is its max, and rewrites never renumber).
  private async nextSequence(): Promise<bigint> {
    if (this.lastSequence === undefined) {
      let last = 0n;
      for (const shard of await this.listShards()) {
        let tail: string | undefined;
        for await (const stored of readRawLines(join(this.sessionDir, AGENTS_DIR, shard, LOG_FILE))) tail = stored.sequence;
        if (tail !== undefined && BigInt(tail) > last) last = BigInt(tail);
      }
      this.lastSequence = last;
    }
    this.lastSequence += 1n;
    return this.lastSequence;
  }
}

/** The leading `metadata` record stamped at the head of a shard's log. */
function metadataRecord(address: string): AgentRecord {
  return { type: "metadata", protocol_version: WIRE_PROTOCOL_VERSION, created_at: Date.now(), time: Date.now(), address };
}

/** Keep an existing leading metadata record and correct its informational address in place. */
function withLeadingMetadata(lines: readonly StoredDiskRecord[], address: string): StoredDiskRecord[] {
  const first = lines[0];
  if (first !== undefined) {
    try {
      if (first.record["type"] === "metadata") {
        return first.record["address"] === address
          ? [...lines]
          : [{ sequence: first.sequence, record: { ...first.record, address } }, ...lines.slice(1)];
      }
    } catch {
      /* malformed records are handled by the reader before rewrite */
    }
  }
  return [...lines];
}

function shardName(address: string | undefined): string {
  const addr = address ?? DEFAULT_ADDRESS;
  const safe = addr.replaceAll(/[^a-zA-Z0-9_-]+/g, "_").replaceAll(/^_+|_+$/g, "");
  if (safe.length === 0) return DEFAULT_ADDRESS;
  // Guard against collisions after sanitization by suffixing a short hash when the address
  // contained stripped characters (so "a/b" and "a_b" don't share a shard).
  if (safe === addr) return safe;
  const hash = createHash("sha256").update(addr).digest("hex").slice(0, 6);
  return `${safe}_${hash}`;
}

/** Best-effort inverse of `shardName` for metadata stamping. Sanitized shards keep their name
 *  (address == shard); hash-suffixed shards can't be inverted, so the metadata `address` field is
 *  approximate — it is informational only (reduceHistory never reads it). */
function shardAddress(shard: string): string {
  return shard;
}

/** Yield each well-formed JSON record of a log file (a torn trailing line is tolerated). */
async function* readRawLines(filePath: string): AsyncIterable<StoredDiskRecord> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as Partial<StoredDiskRecord>;
      if (typeof parsed.sequence !== "string" || !/^[1-9]\d*$/.test(parsed.sequence) || !isRecord(parsed.record)) {
        throw new Error(`invalid stored record envelope`);
      }
      yield { sequence: parsed.sequence, record: parsed.record };
    } catch (error) {
      // The very last line may be a half-flushed write at crash time — tolerate it.
      if (i === lines.length - 1) return;
      throw new Error(`log.jsonl: corrupted line ${i + 1} in ${filePath}: ${String(error)}`, { cause: error });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fsyncFile(filePath: string): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, "r+");
  } catch {
    return; // file doesn't exist yet — nothing to sync
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
