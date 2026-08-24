import assert from "node:assert/strict";
import {
  agentEventFromRecord,
  ListenerSink,
  SessionEventPublisher,
  type AgentEvent,
} from "../events/index.ts";
import {
  MemoryStore,
  type AgentRecord,
  type ReadRecordPageOptions,
  type ReadRecordsFilter,
  type RecordPage,
  type SessionStore,
  type StateKey,
} from "../store/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

class GatedStore implements SessionStore {
  readonly inner = new MemoryStore();
  private releaseAppend!: () => void;
  private failNext = false;
  private gate = new Promise<void>((resolve) => (this.releaseAppend = resolve));

  release(): void {
    this.releaseAppend();
  }

  rejectNext(): void {
    this.failNext = true;
    this.release();
  }

  async appendRecord(record: AgentRecord): Promise<string> {
    await this.gate;
    if (this.failNext) throw new Error("append failed");
    return this.inner.appendRecord(record);
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

class RejectFirstStore extends GatedStore {
  private calls = 0;

  override async appendRecord(record: AgentRecord): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("first failed");
    return this.inner.appendRecord(record);
  }
}

function messageRecord(text: string): AgentRecord {
  return {
    type: "context.append_message",
    address: "main",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

// committed: a later live-only event cannot overtake a durable append, and list/stream
// reconstruct exactly the same public event identity.
{
  const inner = new GatedStore();
  const sink = new ListenerSink();
  const seen: AgentEvent[] = [];
  sink.subscribe((event) => seen.push(event));
  const publisher = new SessionEventPublisher("s-committed", sink, inner, "committed");
  const append = publisher.store!.appendRecord(messageRecord("hello"));
  const live = publisher.emit({
    type: "warning",
    message: "after",
    address: "main",
    sessionId: "s-committed",
  });
  await Promise.resolve();
  check("committed: nothing is visible before append commits", seen.length === 0);
  inner.release();
  await Promise.all([append, live]);
  check("committed: durable then live-only order is preserved", seen.map((event) => event.type).join(",") === "message.appended,warning");
  const page = await inner.inner.readRecordPage({ limit: 10, order: "asc" });
  const stored = page.data.find((item) => item.record.type === "context.append_message")!;
  const historical = agentEventFromRecord(stored.record, "s-committed")!;
  check("committed: list/stream share eventId", historical.eventId === seen[0]!.eventId);
}

// immediate: local observers see the record projection without waiting for storage latency.
{
  const inner = new GatedStore();
  const sink = new ListenerSink();
  const seen: AgentEvent[] = [];
  sink.subscribe((event) => seen.push(event));
  const publisher = new SessionEventPublisher("s-immediate", sink, inner, "immediate");
  const append = publisher.store!.appendRecord(messageRecord("hello"));
  await Promise.resolve();
  check("immediate: event is visible while append is pending", seen[0]?.type === "message.appended");
  inner.release();
  await append;
}

// committed: failed persistence never leaks an event that events.list cannot recover.
{
  const inner = new GatedStore();
  const sink = new ListenerSink();
  const seen: AgentEvent[] = [];
  sink.subscribe((event) => seen.push(event));
  const publisher = new SessionEventPublisher("s-failure", sink, inner, "committed");
  const append = publisher.store!.appendRecord(messageRecord("lost"));
  inner.rejectNext();
  await assert.rejects(append, /append failed/);
  await publisher.flush();
  check("committed: failed append emits no phantom event", seen.length === 0);
}

// A failed committed operation must not poison the ordered queue: later work still persists
// and becomes visible.
{
  const inner = new RejectFirstStore();
  const sink = new ListenerSink();
  const seen: AgentEvent[] = [];
  sink.subscribe((event) => seen.push(event));
  const publisher = new SessionEventPublisher("s-recover", sink, inner, "committed");
  await assert.rejects(publisher.store!.appendRecord(messageRecord("first")), /first failed/);
  await publisher.store!.appendRecord(messageRecord("second"));
  await publisher.flush();
  check("committed: queue continues after a failed append", seen.length === 1 && seen[0]?.type === "message.appended");
}

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
