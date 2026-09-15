/**
 * Session-scoped file freshness ledger — the read-state record backing the
 * tool path. Carries the safety invariants for Edit/Write (read-before-write,
 * external-modification detection) plus the Read dedup stub, so it is core tool
 * infrastructure, NOT a capability: it must not be toggleable by composition.
 *
 * Owned by the Session (one per agent; subagents get their own — a subagent has
 * not "read" what its parent read). Threaded into ToolResolveContext/ToolRunContext
 * by the loop. Keys are host-canonical absolute paths.
 *
 * Freshness is mtime-first (local-first): when both sides have an mtime and it
 * matches, the file is fresh with zero extra I/O. Content comparison runs only when
 * the mtime moved (false-positive review: cloud sync / antivirus / Windows) or is
 * unavailable (mtime-less sandbox backends), and compares a digest of the text the
 * record was taken from — the text itself is never retained, so a record costs the
 * same for a 1 KB file and a 10 MB one.
 *
 * Bounded as an LRU: an agent that has touched more than {@link LEDGER_MAX_ENTRIES}
 * files forgets the least recently used, which then reads as "not read yet" — the
 * conservative direction.
 */
import type { FileVersion, LineEndings } from "./machine.ts";
// Same predicate the Machine-side check uses (BaseMachine.assertUnchanged) — the two
// run at different moments and must never disagree about what "unchanged" means.
import { fileVersionsMatch, hashFileContent } from "./support/machine-ops.ts";

/** Default record cap of a {@link FileFreshnessLedger}. */
export const LEDGER_MAX_ENTRIES = 5000;

export const FILE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
export const FILE_MODIFIED_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current; refer to that instead of re-reading.";

export interface FileReadRecord {
  readonly version: FileVersion;
  /** {@link hashFileContent} of the full text (LF-normalized, BOM-stripped); full reads only. */
  readonly contentHash?: string;
  /** True when the read covered the whole file. Partial reads never pass content review. */
  readonly fullRead: boolean;
  readonly range?: { readonly lineOffset: number; readonly maxLines?: number };
  readonly lineEndings: LineEndings;
  readonly encoding: BufferEncoding;
  /** When the read happened (diagnostics only — plays no part in freshness). */
  readonly readAt: number;
}

export type FreshnessVerdict =
  | { readonly kind: "fresh" }
  | { readonly kind: "not-read" }
  | { readonly kind: "stale" };

/** What a reader hands the ledger: the record, with the text in place of its digest. */
export type RecordReadInput = Omit<FileReadRecord, "contentHash"> & {
  /** Full text (LF-normalized, BOM-stripped) — hashed, not retained. Pass only for full reads. */
  readonly content?: string;
};

export interface RecordWriteOptions {
  /** The written text (LF-normalized, BOM-stripped) — hashed, not retained. */
  readonly content?: string;
  readonly lineEndings?: LineEndings;
  readonly encoding?: BufferEncoding;
}

export class FileFreshnessLedger {
  // Map iteration order is insertion order: re-inserting on every touch keeps the
  // least recently used entry first.
  private readonly records = new Map<string, FileReadRecord>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = LEDGER_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  recordRead(path: string, input: RecordReadInput): void {
    const { content, ...rest } = input;
    this.put(path, { ...rest, ...(content !== undefined ? { contentHash: hashFileContent(content) } : {}) });
  }

  /** A successful write makes the writer the last reader. */
  recordWrite(path: string, version: FileVersion, options: RecordWriteOptions = {}): void {
    this.put(path, {
      version,
      fullRead: true,
      lineEndings: options.lineEndings ?? "LF",
      encoding: options.encoding ?? "utf8",
      readAt: Date.now(),
      ...(options.content !== undefined ? { contentHash: hashFileContent(options.content) } : {}),
    });
  }

  get(path: string): FileReadRecord | undefined {
    const record = this.records.get(path);
    if (record !== undefined) {
      this.records.delete(path);
      this.records.set(path, record);
    }
    return record;
  }

  private put(path: string, record: FileReadRecord): void {
    this.records.delete(path);
    this.records.set(path, record);
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  delete(path: string): void {
    this.records.delete(path);
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}

export interface CheckFreshnessInput {
  readonly ledger: FileFreshnessLedger;
  readonly path: string;
  readonly current: FileVersion;
  /**
   * Lazily supplies the current full content (LF-normalized, BOM-stripped) for
   * the content-review fallback. Edit passes the text it already read (free);
   * Write reads on demand — which only happens when the mtime moved or is
   * unavailable. Return undefined when the content cannot be produced.
   */
  readonly currentContent?: () => Promise<string | undefined>;
}

export async function checkFreshness(input: CheckFreshnessInput): Promise<FreshnessVerdict> {
  const record = input.ledger.get(input.path);
  if (record === undefined) return { kind: "not-read" };

  if (fileVersionsMatch(record.version, input.current)) return { kind: "fresh" };

  if (record.fullRead && record.contentHash !== undefined && input.currentContent !== undefined) {
    const currentText = await input.currentContent();
    if (currentText !== undefined && hashFileContent(currentText) === record.contentHash) return { kind: "fresh" };
  }

  return { kind: "stale" };
}
