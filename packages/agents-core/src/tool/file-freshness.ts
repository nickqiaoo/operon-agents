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
 * matches, the file is fresh with zero extra I/O. Content comparison — against the
 * retained prior text, no hashing — runs only when the mtime moved (false-positive
 * review: cloud sync / antivirus / Windows) or is unavailable (mtime-less sandbox
 * backends).
 */
import type { FileVersion, LineEndings } from "./machine.ts";
// Same predicate the Machine-side check uses (BaseMachine.assertUnchanged) — the two
// run at different moments and must never disagree about what "unchanged" means.
import { fileVersionsMatch } from "./support/machine-ops.ts";

/**
 * Above this, content is not retained (version-only record) — freshness then degrades to
 * conservative-stale on mtime change.
 *
 * It bounds the WRITE path, not the read path. A read can only retain content when it read
 * the file whole, which the Read tool's own output caps already keep far below this. A write
 * has no such ceiling: `recordWrite` retains whatever the model just produced, and nothing
 * stops that from being a multi-megabyte generated file.
 */
export const CONTENT_RETENTION_MAX_BYTES = 10 * 1024 * 1024;

export const FILE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
export const FILE_MODIFIED_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current; refer to that instead of re-reading.";

export interface FileReadRecord {
  readonly version: FileVersion;
  /** Full text (LF-normalized, BOM-stripped) retained for full reads within the size cap. */
  readonly content?: string;
  /** True when the read had no offset/limit. Partial reads never pass content review. */
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

export interface RecordWriteOptions {
  readonly content?: string;
  readonly lineEndings?: LineEndings;
  readonly encoding?: BufferEncoding;
}

function clampContent(record: FileReadRecord): FileReadRecord {
  if (record.content === undefined) return record;
  if (Buffer.byteLength(record.content, "utf8") <= CONTENT_RETENTION_MAX_BYTES) return record;
  const { content: _dropped, ...rest } = record;
  return rest;
}

export class FileFreshnessLedger {
  private readonly records = new Map<string, FileReadRecord>();

  recordRead(path: string, record: FileReadRecord): void {
    this.records.set(path, clampContent(record));
  }

  /** A successful write makes the writer the last reader. */
  recordWrite(path: string, version: FileVersion, options: RecordWriteOptions = {}): void {
    this.records.set(
      path,
      clampContent({
        version,
        fullRead: true,
        lineEndings: options.lineEndings ?? "LF",
        encoding: options.encoding ?? "utf8",
        readAt: Date.now(),
        ...(options.content !== undefined ? { content: options.content } : {}),
      }),
    );
  }

  get(path: string): FileReadRecord | undefined {
    return this.records.get(path);
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

  if (record.fullRead && record.content !== undefined && input.currentContent !== undefined) {
    const currentText = await input.currentContent();
    if (currentText !== undefined && currentText === record.content) return { kind: "fresh" };
  }

  return { kind: "stale" };
}
