import type { Message } from "../protocol/index.ts";
import type { PromptOrigin } from "../store/origin.ts";
import { customMessage, DEFAULT_ADDRESS, type SessionStore, type StoredAgentRecord } from "../store/store.ts";

/**
 * A session's transcript, read straight from its log — no `Session`, no capabilities, no run.
 *
 * WHAT HAPPENED, not what the model currently sees. The log is append-only, so a message the
 * compaction later summarized away is still there, in its own record; a transcript reader wants
 * exactly that. The model's current context (checkpoint + tail) is `SessionProjection`'s job.
 *
 * So only ORIGINALS are read: `context.append_message` and `custom_message`. The checkpoint
 * records repeat messages that already have their own record — `context.apply_compaction.kept`
 * and the trimmed history a `context.replace` commits — so taking them as well would show the same
 * message twice. A compaction surfaces as a marker item instead, where it happened.
 *
 * Pages run backwards from the newest record (a viewer opens on the latest messages and scrolls
 * up); the items of one page come back oldest first, ready to prepend. Cursors are the store's
 * record sequences, and the log is immutable below the newest record, so paging is race-free
 * however long the reader takes between pages.
 */

export interface TranscriptPageOptions {
  /** The conversation shard to read. Default `main`, the root agent; a subagent's transcript is
   *  read by its own address. */
  readonly address?: string;
  /** Items per page. Default 50, at most 500. */
  readonly limit?: number;
  /** Return items OLDER than this cursor: the previous page's `next`. Omit for the newest page. */
  readonly before?: string;
}

interface TranscriptItemBase {
  /** This item's record sequence — what a `before` names to read on from just above it. */
  readonly cursor: string;
  /** The durable event id, matching the live `message.appended` / `history.compacted` event. Absent
   *  on records written outside a session's event publisher. */
  readonly eventId?: string;
  readonly time?: number;
}

export interface TranscriptMessageItem extends TranscriptItemBase {
  readonly kind: "message";
  readonly message: Message;
  readonly origin?: PromptOrigin;
  /** A host-injected message (`custom_message`) that asked not to be displayed. It is in the
   *  model's context all the same; a viewer normally skips it. */
  readonly hidden?: true;
}

export interface TranscriptCompactionItem extends TranscriptItemBase {
  readonly kind: "compaction";
  /** What the summarized messages were replaced with in the model's context. */
  readonly summary: string;
  /** How many leading messages of the context at that point the summary replaced. */
  readonly compactedCount: number;
}

export type TranscriptItem = TranscriptMessageItem | TranscriptCompactionItem;

export interface TranscriptPage {
  /** Oldest first. */
  readonly items: readonly TranscriptItem[];
  /** Cursor for the next OLDER page — present only when at least one older item exists, so it
   *  never leads to an empty page. Absent once the start of the transcript is reached. */
  readonly next?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Records read per store page. Most records are not transcript items (lifecycle, usage), so
 *  scanning in larger strides than the item limit saves round trips. */
const SCAN_PAGE = 128;

function itemOf(stored: StoredAgentRecord): TranscriptItem | undefined {
  const { record, sequence } = stored;
  const base: TranscriptItemBase = {
    cursor: sequence,
    ...(record.eventId !== undefined ? { eventId: record.eventId } : {}),
    ...(record.time !== undefined ? { time: record.time } : {}),
  };
  switch (record.type) {
    case "context.append_message":
      return { ...base, kind: "message", message: record.message, ...(record.origin !== undefined ? { origin: record.origin } : {}) };
    case "custom_message":
      return {
        ...base,
        kind: "message",
        message: customMessage(record.content, record.time),
        ...(record.origin !== undefined ? { origin: record.origin } : {}),
        ...(record.display ? {} : { hidden: true as const }),
      };
    case "context.apply_compaction":
      return { ...base, kind: "compaction", summary: record.summary, compactedCount: record.compactedCount };
    default:
      return undefined;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("transcript page limit must be a positive integer");
  return Math.min(limit, MAX_LIMIT);
}

/** One page of a session's transcript, read from its store. See the module doc for what counts. */
export async function readTranscriptPage(store: SessionStore, options: TranscriptPageOptions = {}): Promise<TranscriptPage> {
  const limit = normalizeLimit(options.limit);
  const address = options.address ?? DEFAULT_ADDRESS;
  const newestFirst: TranscriptItem[] = [];
  let after = options.before;
  for (;;) {
    const page = await store.readRecordPage({ address, order: "desc", limit: SCAN_PAGE, ...(after !== undefined ? { after } : {}) });
    for (const stored of page.data) {
      const item = itemOf(stored);
      if (item === undefined) continue;
      // One item past the limit is read and dropped: it is what proves an older page exists, so
      // `next` never leads to an empty page.
      if (newestFirst.length === limit) {
        const oldest = newestFirst[newestFirst.length - 1]!;
        return { items: newestFirst.reverse(), next: oldest.cursor };
      }
      newestFirst.push(item);
    }
    if (page.next === undefined) return { items: newestFirst.reverse() };
    after = page.next;
  }
}
