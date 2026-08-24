import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRecord } from "./store.ts";

const BLOBREF_PREFIX = "blobref:";
const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_BYTES = 50 * 1024 * 1024;

export function isBlobRef(value: string): boolean {
  return value.startsWith(BLOBREF_PREFIX);
}

/** Raw byte I/O a {@link BlobStore} runs on. `diskBlobIO` is the filesystem implementation;
 *  pg/redis backends inject their own (a blob table / key namespace). */
export interface BlobIO {
  read(sha: string): Promise<Buffer | undefined>;
  write(sha: string, bytes: Buffer): Promise<void>;
}

export type BlobStoreOptions = (
  | { readonly blobsDir: string; readonly io?: undefined }
  | { readonly io: BlobIO; readonly blobsDir?: undefined }
) & {
  /** Inline image `data` (base64) longer than this gets offloaded. Default 4096. */
  readonly threshold?: number;
  readonly maxCacheBytes?: number;
};

/** Filesystem {@link BlobIO}: content-addressed `<blobsDir>/<sha>.bin`, crash-safe via tmp+rename. */
export function diskBlobIO(blobsDir: string): BlobIO {
  return {
    async read(sha) {
      try {
        return await readFile(join(blobsDir, `${sha}.bin`));
      } catch {
        return undefined;
      }
    },
    async write(sha, bytes) {
      await mkdir(blobsDir, { recursive: true, mode: 0o700 });
      const target = join(blobsDir, `${sha}.bin`);
      // Content-addressed: identical bytes → identical file. tmp+rename so a crash can't leave a torn blob.
      const tmp = `${target}.tmp.${process.pid}.${sha.slice(0, 8)}`;
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, target);
    },
  };
}

/**
 * Content-addressed sidecar store for large inline content (images). Oversized base64 `data` is
 * written to a {@link BlobIO} (filesystem, Postgres, Redis…) under its sha256 and the inline value
 * is replaced with a `blobref:<sha256>` marker. Same bytes → same key (dedup). A bounded LRU keeps
 * hot blobs in memory.
 */
export class BlobStore {
  private readonly io: BlobIO;
  private readonly threshold: number;
  private readonly maxCacheBytes: number;
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;

  constructor(options: BlobStoreOptions) {
    this.io = options.io ?? diskBlobIO(options.blobsDir);
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  }

  /** base64 `data` → `blobref:<sha>` if oversized; pass-through otherwise (incl. already-ref). */
  async offload(data: string): Promise<string> {
    if (isBlobRef(data) || data.length <= this.threshold) return data;
    const bytes = Buffer.from(data, "base64");
    const sha = createHash("sha256").update(bytes).digest("hex");
    await this.io.write(sha, bytes);
    this.cachePut(sha, bytes);
    return `${BLOBREF_PREFIX}${sha}`;
  }

  /** `blobref:<sha>` → base64 `data`; pass-through for inline values. */
  async load(data: string): Promise<string> {
    if (!isBlobRef(data)) return data;
    const sha = data.slice(BLOBREF_PREFIX.length);
    const cached = this.cache.get(sha);
    if (cached !== undefined) return cached.toString("base64");
    const bytes = await this.io.read(sha);
    if (bytes === undefined) throw new Error(`blob "${sha}" not found`);
    this.cachePut(sha, bytes);
    return bytes.toString("base64");
  }

  private cachePut(sha: string, bytes: Buffer): void {
    if (bytes.length > this.maxCacheBytes) return;
    if (this.cache.has(sha)) {
      this.cache.delete(sha);
      this.cacheBytes -= bytes.length;
    }
    this.cache.set(sha, bytes);
    this.cacheBytes += bytes.length;
    // Evict oldest (insertion-ordered Map) until under budget.
    while (this.cacheBytes > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cacheBytes -= this.cache.get(oldest)!.length;
      this.cache.delete(oldest);
    }
  }
}

type ImageTransform = (data: string, mimeType: string) => Promise<string>;

/** Deep-walk a record, transforming every `{type:'image', data, mimeType}` node's `data`.
 *  Non-mutating: returns a fresh structure so the caller's record is never altered. */
async function transformImages(value: unknown, fn: ImageTransform): Promise<unknown> {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await transformImages(item, fn));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "image" && typeof obj.data === "string" && typeof obj.mimeType === "string") {
      return { ...obj, data: await fn(obj.data, obj.mimeType) };
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) out[key] = await transformImages(obj[key], fn);
    return out;
  }
  return value;
}

/** Replace oversized inline image data with blob refs (write side). */
export async function offloadRecord(record: AgentRecord, blobs: BlobStore): Promise<AgentRecord> {
  return (await transformImages(record, (data) => blobs.offload(data))) as AgentRecord;
}

/** Replace blob refs with inline image data (read side). */
export async function rehydrateRecord(record: AgentRecord, blobs: BlobStore): Promise<AgentRecord> {
  return (await transformImages(record, (data) => blobs.load(data))) as AgentRecord;
}
