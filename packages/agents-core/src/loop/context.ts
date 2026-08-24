import type { Message } from "../protocol/index.ts";
import type { PromptOrigin } from "../store/origin.ts";
import {
  type AgentRecord,
  type AgentRecordBody,
  DEFAULT_ADDRESS,
  reduceHistory,
  type SessionStore,
  summaryMessage,
} from "../store/store.ts";

export { summaryMessage } from "../store/store.ts";

export interface CompactionApply {
  readonly summary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/**
 * Called for EVERY journaled history mutation, in the same synchronous block as the mutation.
 *
 * This exists so journaling and broadcasting are one act instead of two. Before it, each call
 * site had to remember to emit an event next to its mutation — and three times it didn't:
 * `injectAtTurnBoundary` skipped `message.appended`, `replaceHistory` emitted nothing at all,
 * and `applyCompaction`'s event carried counts but not enough to reproduce the splice. The
 * shape of that bug is always the same: the hand that writes the log and the hand that
 * broadcasts are two hands.
 *
 * MUST be synchronous. A consumer folding these into state (see `SessionProjection`) relies on
 * mutation-and-notify being one uninterrupted block; an `await` in here reopens exactly the
 * race the projection exists to remove.
 */
export type HistoryChangeListener = (record: AgentRecord) => void;

export interface ConversationContextOptions {
  readonly store?: SessionStore;
  readonly address?: string;
  readonly history?: readonly Message[];
  /** See {@link HistoryChangeListener}. Independent of `store`: a storeless context still
   *  broadcasts, because observability must not depend on persistence being configured. */
  readonly onHistoryChange?: HistoryChangeListener;
}

export class ConversationContext {
  private readonly _history: Message[];
  private readonly store?: SessionStore;
  private readonly onHistoryChange?: HistoryChangeListener;
  readonly address: string;
  /** Runtime provenance for live messages; replay rebuilds it from record origins. */
  private readonly origins = new WeakMap<Message, PromptOrigin>();
  private writeChain: Promise<void> = Promise.resolve();
  /** Errors from failed appendRecord calls, surfaced (and cleared) on the next flush(). */
  private writeErrors: unknown[] = [];

  constructor(options: ConversationContextOptions = {}) {
    this.store = options.store;
    this.onHistoryChange = options.onHistoryChange;
    this.address = options.address ?? DEFAULT_ADDRESS;
    this._history = [];
    if (options.history) this.seed(options.history);
  }

  get history(): readonly Message[] {
    return this._history;
  }

  /** Live model-visible history. READONLY on purpose: every mutation must go through
   *  `appendMessage`/`replaceHistory`/`applyCompaction` so it is journaled — pushing into
   *  this array directly would silently diverge the live context from what replay
   *  reconstructs (the same live-vs-durable split the shard log exists to prevent). */
  get messages(): readonly Message[] {
    return this._history;
  }

  seed(messages: readonly Message[]): void {
    for (const message of messages) this.appendMessage(message);
  }

  // The three history mutators. Each applies the change to live state FIRST and journals
  // second, so that by the time `onHistoryChange` fires (inside `journal`) this context
  // already reads as the new state — matching the order call sites used to emit in by hand.

  appendMessage(message: Message, origin?: PromptOrigin): void {
    this._history.push(message);
    if (origin !== undefined) this.origins.set(message, origin);
    this.journal({ type: "context.append_message", message, origin });
  }

  applyCompaction(c: CompactionApply): void {
    // Every model-visible message is journaled, so replay drops the same prefix count as live.
    const summary = summaryMessage(c.summary);
    this._history.splice(0, c.compactedCount, summary);
    this.origins.set(summary, { kind: "compaction_summary" });
    this.journal({
      type: "context.apply_compaction",
      summary: c.summary,
      // Pinned so the summary message replay builds is identical to this one.
      summaryTimestamp: summary.timestamp,
      cutoff: c.compactedCount,
      compactedCount: c.compactedCount,
      tokensBefore: c.tokensBefore,
      tokensAfter: c.tokensAfter,
    });
  }

  replaceHistory(messages: readonly Message[]): void {
    const origins = messages.map((message) => this.origins.get(message) ?? null);
    this._history.splice(0, this._history.length, ...messages);
    this.journal({
      type: "context.replace",
      messages: [...messages],
      ...(origins.some((origin) => origin !== null) ? { origins } : {}),
    });
  }

  originOf(message: Message): PromptOrigin | undefined {
    return this.origins.get(message);
  }

  record(body: AgentRecordBody): void {
    this.journal(body);
  }

  /**
   * Wait for all journaled records to finish writing. Throws (once) if any write in the
   * batch since the last flush failed — a failed record is never silently dropped from
   * this check, even though the chain itself keeps moving so later records still get their
   * own write attempt (see `journal`).
   */
  async flush(): Promise<void> {
    await this.writeChain;
    if (this.writeErrors.length > 0) {
      const errors = this.writeErrors.splice(0, this.writeErrors.length);
      throw new AggregateError(errors, `${String(errors.length)} record(s) failed to persist to the session store`);
    }
  }

  /** Replace live state from a shard's records, WITHOUT re-journaling (resume). */
  loadFromRecords(records: readonly AgentRecord[]): void {
    const { messages, origins } = reduceHistory(records);
    this._history.splice(0, this._history.length, ...messages);
    for (let i = 0; i < messages.length; i++) {
      const origin = origins[i];
      if (origin !== undefined) this.origins.set(messages[i]!, origin);
    }
  }

  private journal(body: AgentRecordBody): void {
    const record: AgentRecord = { time: Date.now(), address: this.address, ...body };
    // Storeless contexts broadcast here. Stored contexts normally omit this listener: their
    // publication-aware SessionStore turns this same record into the event, immediately or
    // after commit according to the session policy.
    this.onHistoryChange?.(record);
    if (this.store === undefined) return;
    const store = this.store;
    // Start the append synchronously. A publication-aware store uses this exact call boundary
    // to emit immediately (local mode) or enqueue append→emit atomically (managed mode). The
    // chain below remains the flush/error ledger; store implementations own append ordering.
    const write = store.appendRecord(record);
    this.writeChain = this.writeChain.then(async () => {
      await write.catch((error: unknown) => {
        this.writeErrors.push(error);
      });
    });
  }
}

export async function replayContext(
  store: SessionStore,
  address?: string,
  onHistoryChange?: HistoryChangeListener,
): Promise<ConversationContext> {
  // The listener is wired but deliberately not fired for the replayed records: `loadFromRecords`
  // bypasses `journal`, because replaying is not a new history change — a consumer that seeded
  // itself from the same log would otherwise see every message twice.
  const ctx = new ConversationContext({ store, address, ...(onHistoryChange !== undefined ? { onHistoryChange } : {}) });
  const records: AgentRecord[] = [];
  for await (const record of store.readRecords({ address })) records.push(record);
  ctx.loadFromRecords(records);
  return ctx;
}
