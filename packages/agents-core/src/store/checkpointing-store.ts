import { SessionProjection } from "../events/projection.ts";
import {
  type AgentRecord,
  AUDIT_ADDRESS,
  isCheckpointRecord,
  DEFAULT_ADDRESS,
  type ReadRecordPageOptions,
  type ReadRecordsFilter,
  type RecordPage,
  type SessionStore,
  type StateKey,
  type StoredAgentRecord,
  type WatchRecordsOptions,
} from "./store.ts";

/**
 * Stamps every history checkpoint a session writes with the shard's lifecycle at that instant
 * (`#frame`: agent, open turn, queued steers — see `FrameCheckpoint`).
 *
 * The stamp happens inside `appendRecord`, which a `ConversationContext` calls synchronously in
 * the same block as the history reset — so it is of exactly the lifecycle every record before
 * the checkpoint produced, and of nothing after it. Doing it here rather than in each context
 * means no context, wherever it is built, can write a checkpoint without it. A record that
 * already carries `checkpoint` passes through untouched.
 *
 * The lifecycle is folded here from every record that passes through: this store sits UNDER the
 * event publisher, so the lifecycle records the publisher journals pass through it too, in
 * exactly the order they reach the log. Session and capability state are not stamped — they are
 * kept as current values in the store's key/value side (see `CapabilityDurableState`).
 */
export class CheckpointingSessionStore implements SessionStore {
  private readonly inner: SessionStore;
  /** The lifecycle side of every shard written or restored in this process, without history. */
  private readonly frames: SessionProjection;
  readonly listStateKeys?: () => Promise<readonly StateKey[]>;
  readonly watch?: (options: WatchRecordsOptions) => AsyncIterable<StoredAgentRecord>;
  readonly flush?: () => Promise<void>;
  readonly close?: () => Promise<void>;
  readonly rewrite?: (address?: string) => Promise<void>;
  readonly storageDir?: () => string | undefined;

  constructor(inner: SessionStore, sessionId: string) {
    this.inner = inner;
    this.frames = new SessionProjection(sessionId, { history: false });
    if (inner.listStateKeys !== undefined) this.listStateKeys = () => inner.listStateKeys!();
    if (inner.watch !== undefined) this.watch = (options) => inner.watch!(options);
    if (inner.flush !== undefined) this.flush = () => inner.flush!();
    if (inner.close !== undefined) this.close = () => inner.close!();
    if (inner.rewrite !== undefined) this.rewrite = (address) => inner.rewrite!(address);
    if (inner.storageDir !== undefined) this.storageDir = () => inner.storageDir!();
  }

  /**
   * Fold a shard's records read back from the log (from its checkpoint on, or whole) into the
   * lifecycle state, before this process writes to it again. A shard already folded here is
   * left alone: what this process wrote is newer than anything it could read.
   */
  restoreFrame(address: string, records: readonly AgentRecord[]): void {
    if (this.frames.has(address)) return;
    for (const record of records) {
      if ((record.address ?? DEFAULT_ADDRESS) === address) this.frames.applyRecord(record);
    }
  }

  appendRecord(record: AgentRecord): Promise<string> {
    // The audit shard has no lifecycle to fold, and no checkpoint is ever written to it.
    if (record.address === AUDIT_ADDRESS) return this.inner.appendRecord(record);
    if (!isCheckpointRecord(record) || record.checkpoint !== undefined) {
      this.frames.applyRecord(record);
      return this.inner.appendRecord(record);
    }
    const address = record.address ?? DEFAULT_ADDRESS;
    const stamped = { ...record, checkpoint: { "#frame": this.frames.frameCheckpoint(address) } };
    this.frames.applyRecord(stamped);
    return this.inner.appendRecord(stamped);
  }

  readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    return this.inner.readRecords(filter);
  }

  readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage> {
    return this.inner.readRecordPage(options);
  }

  putState(key: StateKey, value: unknown): Promise<void> {
    return this.inner.putState(key, value);
  }

  getState(key: StateKey): Promise<unknown | null> {
    return this.inner.getState(key);
  }

  deleteState(key: StateKey): Promise<void> {
    return this.inner.deleteState(key);
  }
}
