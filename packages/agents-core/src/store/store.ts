import type { ImageContent, Message, TextContent, Usage } from "../protocol/index.ts";
import type { ExternalPromptOrigin, PromptOrigin } from "./origin.ts";

/**
 * A record in a session's append log. The log is a FLAT, linear, append-only stream
 * — NOT a tree. Each address has its own shard; a shard's
 * conversation context is its records read in append order and reduced (see `reduceHistory`).
 *
 * The first record of every shard is `metadata` (protocol version + creation time); the store
 * prepends it automatically on the first append (see `SessionStore.appendRecord`).
 */
export type AgentRecord = {
  readonly type: string;
  /** Public identity of the AgentEvent projected from this record. Records that have no
   *  AgentEvent projection (metadata/config/etc.) omit it. */
  readonly eventId?: string;
  /** Wall-clock stamp (ms). Set by the store if the writer omitted it. */
  readonly time?: number;
  /** Which conversation shard this record belongs to (defaults to `main`). */
  readonly address?: string;
} & AgentRecordBody;

export type AgentRecordBody =
  // The first record of a shard: pins the wire protocol version its log was written at.
  | { readonly type: "metadata"; readonly protocol_version: number; readonly created_at: number }
  // ── History-bearing (reduced into the model's context) ──
  // `origin`: structured provenance (user / injection / background_task / cron / compaction).
  // Reducers and UI routing read it instead of parsing rendered text.
  | { readonly type: "context.append_message"; readonly message: Message; readonly origin?: PromptOrigin }
  // The whole history was explicitly replaced — the reducer resets to this
  // list so a resumed context matches what the new agent saw live. Origins are parallel to
  // messages and optional for backward compatibility with older logs.
  | {
      readonly type: "context.replace";
      readonly messages: readonly Message[];
      readonly origins?: readonly (PromptOrigin | null)[];
    }
  // Compaction, anchored by a `cutoff` COUNT (not an entry id): the reducer drops the first
  // `cutoff` history messages and prepends the summary. A linear log has stable positions, so
  // a count is sufficient — no id-anchoring needed. Every model-visible context message,
  // including injections, is journaled, so live and replay use the same count.
  | {
      readonly type: "context.apply_compaction";
      readonly summary: string;
      /** Timestamp of the live summary message, so cold replay rebuilds it byte-for-byte. */
      readonly summaryTimestamp?: number;
      readonly cutoff: number;
      readonly compactedCount: number;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
    }
  // ── Inbox (accepted, not yet processed) ──
  // An externally delivered input, journaled the moment it is ACCEPTED — before any capability
  // rewrite, guardrail check, or run. It is the durable receipt behind a delivery's 202: once
  // this record has a sequence, the input survives a crash and a later run will pick it up.
  //
  // Deliberately NOT history-bearing. What the model ends up seeing is journaled separately as
  // `context.append_message`, because it can legitimately differ from what arrived: a capability
  // may rewrite the prompt, a guardrail may reject it outright, and a capability that answers
  // the prompt itself journals no message at all. Reducing this record into history would make
  // replay disagree with what the model actually saw.
  //
  // `origin.deliveryId` is the idempotency key: a re-processed inbox record whose delivery
  // already produced history is skipped rather than replayed into the model.
  | {
      readonly type: "inbox.received";
      readonly input: string;
      readonly origin: ExternalPromptOrigin;
      /** Delivery mode as accepted — `steer` targets a running turn, `follow_up` queues after it. */
      readonly mode: "auto" | "steer" | "follow_up";
    }
  // A host-injected message that should enter the model's context.
  | {
      readonly type: "custom_message";
      readonly customType: string;
      readonly content: string | (TextContent | ImageContent)[];
      readonly display: boolean;
      readonly details?: unknown;
      readonly origin?: PromptOrigin;
    }
  // ── Audit-only (NOT reduced into history) ──
  | {
      readonly type: "usage.record";
      readonly model?: string;
      /** Per-turn usage retained for audit/cost aggregation. */
      readonly usage: Usage;
      /** Run-total usage at this boundary, projected as `usage.updated`. */
      readonly total?: Usage;
    }
  | {
      readonly type: "permission.record_approval";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly decision: string;
      readonly feedback?: string;
      /** The approval-rule subject of the approved call — the pattern an
       *  `approve for session` grant memorizes. */
      readonly approvalRule?: string;
      /** "session" when the user granted approve-for-session; folded back into the
       *  session's approval-pattern set on reopen. */
      readonly scope?: string;
    }
  // Runtime permission-mode change: replayed on session open
  // so the mode survives restarts. Last record wins.
  | { readonly type: "permission.set_mode"; readonly mode: string }
  | {
      readonly type: "config.update";
      readonly model?: string;
      readonly thinking?: string;
      readonly tools?: readonly string[];
    }
  /** Durable commit record for transferring the conversation head to a new root shard. */
  | {
      readonly type: "agent.handoff";
      readonly from: string;
      readonly to: string;
      /** Absent on legacy audit-only records, which cannot move the durable conversation head. */
      readonly handoffId?: string;
      readonly toAddress?: string;
      readonly seedCount?: number;
    }
  /** Written to the target shard before the source-side `agent.handoff` commit record. */
  | {
      readonly type: "agent.handoff.accepted";
      readonly handoffId: string;
      readonly from: string;
      readonly to: string;
      readonly fromAddress: string;
      readonly seedCount: number;
    }
  | {
      readonly type: "guardrail.blocked";
      readonly stage: "input" | "output" | "tool_input" | "tool_output";
      readonly guardrail: string;
      readonly agent?: string;
      readonly turnId?: string;
      readonly step?: number;
      readonly stepId?: string;
      readonly message: string;
      /** Present only when a newly submitted input was rejected before entering model history. */
      readonly input?: readonly Message[];
    }
  /** Low-frequency lifecycle needed to reconstruct current UI state from events.list().
   *  Token deltas and tool progress remain live-only; message/tool payloads continue to live
   *  in their canonical context records instead of being duplicated here. */
  | { readonly type: "event.lifecycle"; readonly event: import("../events/events.ts").PersistedLifecycleEvent }
  | { readonly type: "custom"; readonly name: string; readonly data: unknown };

/**
 * THE STORAGE RULE — what lives where:
 *
 * - The append log (①) is the record for CONVERSATION-derived state. Anything whose loss
 *   loses conversation information — history, audit — is a record, and its current-state
 *   views are REDUCTIONS of it (a forward pass over the shard's records).
 * - BACKGROUND-TASK lifecycle is the one deliberate exception: a background task's status
 *   (running → completed/failed/lost) lives in a dedicated per-task store, NOT a reduction of
 *   the log — disk sessions keep it under `<sessionDir>/tasks/<id>/`, other backends in KV
 *   state (see capabilities/background/persist.ts). This is what lets a task orphaned by a dead
 *   process be reconciled to `lost` on reopen. The spawn ack + settle notification stay in the
 *   log as the model-facing conversation record, but are no longer the reconcile source of
 *   truth. `session.listSubagents()`/`listWorkflows()` PROJECT that task store — a foreground
 *   subagent/workflow is a plain tool call (conversation + its own shard), never a task.
 * - KV state (②) may hold only (a) handles to external systems (`machine`), (b)
 *   rebuildable foreground control state (`interrupt`), (c) capability current-state (goal/plan/permission/
 *   config/cron/subagents), and (d) the background task store on non-disk backends. If deleting
 *   a KV key would lose information not recoverable elsewhere, that information belonged in the
 *   log or the task store.
 * - The Machine filesystem holds work products (process logs, plan drafts) —
 *   cache-grade relative to the log; harvest what must outlive it into a record.
 * - Pure runtime (live output tails) is not storage at all: its durable record is the
 *   entity it drives.
 */
export type StateKey = "interrupt" | "meta" | "machine" | "cron" | (string & {});

export interface ReadRecordsFilter {
  readonly address?: string;
}

/** One durable append-log record together with its store-assigned position.
 *  `sequence` is stable for the lifetime of the session: rewrites may migrate or
 *  offload `record`, but must never renumber it. Gaps are valid. */
export interface StoredAgentRecord {
  readonly sequence: string;
  readonly record: AgentRecord;
}

export type RecordOrder = "asc" | "desc";

/** Cursor pagination over the session-wide append order. `after` is exclusive and
 *  interpreted in the requested traversal direction (`>` for asc, `<` for desc). */
export interface ReadRecordPageOptions extends ReadRecordsFilter {
  readonly limit: number;
  readonly after?: string;
  readonly order?: RecordOrder;
}

export interface RecordPage {
  readonly data: readonly StoredAgentRecord[];
  /** Sequence of the last returned record when another page exists. */
  readonly next?: string;
}

export interface WatchRecordsOptions {
  /** Resume after this sequence. Omit to start from the beginning of the log. */
  readonly after?: string;
  readonly address?: string;
  /** Stop watching. The iterable ends; it does not throw. */
  readonly signal?: AbortSignal;
  /** Idle delay between polls for the generic implementation. Ignored by push backends. */
  readonly pollMs?: number;
}

export interface SessionStore {
  // ① append log (linear, immutable). `appendRecord` appends to the shard named by
  // `record.address` (defaulting to `main`); when the shard is empty, the store first prepends
  // a `metadata` record stamping the current wire version.
  appendRecord(record: AgentRecord): Promise<string>;
  readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord>;
  readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage>;
  // ② KV current-state (mutable, overwritten).
  putState(key: StateKey, value: unknown): Promise<void>;
  getState(key: StateKey): Promise<unknown | null>;
  deleteState(key: StateKey): Promise<void>;
  /** Every key currently present in ② (optional; all in-repo backends implement it). Lets a
   *  generic fork copy the FULL state instead of a hardcoded key list — without it, fork
   *  falls back to the known-handles subset and backend-specific keys (bg:*, goal, …) are lost. */
  listStateKeys?(): Promise<readonly StateKey[]>;
  /**
   * Follow the log from `after` onwards, yielding records as they land (optional).
   *
   * A reader that is not the writer — an out-of-process transport tailing a session, or a runner
   * looking for sessions with unprocessed input — otherwise has to poll `readRecordPage` itself.
   * `watchRecords` is the generic form of that loop, so every backend has one for free; a backend
   * with a native push (Postgres `LISTEN/NOTIFY`, a Redis stream) overrides it to avoid the
   * polling interval entirely.
   *
   * NOT a delivery channel for live UI. Fan-out to connected clients belongs in a broadcast path
   * the writer publishes to; a store is the source of truth, and using it as a message bus makes
   * its read load scale with connected viewers rather than with data.
   */
  watch?(options: WatchRecordsOptions): AsyncIterable<StoredAgentRecord>;
  // ③ durability (optional). `flush` forces pending writes to disk; `close` flushes and
  // releases resources; `rewrite` re-emits a shard's log compactly (current wire version +
  // blob-offloaded + torn-line free).
  flush?(): Promise<void>;
  close?(): Promise<void>;
  rewrite?(address?: string): Promise<void>;
  /** The filesystem directory this store is backed by, when it has one (disk sessions).
   *  Lets adjuncts that want a real directory — e.g. the background task store's
   *  `<dir>/tasks/<id>/` layout — co-locate under the session's home; undefined for
   *  in-memory / remote-KV backends, which fall back to KV-state persistence. */
  storageDir?(): string | undefined;
}

export const DEFAULT_ADDRESS = "main";

interface ReducedHistory {
  readonly messages: Message[];
  readonly origins: (PromptOrigin | undefined)[];
}

/**
 * Reduce a shard's records (append order) into live history, in a single forward pass.
 *
 * History-bearing records (`context.append_message` / `custom_message`) append a message;
 * `context.replace` resets the list; `context.apply_compaction` drops the first `cutoff`
 * messages and prepends the summary. Everything else (metadata / usage / approval / config /
 * handoff / custom) is audit/bookkeeping and never enters history.
 */
/**
 * The mutable pair every history fold maintains. `origins[i]` describes `messages[i]`.
 *
 * Exists so replay (folding RECORDS) and any live consumer (folding EVENTS) can share the
 * three operations below rather than each implementing history semantics. They are the same
 * semantics reached through two different doors; implemented twice they drift, and the drift
 * shows up as "the transcript changed after a reopen" — the hardest kind to notice.
 */
export interface HistoryFold {
  messages: Message[];
  origins: (PromptOrigin | undefined)[];
}

/** Append one message. */
export function foldAppend(state: HistoryFold, message: Message, origin?: PromptOrigin): void {
  state.messages.push(message);
  state.origins.push(origin);
}

/** Reset the list to `messages` (micro-compaction's trim commits through this). */
export function foldReplace(
  state: HistoryFold,
  messages: readonly Message[],
  origins?: readonly (PromptOrigin | null)[],
): void {
  state.messages.splice(0, state.messages.length, ...messages);
  const next = origins?.map((origin) => origin ?? undefined) ?? messages.map(() => undefined);
  state.origins.splice(0, state.origins.length, ...next.slice(0, messages.length));
  while (state.origins.length < state.messages.length) state.origins.push(undefined);
}

/** Drop the first `cutoff` messages and prepend the summary in their place. */
export function foldCompaction(state: HistoryFold, cutoff: number, summary: string, summaryTimestamp?: number): void {
  const clamped = Math.min(cutoff, state.messages.length);
  state.messages.splice(0, clamped, summaryMessage(summary, summaryTimestamp));
  state.origins.splice(0, clamped, { kind: "compaction_summary" });
}

export function reduceHistory(records: readonly AgentRecord[]): ReducedHistory {
  const state: HistoryFold = { messages: [], origins: [] };
  const { messages, origins } = state;
  for (const record of records) {
    switch (record.type) {
      case "context.append_message":
        foldAppend(state, record.message, record.origin);
        break;
      case "custom_message":
        foldAppend(state, customMessage(record.content, record.time), record.origin);
        break;
      case "context.replace":
        foldReplace(state, record.messages, record.origins);
        break;
      case "context.apply_compaction":
        foldCompaction(state, record.cutoff, record.summary, record.summaryTimestamp);
        break;
      // Audit / bookkeeping — not reduced into history.
      // `inbox.received` is the accepted input, not the seen input: what the model saw is
      // journaled as `context.append_message` after capabilities and guardrails have had
      // their say. Folding it here would double-count, or resurrect a rejected prompt.
      case "inbox.received":
      case "metadata":
      case "usage.record":
      case "permission.record_approval":
      case "permission.set_mode":
      case "config.update":
      case "agent.handoff":
      case "agent.handoff.accepted":
      case "guardrail.blocked":
      case "event.lifecycle":
      case "custom":
        break;
      default: {
        const exhaustive: never = record;
        throw new Error(`reduceHistory: unhandled AgentRecord type ${String((exhaustive as AgentRecord).type)}`);
      }
    }
  }
  return { messages, origins };
}

export function summaryMessage(summary: string, timestamp: number = Date.now()): Message {
  return {
    role: "user",
    content: [{ type: "text", text: `<context-summary>\n${summary}\n</context-summary>` }],
    timestamp,
  };
}

export function customMessage(
  content: string | (TextContent | ImageContent)[],
  timestamp: number = Date.now(),
): Message {
  return {
    role: "user",
    content: typeof content === "string" ? [{ type: "text", text: content }] : [...content],
    timestamp,
  };
}

/**
 * Follow a store's log by polling — the generic `SessionStore.watch` every backend inherits.
 *
 * Drains everything already past `after` before waiting, so a watcher that starts on a busy
 * session catches up at page speed rather than one poll interval per page. Sequences are
 * allocated monotonically and the log is append-only, so the cursor never needs to move
 * backwards and a record is never yielded twice.
 *
 * Prefer a backend's native push where one exists: this trades latency (up to `pollMs`) and a
 * steady query rate for working anywhere.
 */
export async function* watchRecordsByPolling(
  store: SessionStore,
  options: WatchRecordsOptions = {},
): AsyncIterable<StoredAgentRecord> {
  const pollMs = options.pollMs ?? 250;
  const pageSize = 256;
  // A function, not a captured boolean: `aborted` flips during the awaits below, and reading it
  // through a narrowed local would freeze it at its value on entry.
  const aborted = (): boolean => options.signal?.aborted === true;
  let cursor = options.after;
  while (!aborted()) {
    const page = await store.readRecordPage({
      limit: pageSize,
      ...(cursor !== undefined ? { after: cursor } : {}),
      ...(options.address !== undefined ? { address: options.address } : {}),
    });
    for (const stored of page.data) {
      if (aborted()) return;
      cursor = stored.sequence;
      yield stored;
    }
    // A full page means more is already there; keep draining before idling.
    if (page.data.length === pageSize) continue;
    if (aborted()) return;
    await sleep(pollMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
