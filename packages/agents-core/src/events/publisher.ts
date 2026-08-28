import type { AgentRecord, ReadRecordPageOptions, ReadRecordsFilter, RecordPage, SessionStore, StateKey } from "../store/store.ts";
import { customMessage, DEFAULT_ADDRESS } from "../store/store.ts";
import type {
  AgentEvent,
  AgentEventBody,
  AgentEventInput,
  AgentEventListener,
  EventSink,
  WorkflowAgentRecord,
  WorkflowProgressEvent,
} from "./events.ts";
import { newAgentEventId, normalizeAgentEvent } from "./events.ts";

export type EventPublicationMode = "immediate" | "committed";

/**
 * The one event publication boundary for a Session.
 *
 * `immediate` keeps the local/TUI latency profile: a projectable record is emitted before its
 * append settles. `committed` serializes live-only events and record appends through one queue;
 * a projectable record becomes visible only after the store assigned its sequence. Therefore
 * Projection, RunHandle and transports all see the same ordered, committed stream.
 */
export class SessionEventPublisher implements EventSink {
  readonly sessionId: string;
  readonly mode: EventPublicationMode;
  readonly store?: SessionStore;
  private readonly sink: EventSink;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    sessionId: string,
    sink: EventSink,
    innerStore: SessionStore | undefined,
    mode: EventPublicationMode = "immediate",
  ) {
    this.sessionId = sessionId;
    this.sink = sink;
    this.mode = mode;
    this.store = innerStore === undefined ? undefined : new PublishingSessionStore(innerStore, this);
  }

  emit(input: AgentEventInput): Promise<void> {
    const event = normalizeAgentEvent(input);
    if (this.store !== undefined && isPersistedLifecycleEvent(event)) {
      const write = this.store.appendRecord({
        type: "event.lifecycle",
        eventId: event.eventId,
        time: Date.now(),
        address: event.address,
        event: lifecycleBody(event),
      }).then(() => undefined);
      // Most emitters do not await. A refused write — a fenced store telling a stale holder to
      // stop — must reach a caller that awaits, and must not take the process down for one
      // that does not: the run's own history writes fail the same way, and those are awaited.
      write.catch(() => undefined);
      return write;
    }
    if (this.mode === "immediate") return this.emitSafely(event);
    return this.enqueue(() => this.emitSafely(event));
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.sink.subscribe(listener);
  }

  child(addressSegment: string): EventSink {
    return new PublisherAddressProxy(this, addressSegment);
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  appendRecord(inner: SessionStore, input: AgentRecord): Promise<string> {
    // Stamp before projection so immediate delivery and the eventually stored record have the
    // same timestamp as well as the same eventId (stores normally stamp time internally).
    const stamped: AgentRecord = input.time === undefined ? { ...input, time: Date.now() } : input;
    const eventId = projectableEventBody(stamped) === undefined ? undefined : stamped.eventId ?? newAgentEventId();
    const record: AgentRecord = eventId === undefined ? stamped : { ...stamped, eventId };
    const event = agentEventFromRecord(record, this.sessionId);

    if (this.mode === "immediate") {
      if (event !== undefined) void this.emitSafely(event);
      // Preserve one session-wide append order even for third-party stores that do not
      // serialize concurrent callers themselves. Live publication still bypasses this queue.
      return this.enqueue(() => inner.appendRecord(record));
    }

    return this.enqueue(async () => {
      const sequence = await inner.appendRecord(record);
      if (event !== undefined) await this.emitSafely(event);
      return sequence;
    });
  }

  private emitSafely(event: AgentEvent): Promise<void> {
    // A broken observer must never turn a successful durable append into a failed write.
    return Promise.resolve(this.sink.emit(event)).catch(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}

class PublisherAddressProxy implements EventSink {
  private readonly parent: SessionEventPublisher;
  private readonly segment: string;

  constructor(parent: SessionEventPublisher, segment: string) {
    this.parent = parent;
    this.segment = segment;
  }

  emit(event: AgentEventInput): void | Promise<void> {
    const address = event.address && event.address !== this.segment
      ? `${this.segment}/${event.address}`
      : this.segment;
    return this.parent.emit({ ...event, address });
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.parent.subscribe(listener);
  }

  child(addressSegment: string): EventSink {
    return new PublisherAddressProxy(this.parent, `${this.segment}/${addressSegment}`);
  }
}

class PublishingSessionStore implements SessionStore {
  private readonly inner: SessionStore;
  private readonly publisher: SessionEventPublisher;
  readonly listStateKeys?: () => Promise<readonly StateKey[]>;
  readonly rewrite?: (address?: string) => Promise<void>;
  readonly storageDir?: () => string | undefined;

  constructor(inner: SessionStore, publisher: SessionEventPublisher) {
    this.inner = inner;
    this.publisher = publisher;
    if (inner.listStateKeys !== undefined) this.listStateKeys = () => inner.listStateKeys!();
    if (inner.rewrite !== undefined) this.rewrite = (address) => inner.rewrite!(address);
    if (inner.storageDir !== undefined) this.storageDir = () => inner.storageDir!();
  }

  appendRecord(record: AgentRecord): Promise<string> {
    return this.publisher.appendRecord(this.inner, record);
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

  async flush(): Promise<void> {
    await this.publisher.flush();
    await this.inner.flush?.();
  }

  async close(): Promise<void> {
    await this.publisher.flush();
    await this.inner.close?.();
  }

}

/** Lossless durable-record projection shared by publication and managed `events.list()`. */
export function agentEventFromRecord(record: AgentRecord, sessionId: string): AgentEvent | undefined {
  if (record.eventId === undefined) return undefined;
  const body = projectableEventBody(record);
  if (body === undefined) return undefined;
  return normalizeAgentEvent({
    ...body,
    eventId: record.eventId,
    address: record.address ?? DEFAULT_ADDRESS,
    sessionId,
  });
}

function projectableEventBody(record: AgentRecord): AgentEventBody | undefined {
  switch (record.type) {
    case "context.append_message":
      return { type: "message.appended", message: record.message, origin: record.origin };
    case "custom_message":
      return { type: "message.appended", message: customMessage(record.content, record.time), origin: record.origin };
    case "context.replace":
      return { type: "history.replaced", messages: record.messages, origins: record.origins };
    case "context.apply_compaction":
      return {
        type: "history.compacted",
        cutoff: record.cutoff,
        summary: record.summary,
        summaryTimestamp: record.summaryTimestamp,
      };
    case "usage.record":
      return record.total === undefined ? undefined : { type: "usage.updated", usage: record.total };
    case "agent.handoff":
      return {
        type: "agent.handoff",
        from: record.from,
        to: record.to,
        handoffId: record.handoffId,
        fromAddress: record.address ?? DEFAULT_ADDRESS,
        toAddress: record.toAddress,
      };
    case "guardrail.blocked":
      return {
        type: "guardrail.blocked",
        stage: record.stage,
        guardrail: record.guardrail,
        agent: record.agent,
        turnId: record.turnId,
        step: record.step,
        stepId: record.stepId,
        message: record.message,
      };
    case "event.lifecycle":
      return record.event;
    case "custom":
      {
        const projected = workflowProgressFromRecord(record);
        return projected === undefined
          ? undefined
          : {
              type: "workflow.progress",
              runId: projected.runId,
              ...(projected.toolCallId !== undefined ? { toolCallId: projected.toolCallId } : {}),
              progress: projected.progress,
            };
      }
    // The durable half of a delivery receipt. Projecting it means a client that reconnects and
    // replays history sees "this was accepted" even if the run that consumes it never started —
    // which is the whole point of journaling acceptance separately from processing.
    //
    // `channel` here is the delivery's INTENT, not the outcome: acceptance can precede
    // processing by an arbitrary gap, so whether an `auto` delivery ends up steering a running
    // turn or starting a fresh one isn't known yet. The outcome is carried by the events the
    // run itself emits (`steer.queued` / `turn.started`).
    case "inbox.received":
      return {
        type: "delivery.accepted",
        deliveryId: record.origin.deliveryId,
        ...(record.origin.kind === "external" ? { source: record.origin.source } : {}),
        channel: record.mode === "follow_up" ? "follow_up" : record.mode === "steer" ? "steering" : "turn",
      };
    case "metadata":
    case "permission.record_approval":
    case "permission.set_mode":
    case "config.update":
    case "agent.handoff.accepted":
      return undefined;
    default: {
      const exhaustive: never = record;
      return exhaustive;
    }
  }
}

/**
 * Does this event reach the session log, so that a reader can find it again later?
 *
 * Two kinds do: projections of durable records (`message.appended`, `usage.updated`, ...) and
 * the lifecycle events the publisher journals as `event.lifecycle`. Everything else — token
 * deltas, retries, warnings — exists only on the live channel. A transport that hands out
 * resume cursors must hand out only the durable kind: a cursor naming a delta points at
 * nothing a re-read of the log can locate.
 */
export function isDurableAgentEvent(event: AgentEvent): boolean {
  if (isPersistedLifecycleEvent(event)) return true;
  switch (event.type) {
    case "message.appended":
    case "history.replaced":
    case "history.compacted":
    case "usage.updated":
    case "agent.handoff":
    case "guardrail.blocked":
    case "workflow.progress":
    case "delivery.accepted":
      return true;
    default:
      return false;
  }
}

function isPersistedLifecycleEvent(event: AgentEvent): event is AgentEvent & import("./events.ts").PersistedLifecycleEvent {
  switch (event.type) {
    case "agent.started":
    case "agent.ended":
    case "turn.started":
    case "turn.ended":
    case "turn.step.started":
    case "turn.paused":
    case "steer.queued":
    case "tool.detachable":
    case "tool.suspended":
      return true;
    default:
      return false;
  }
}

function lifecycleBody(event: AgentEvent & import("./events.ts").PersistedLifecycleEvent): import("./events.ts").PersistedLifecycleEvent {
  switch (event.type) {
    case "agent.started":
      return { type: event.type, agent: event.agent, ...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}) };
    case "agent.ended":
      return { type: event.type, agent: event.agent };
    case "turn.started":
      return { type: event.type, turnId: event.turnId, ...(event.origin !== undefined ? { origin: event.origin } : {}) };
    case "turn.ended":
      return { type: event.type, turnId: event.turnId, reason: event.reason, ...(event.error !== undefined ? { error: event.error } : {}), ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}) };
    case "turn.step.started":
      return { type: event.type, turnId: event.turnId, step: event.step, stepId: event.stepId };
    case "turn.paused":
      return { type: event.type, pending: event.pending };
    case "steer.queued":
      return { type: event.type, steerId: event.steerId, channel: event.channel, origin: event.origin, message: event.message };
    case "tool.detachable":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
    case "tool.suspended":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, ...(event.request !== undefined ? { request: event.request } : {}) };
  }
}

export interface WorkflowRecordProjection {
  readonly runId: string;
  readonly toolCallId?: string;
  readonly progress: WorkflowProgressEvent;
}

/** Pure workflow-journal projection shared by historical seeding and live publication. */
export function workflowProgressFromRecord(
  record: Extract<AgentRecord, { type: "custom" }>,
): WorkflowRecordProjection | undefined {
  const address = record.address ?? "";
  if (record.name !== "wf_journal" || !address.startsWith("workflow:")) return undefined;
  if (typeof record.data !== "object" || record.data === null) return undefined;
  const entry = record.data as Record<string, unknown>;
  const runId = address.slice("workflow:".length);
  const toolCallId = typeof entry["parentToolCallId"] === "string" ? entry["parentToolCallId"] : undefined;
  switch (entry["type"]) {
    case "run":
      if (typeof entry["name"] !== "string") return undefined;
      return {
        runId,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        progress: { type: "started", name: entry["name"] },
      };
    case "phase":
      if (typeof entry["index"] !== "number" || typeof entry["title"] !== "string") return undefined;
      return {
        runId,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        progress: {
          type: "phase",
          index: entry["index"],
          title: entry["title"],
          kind: entry["kind"] === "child" ? "child" : "normal",
        },
      };
    case "queued":
    case "started":
    case "result":
    case "error": {
      if (typeof entry["index"] !== "number") return undefined;
      const state = entry["type"] === "queued"
        ? "queued"
        : entry["type"] === "started"
          ? "running"
          : entry["type"] === "result"
            ? "done"
            : "error";
      const agent: WorkflowAgentRecord = {
        index: entry["index"],
        label: String(entry["label"] ?? ""),
        ...(typeof entry["phase"] === "string" ? { phase: entry["phase"] } : {}),
        ...(typeof entry["agentId"] === "string" && entry["agentId"].length > 0 ? { agentId: entry["agentId"] } : {}),
        ...(typeof entry["address"] === "string" && entry["address"].length > 0 ? { address: entry["address"] } : {}),
        state,
        ...(state === "error" ? { error: String(entry["error"] ?? "") } : {}),
        ...(state === "done" ? { resultPreview: preview(entry["result"]) } : {}),
      };
      return {
        runId,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        progress: { type: "agent", record: agent },
      };
    }
    case "log":
      if (typeof entry["message"] !== "string") return undefined;
      return {
        runId,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        progress: { type: "log", message: entry["message"] },
      };
    case "outcome": {
      const status = entry["status"];
      if (status !== "completed" && status !== "failed" && status !== "aborted") return undefined;
      return {
        runId,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        progress: {
          type: "outcome",
          status,
          ok: entry["ok"] === true,
          ...(typeof entry["error"] === "string" ? { error: entry["error"] } : {}),
        },
      };
    }
    default:
      return undefined;
  }
}

function preview(value: unknown): string {
  let rendered: string;
  if (typeof value === "string") rendered = value;
  else {
    try {
      rendered = JSON.stringify(value) ?? String(value);
    } catch {
      rendered = String(value);
    }
  }
  return rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered;
}
