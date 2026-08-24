import { redactDeep, type RedactOptions } from "../logging/redact.ts";
import type {
  AgentRecord,
  ReadRecordPageOptions,
  ReadRecordsFilter,
  RecordPage,
  SessionStore,
  StateKey,
} from "./store.ts";

export interface RedactingStoreOptions extends RedactOptions {
  readonly redactState?: boolean;
}

export class RedactingSessionStore implements SessionStore {
  private readonly inner: SessionStore;
  private readonly options: RedactingStoreOptions;

  constructor(inner: SessionStore, options: RedactingStoreOptions = {}) {
    this.inner = inner;
    this.options = options;
  }

  appendRecord(record: AgentRecord): Promise<string> {
    return this.inner.appendRecord(redactRecord(record, this.options));
  }

  readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    // Records were redacted on the way in, so the inner store already holds safe data.
    return this.inner.readRecords(filter);
  }

  readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage> {
    return this.inner.readRecordPage(options);
  }

  async putState(key: StateKey, value: unknown): Promise<void> {
    await this.inner.putState(key, this.options.redactState ? redactDeep(value, this.options) : value);
  }

  getState(key: StateKey): Promise<unknown | null> {
    return this.inner.getState(key);
  }

  deleteState(key: StateKey): Promise<void> {
    return this.inner.deleteState(key);
  }

  flush(): Promise<void> {
    return this.inner.flush?.() ?? Promise.resolve();
  }

  close(): Promise<void> {
    return this.inner.close?.() ?? Promise.resolve();
  }

  rewrite(address?: string): Promise<void> {
    return this.inner.rewrite?.(address) ?? Promise.resolve();
  }

  storageDir(): string | undefined {
    return this.inner.storageDir?.();
  }
}

function redactRecord(record: AgentRecord, options: RedactOptions): AgentRecord {
  const { type, eventId, time, address, ...body } = record;
  const safeBody = redactDeep(body, options);
  return { type, eventId, time, address, ...(safeBody as object) } as AgentRecord;
}
