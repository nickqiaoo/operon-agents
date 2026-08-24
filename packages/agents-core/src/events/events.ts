import { randomUUID } from "node:crypto";
import type { Message, TextContent, ThinkingContent, Usage } from "../protocol/index.ts";
import type { PromptOrigin } from "../store/origin.ts";
import type { ToolInputRequest, ToolResult, ToolUpdate } from "../tool/types.ts";
import type { PendingRunInterrupt } from "../loop/interruption.ts";
import type { SkillActivationTrigger } from "../capabilities/skills/service.ts";
import type { SkillSource } from "../capabilities/skills/types.ts";

/** One step of a workflow run, as it happens. Defined here because it is a WIRE shape: the
 *  runtime emits it, the projection folds it, and a transport carries it. */
export type WorkflowProgressEvent =
  | { readonly type: "started"; readonly name: string }
  | { readonly type: "phase"; readonly index: number; readonly title: string; readonly kind: "normal" | "child" }
  | { readonly type: "agent"; readonly record: WorkflowAgentRecord }
  | { readonly type: "log"; readonly message: string }
  | {
      readonly type: "outcome";
      readonly status: "completed" | "failed" | "aborted";
      readonly ok: boolean;
      readonly error?: string;
    };

export interface WorkflowAgentRecord {
  readonly index: number;
  readonly label: string;
  readonly phase?: string;
  /** Assigned once the host starts the agent. Together with `address`, this joins the
   *  orchestration record to that agent's full Session AgentEvent stream. */
  readonly agentId?: string;
  readonly address?: string;
  readonly state: "queued" | "running" | "done" | "error";
  readonly resultPreview?: string;
  readonly error?: string;
}

/** Stable public identity shared by durable history (`events.list`) and live delivery
 *  (`events.stream` / EventSink). Store sequence is deliberately not part of this shape: it
 *  orders and paginates records internally, while `eventId` is the application-facing id.
 *  The UUID-based id is globally unique in practice; clients should scope deduplication to a
 *  session so ownership and cache lifetime stay explicit. */
export type AgentEvent = {
  readonly eventId: string;
  readonly address: string;
  readonly sessionId: string;
} & AgentEventBody;

/** Runtime producers do not allocate ids themselves. The session publisher (or a standalone
 *  sink) stamps one at the single publication boundary. */
export type AgentEventInput = {
  readonly eventId?: string;
  readonly address: string;
  readonly sessionId: string;
} & AgentEventBody;

export function newAgentEventId(): string {
  return `evt_${randomUUID()}`;
}

export function normalizeAgentEvent(event: AgentEventInput): AgentEvent {
  return {
    ...event,
    eventId: event.eventId ?? newAgentEventId(),
  } as AgentEvent;
}

/** Why a turn ended. */
export type TurnEndReason = "completed" | "cancelled" | "failed";

/**
 * The event vocabulary uses dotted `namespace.event` names and a TWO-TIER
 * split between events projected from their own records (`message.appended`,
 * `history.replaced`, `history.compacted`, `workflow.progress`, selected audit events) and
 * live-only runtime events (`assistant.delta`, `thinking.delta`, `tool.call.delta`,
 * `tool.progress`). Selected lifecycle events have compact `event.lifecycle` records so a
 * managed client can reconstruct structural state without copying message bodies. The payloads
 * are the underlying LLM message model (`Message`, `TextContent`/`ThinkingContent`,
 * `Usage`) — the event STRUCTURE is ours. See VOLATILE_EVENT_TYPES.
 */
export type AgentEventBody =
  // ── Agent / turn lifecycle ──
  // `parentToolCallId` is the id of the tool call that spawned this agent (an
  // `Agent`/`agent_<name>`/`Workflow` delegation) — absent for the root agent. Lets consumers
  // nest a sub-agent's steps under the exact spawning tool call, not from event ordering.
  | { readonly type: "agent.started"; readonly agent: string; readonly parentToolCallId?: string }
  | { readonly type: "agent.ended"; readonly agent: string }
  | { readonly type: "turn.started"; readonly turnId: string; readonly origin?: PromptOrigin }
  | {
      readonly type: "turn.ended";
      readonly turnId: string;
      readonly reason: TurnEndReason;
      /** Present when `reason` is `"failed"`: the error that ended the turn, as a string. Carried
       *  on the (persisted) lifecycle event on purpose, so a reader that arrives later — a
       *  reconnect backfill, `listEvents` — still learns WHY, not just that it failed. The live
       *  `error` event carries the same text for immediate display but is not persisted. */
      readonly error?: string;
      /** Model context window in tokens (0/unset when unknown). With `message.usage` this
       *  lets consumers show a current context-occupancy gauge (last turn's tokens / window). */
      readonly contextWindow?: number;
    }
  // ── Step lifecycle ──
  | { readonly type: "turn.step.started"; readonly turnId: string; readonly step: number; readonly stepId: string }
  | {
      readonly type: "turn.step.completed";
      readonly turnId: string;
      readonly step: number;
      readonly stepId: string;
      readonly usage?: Usage;
      readonly finishReason?: string;
      readonly contextWindow?: number;
    }
  | {
      readonly type: "turn.step.retrying";
      readonly turnId: string;
      readonly step: number;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason?: string;
    }
  | {
      readonly type: "turn.step.reset";
      readonly turnId: string;
      readonly step: number;
      readonly stepId: string;
      readonly discardedAttempt: number;
      readonly nextAttempt: number;
      readonly reason?: string;
    }
  | { readonly type: "turn.step.interrupted"; readonly turnId: string; readonly step: number; readonly reason: string; readonly message?: string }
  // ── Content: completed parts are recorded; deltas are live-only. The upstream streaming
  // AssistantMessageEvent (@earendil-works/pi-ai) is decomposed into these at the emit site
  // (run-turn). ──
  | { readonly type: "content.part"; readonly turnId: string; readonly step: number; readonly part: TextContent | ThinkingContent }
  | { readonly type: "assistant.delta"; readonly turnId: string; readonly delta: string }
  | { readonly type: "thinking.delta"; readonly turnId: string; readonly delta: string }
  // Emitted whenever a message is journaled into history (mirrors the `context.append_message`
  // record) — the uniform per-message signal consumers use to rebuild the transcript from the
  // stream. `origin`: structured provenance on non-model messages (user / injection /
  // background_task / cron); absent on model-authored messages.
  | { readonly type: "message.appended"; readonly message: Message; readonly origin?: PromptOrigin }
  // ── History rewrites ──
  // History is not append-only: it is also RESET (micro-compaction trims stale tool results
  // at a step boundary) and COMPACTED (a summary replaces a prefix). Both used to happen
  // silently — journaled but never broadcast — so a live consumer's transcript kept messages
  // the model no longer sees, and only a reopen (which folds the records) revealed it. These
  // two events mirror `context.replace` / `context.apply_compaction` exactly, and carry
  // enough to reproduce the fold: see `foldReplace` / `foldCompaction`, which replay and any
  // live consumer share so the two paths cannot diverge.
  | {
      readonly type: "history.replaced";
      readonly messages: readonly Message[];
      readonly origins?: readonly (PromptOrigin | null)[];
    }
  | {
      readonly type: "history.compacted";
      /** Number of leading messages the summary replaces. */
      readonly cutoff: number;
      readonly summary: string;
      /** Pinned so live and replay build a byte-identical summary message. */
      readonly summaryTimestamp?: number;
    }
  // A message entered the SteerBus queue (any producer: user steer/follow-up RPC, cron fire,
  // background settle). `steerId` matches the producer's `SteerReceipt` and reappears as
  // `origin.steerId` on the consuming `message.appended` — enqueue→consume is fully trackable,
  // and a late-joining client can rebuild the pending queue from `steer.queued` events not yet
  // matched by a consumption. `channel`: "steering" drains mid-turn, "follow_up" at turn boundary.
  | {
      readonly type: "steer.queued";
      readonly steerId: string;
      readonly channel: "steering" | "follow_up";
      readonly origin: PromptOrigin;
      readonly message: Message;
    }
  | {
      readonly type: "delivery.accepted";
      readonly deliveryId: string;
      readonly source: string;
      readonly channel: "turn" | "steering" | "follow_up";
    }
  // ── Tool lifecycle ──
  | { readonly type: "tool.call.started"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "tool.call.delta"; readonly turnId: string; readonly toolCallId: string; readonly toolName?: string; readonly argumentsPart: string }
  | { readonly type: "tool.progress"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown; readonly update: ToolUpdate }
  // A running tool call has entered its detachable window: the UI may offer "move to background",
  // which fires `session.detachTool(toolCallId)`. Emitted once when the call becomes detachable;
  // its later `tool.result` (carrying `details.movedToBackground` + `taskId` if detached) ends it.
  | { readonly type: "tool.detachable"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool.result"; readonly toolCallId: string; readonly toolName: string; readonly result: ToolResult; readonly isError: boolean }
  // A running tool call suspended instead of producing a result: it asked for caller input
  // (`request` present) or a foreground sub-agent under it paused. Pairs with the earlier
  // `tool.call.started`; the call re-runs (and eventually emits `tool.result`) after resume.
  | { readonly type: "tool.suspended"; readonly toolCallId: string; readonly toolName: string; readonly request?: ToolInputRequest }
  // ── Capability snapshots / lifecycle (interface stays decoupled from the capability). ──
  | { readonly type: "goal.updated"; readonly snapshot: unknown }
  | { readonly type: "plan.updated"; readonly snapshot: unknown }
  | {
      readonly type: "skill.activated";
      readonly activationId: string;
      readonly skillName: string;
      readonly skillArgs?: string;
      readonly trigger: SkillActivationTrigger;
      readonly skillPath: string;
      readonly skillSource: SkillSource;
    }
  // A workflow run advanced a step. With a SessionStore this is projected from the durable
  // `workflow:<runId>` journal append, sharing one eventId with historical list reads. A
  // storeless runner emits the same shape directly.
  | {
      readonly type: "workflow.progress";
      readonly runId: string;
      /** The Workflow tool call this run came from, so a UI can keep it on that card even
       *  after the run detaches and the call is long finished. */
      readonly toolCallId?: string;
      readonly progress: WorkflowProgressEvent;
    }
  | { readonly type: "background.task.started"; readonly info: unknown }
  | { readonly type: "background.task.terminated"; readonly info: unknown }
  // Generic extension-emitted signal (`api.emitEvent`): ephemeral like every stream event —
  // an extension's durable facts go through its records/state, never through the stream.
  | {
      readonly type: "extension";
      readonly extensionId: string;
      /** Extension-chosen event name, e.g. "cron.fired". */
      readonly name: string;
      readonly data?: unknown;
    }
  // ── Control flow ──
  // The run paused mid-turn awaiting tool approval (HITL), resumable via SessionStore interrupt state.
  // Not `turn.interrupted` on purpose: that name is reserved for a step cut short (→ `turn.step.interrupted`).
  | { readonly type: "turn.paused"; readonly pending: readonly PendingRunInterrupt[] }
  | {
      readonly type: "agent.handoff";
      readonly from: string;
      readonly to: string;
      readonly handoffId?: string;
      readonly fromAddress?: string;
      readonly toAddress?: string;
    }
  | { readonly type: "compaction.started"; readonly trigger: string; readonly instruction?: string }
  | {
      readonly type: "compaction.completed";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly compactedCount: number;
    }
  // ── Diagnostics ──
  // Mirrors the `usage.record` log entry (run-total token cost). `error`/`warning` stay flat:
  // they are generic top-level signals, not namespaced.
  | { readonly type: "usage.updated"; readonly usage: Usage }
  | { readonly type: "error"; readonly message: string; readonly cause?: unknown }
  | { readonly type: "warning"; readonly message: string }
  // A guardrail tripwire aborted the run: a clean terminal frame on the stream (the run
  // still rejects with the GuardrailTripwireError — this event is not the error itself).
  | {
      readonly type: "guardrail.blocked";
      readonly stage: "input" | "output" | "tool_input" | "tool_output";
      readonly guardrail: string;
      readonly agent?: string;
      /** Present for optimistic output checks so consumers can retract the provisional step. */
      readonly turnId?: string;
      readonly step?: number;
      readonly stepId?: string;
      readonly message: string;
    };

/**
 * Durable mutations of the model-visible conversation history. These are the canonical
 * transcript source for historical replay; terminal lifecycle events never duplicate their
 * message payloads.
 */
export type DurableHistoryEvent = Extract<
  AgentEventBody,
  { readonly type: "message.appended" | "history.replaced" | "history.compacted" }
>;

/** Structural execution events. This is a semantic grouping, independent of durability: some
 * lifecycle events are persisted, while retry/progress-style events can remain live-only. */
export type LifecycleEvent = Extract<
  AgentEventBody,
  | { readonly type: "agent.started" | "agent.ended" }
  | {
      readonly type:
        | "turn.started"
        | "turn.ended"
        | "turn.step.started"
        | "turn.step.completed"
        | "turn.step.retrying"
        | "turn.step.reset"
        | "turn.step.interrupted"
        | "turn.paused"
        | "steer.queued";
    }
  | {
      readonly type:
        | "tool.call.started"
        | "tool.detachable"
        | "tool.result"
        | "tool.suspended"
        | "background.task.started"
        | "background.task.terminated";
    }
>;

/** Runtime detail that is intentionally not replayable from `events.list()`. */
export type LiveOnlyEvent = Extract<
  AgentEventBody,
  {
    readonly type:
      | "assistant.delta"
      | "thinking.delta"
      | "tool.call.delta"
      | "tool.progress"
      | "turn.step.retrying";
  }
>;

/** Lifecycle bodies persisted separately because they affect Projection state but are not
 *  already encoded in a context/workflow/audit record. */
export type PersistedLifecycleEvent = Extract<
  LifecycleEvent,
  | { readonly type: "agent.started" | "agent.ended" }
  | { readonly type: "turn.started" | "turn.ended" | "turn.step.started" | "turn.paused" }
  | { readonly type: "steer.queued" }
  | { readonly type: "tool.detachable" | "tool.suspended" }
>;

/**
 * Live-only event types — streamed but never projected from a record of their own.
 *
 * The converse does NOT hold: a non-volatile event does not imply a record of its own.
 * `content.part`, `tool.call.started` and `tool.result` survive folded INTO a message (a tool
 * call lives in the assistant message's `tool_use` block), not as separate records. Selected
 * low-frequency lifecycle events additionally use compact `event.lifecycle` records because
 * they affect Projection state but are not encoded in messages.
 */
export const VOLATILE_EVENT_TYPES = [
  "assistant.delta",
  "thinking.delta",
  "tool.call.delta",
  "tool.progress",
  "turn.step.retrying",
] as const satisfies readonly LiveOnlyEvent["type"][];

const volatileEventTypeSet: ReadonlySet<string> = new Set(VOLATILE_EVENT_TYPES);

export function isVolatileEventType(type: string): boolean {
  return volatileEventTypeSet.has(type);
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export interface EventSink {
  emit(event: AgentEventInput): void | Promise<void>;
  subscribe(listener: AgentEventListener): () => void;
  child(addressSegment: string): EventSink;
}

export function joinAddress(base: string, segment: string): string {
  if (!base) return segment;
  if (!segment) return base;
  return `${base}/${segment}`;
}

abstract class BaseSink implements EventSink {
  protected readonly listeners = new Set<AgentEventListener>();

  abstract emit(event: AgentEventInput): void | Promise<void>;

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  child(addressSegment: string): EventSink {
    return new AddressProxySink(this, addressSegment);
  }

  protected async fanout(event: AgentEvent): Promise<void> {
    // Snapshot: a listener subscribing during an in-flight fanout must not receive the
    // event it predates (Set iteration would visit it) — late joiners get the event's
    // effect from state (SessionProjection) instead.
    for (const listener of [...this.listeners]) await listener(event);
  }
}

class AddressProxySink implements EventSink {
  private readonly parent: EventSink;
  private readonly segment: string;

  constructor(parent: EventSink, segment: string) {
    this.parent = parent;
    this.segment = segment;
  }

  emit(event: AgentEventInput): void | Promise<void> {
    // The child's own address (set by deeper proxies) is suffixed under our segment.
    const nested = event.address && event.address !== this.segment ? joinAddress(this.segment, event.address) : this.segment;
    return this.parent.emit({ ...event, address: nested });
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.parent.subscribe(listener);
  }

  child(addressSegment: string): EventSink {
    return new AddressProxySink(this, addressSegment);
  }
}

export class ListenerSink extends BaseSink {
  async emit(input: AgentEventInput): Promise<void> {
    await this.fanout(normalizeAgentEvent(input));
  }
}

export class NullSink extends BaseSink {
  emit(): void {
    /* no-op */
  }
}

class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private readonly pullWaiters: ((value: IteratorResult<T>) => void)[] = [];
  private readonly pushWaiters: (() => void)[] = [];
  private closed = false;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(value: T): Promise<void> {
    if (this.closed) return Promise.resolve();
    const waiter = this.pullWaiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return Promise.resolve();
    }
    this.buffer.push(value);
    if (this.buffer.length <= this.capacity) return Promise.resolve();
    return new Promise<void>((resolve) => this.pushWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.pullWaiters.splice(0)) waiter({ value: undefined as never, done: true });
    for (const resume of this.pushWaiters.splice(0)) resume();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          const value = this.buffer.shift() as T;
          this.pushWaiters.shift()?.();
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.pullWaiters.push(resolve));
      },
    };
  }
}

export interface RunHandle<R> extends AsyncIterable<AgentEvent> {
  readonly completed: Promise<R>;
}

export class IterableSink extends BaseSink implements AsyncIterable<AgentEvent> {
  private readonly queue: AsyncQueue<AgentEvent>;

  constructor(capacity = 1024) {
    super();
    this.queue = new AsyncQueue<AgentEvent>(capacity);
  }

  async emit(input: AgentEventInput): Promise<void> {
    const event = normalizeAgentEvent(input);
    await this.fanout(event);
    await this.queue.push(event);
  }

  close(): void {
    this.queue.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.queue[Symbol.asyncIterator]();
  }
}
