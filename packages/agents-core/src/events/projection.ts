import type { Message, TextContent, ThinkingContent, Usage } from "../protocol/index.ts";
import type { PromptOrigin } from "../store/origin.ts";
import {
  type AgentRecord,
  foldAppend,
  foldCompaction,
  foldReplace,
  type SessionStore,
} from "../store/store.ts";
import type { ToolInputRequest, ToolUpdate } from "../tool/types.ts";
import type { PendingRunInterrupt } from "../loop/interruption.ts";
import type { AgentEvent, EventSink, WorkflowAgentRecord } from "./events.ts";
import { agentEventFromRecord } from "./publisher.ts";

/**
 * SessionProjection — the session's event stream folded into per-address STATE, so a
 * late-joining consumer (a UI opening a running agent, an SSE reconnect) gets an exact
 * seam between history and live events.
 *
 * The whole design rests on the runtime being single-threaded:
 * - `apply` mutates state and notifies subscribers in ONE synchronous block;
 * - a consumer calls `observe()` to establish the snapshot/live boundary atomically.
 * Any event is therefore either already folded into the snapshot or delivered to the
 * subscriber — never both, never neither. `eventId` serves list/stream history overlap and
 * diagnostics; this in-process snapshot boundary itself still needs no dedup.
 * (Contrast with aligning an async `readRecords` against a live subscription, which
 * inherently loses or duplicates the overlap.)
 *
 * Lifecycle contract: attach BEFORE the session's first run (events only flow during
 * runs, so seeding from the store cannot race the subscription). The projection is the
 * standard consumer for state-shaped needs; consumers that want events-as-events
 * (tracing, telemetry, tests) keep subscribing to `session.events` directly.
 *
 * Memory discipline: messages are stored by REFERENCE — `message.appended` carries the
 * same readonly `Message` object held by the live conversation context, so the
 * projection adds pointers, not copies. Never deep-copy here.
 */

/** A tool call that has started and not yet produced its result. */
export interface ProjectedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  /** Latest `tool.progress` update, if any. */
  readonly progress?: ToolUpdate;
  /** The call entered its detachable window (UI may offer "move to background"). */
  readonly detachable: boolean;
  /** The call suspended awaiting caller input (`tool.suspended`); null when the
   *  suspension carried no input request. */
  readonly suspended?: ToolInputRequest | null;
}

/** In-flight state of the turn currently running at an address. Everything here is
 *  bounded by one step's output and is absorbed into a message when it completes. */
export interface ProjectedTurn {
  readonly turnId: string;
  readonly origin?: PromptOrigin;
  readonly step: number;
  readonly stepId?: string;
  /** Completed parts of the current step (absorbed by the step's assistant message). */
  readonly parts: readonly (TextContent | ThinkingContent)[];
  /** Streaming text accumulated since the last completed text part. */
  readonly textTail: string;
  /** Streaming thinking accumulated since the last completed thinking part. */
  readonly thinkingTail: string;
  readonly toolCalls: readonly ProjectedToolCall[];
  /** Pending approvals / input requests when the run is paused (`turn.paused`). */
  readonly paused?: readonly PendingRunInterrupt[];
}

/** A steer-bus message that has been queued but not yet consumed by the model. */
export interface ProjectedPendingSteer {
  readonly steerId: string;
  readonly channel: "steering" | "follow_up";
  readonly origin: PromptOrigin;
  readonly message: Message;
}

/** Full projected state of one address (one agent line). */
export interface AgentSnapshot {
  readonly address: string;
  /** Agent name from `agent.started`; undefined for a seeded-but-never-run shard. */
  readonly agent?: string;
  /** Tool call that spawned this agent (subagents); absent for the root. */
  readonly parentToolCallId?: string;
  /** Between `agent.started` and `agent.ended`. */
  readonly live: boolean;
  readonly messages: readonly Message[];
  /**
   * Provenance, parallel to `messages` (`origins[i]` describes `messages[i]`, `undefined`
   * when unknown). This is how a UI tells apart a message the user sent, one a background
   * task's settle injected, one a peer delivered, and the summary compaction left behind —
   * a distinction that matters most for turns nobody asked for.
   */
  readonly origins: readonly (PromptOrigin | undefined)[];
  /** Total messages held (== messages.length unless the snapshot was tail-limited). */
  readonly messageCount: number;
  readonly turn?: ProjectedTurn;
  readonly pendingSteers: readonly ProjectedPendingSteer[];
  /** Run-total usage from the latest `usage.updated`. */
  readonly usage?: Usage;
  /** Wall-clock of the last event: durable record time on replay, apply time for live-only events. */
  readonly lastEventAt?: number;
}

/** Lightweight per-address summary for "what agents exist and who is doing something". */
export interface DirectoryEntry {
  readonly address: string;
  readonly agent?: string;
  readonly live: boolean;
  readonly running: boolean;
  readonly lastMessage?: Message;
  readonly lastEventAt?: number;
}

/**
 * A workflow run's progress, folded from its steps.
 *
 * Separate from `agents` because a run is not a conversation: it has phases and a roster of
 * agents rather than messages and a turn. The agents it spawns DO appear in `agents` under
 * their own addresses — this is the orchestration layer above them.
 */
export interface WorkflowRunSnapshot {
  readonly runId: string;
  /** The Workflow tool call the run came from, if it had one. */
  readonly toolCallId?: string;
  /** False once the run settled; a run whose steps stopped arriving is still live until then. */
  readonly live: boolean;
  readonly phases: readonly { readonly index: number; readonly title: string; readonly kind: "normal" | "child" }[];
  /** Latest state per agent index — running ones included, so this IS the live roster. */
  readonly agents: readonly WorkflowAgentRecord[];
  /** The script's own `log()` narration, in order. */
  readonly logs: readonly string[];
  readonly lastEventAt?: number;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  /** Last event folded into this state. Useful only with a transport that preserves the same
   *  ordered event channel (the App Server does); managed HTTP deliberately does not expose
   *  this snapshot contract. */
  readonly lastEventId?: string;
  readonly directory: readonly DirectoryEntry[];
  readonly agents: readonly AgentSnapshot[];
  /** Workflow runs seen this session, newest activity last. */
  readonly workflows: readonly WorkflowRunSnapshot[];
}

export interface SnapshotOptions {
  /** Only include these addresses in `agents` (exact match). Default: all. The
   *  `directory` always covers every known address. */
  readonly addresses?: readonly string[];
  /** Cap `messages` to the last N (older pages come from the immutable log prefix,
   *  which is race-free by construction). Default: 200. */
  readonly maxMessages?: number;
}

export type ProjectionListener = (event: AgentEvent) => void;

/** Atomically established state/live observation. `snapshot` contains every event folded
 *  before observation began; `listener` receives every event folded afterwards. */
export interface ProjectionObservation {
  readonly snapshot: SessionSnapshot;
  readonly unsubscribe: () => void;
}

/** Structural slice of `Session` the projection needs — kept structural so this file
 *  never imports the Session class (no cycle, and pure uses stay possible). */
export interface ProjectionSource {
  readonly id: string;
  readonly store?: SessionStore;
  readonly events: EventSink;
}

interface ToolCallState {
  toolCallId: string;
  toolName: string;
  args: unknown;
  progress?: ToolUpdate;
  detachable: boolean;
  suspended?: ToolInputRequest | null;
}

interface TurnState {
  turnId: string;
  origin?: PromptOrigin;
  step: number;
  stepId?: string;
  parts: (TextContent | ThinkingContent)[];
  textTail: string;
  thinkingTail: string;
  toolCalls: Map<string, ToolCallState>;
  paused?: readonly PendingRunInterrupt[];
}

/** Structurally a {@link HistoryFold} (`messages` + `origins`), so the shared fold operations
 *  apply to it directly — replay and this projection run the SAME history semantics. */
interface AgentState {
  address: string;
  agent?: string;
  parentToolCallId?: string;
  live: boolean;
  messages: Message[];
  origins: (PromptOrigin | undefined)[];
  turn?: TurnState;
  pendingSteers: ProjectedPendingSteer[];
  usage?: Usage;
  lastEventAt?: number;
}

const DEFAULT_SNAPSHOT_MAX_MESSAGES = 200;

interface WorkflowRunState {
  runId: string;
  toolCallId?: string;
  live: boolean;
  phases: { index: number; title: string; kind: "normal" | "child" }[];
  /** Keyed by agent index: a step's later states replace its earlier ones. */
  agents: Map<number, WorkflowAgentRecord>;
  logs: string[];
  lastEventAt?: number;
}

export class SessionProjection {
  readonly sessionId: string;
  private readonly agents = new Map<string, AgentState>();
  private readonly workflows = new Map<string, WorkflowRunState>();
  private readonly listeners = new Set<ProjectionListener>();
  private detachFn?: () => void;
  private lastEventId?: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Seed from the append log, then subscribe to the live event stream.
   * MUST be called before the session's first run (see the class doc's lifecycle
   * contract) — the seam guarantee comes from that ordering, not from alignment.
   *
   * Pass `preloadedLog` (the complete log, as `readRecords()` returns it) when the caller
   * already read it — typically to share ONE open-time read with `Session.open`'s
   * `preloadedLog`, which also makes the seeded prefix share `Message` objects with the
   * session's live context instead of holding a second parsed copy.
   */
  static async attach(source: ProjectionSource, preloadedLog?: readonly AgentRecord[]): Promise<SessionProjection> {
    const projection = new SessionProjection(source.id);
    const records = preloadedLog ?? (source.store !== undefined ? await collectRecords(source.store) : []);
    for (const record of records) {
      const event = agentEventFromRecord(record, source.id);
      if (event !== undefined) projection.apply(event, record.time);
    }
    projection.detachFn = source.events.subscribe((event) => {
      projection.apply(event);
    });
    return projection;
  }

  /** Stop receiving live events (the projection keeps its last state). */
  detach(): void {
    this.detachFn?.();
    this.detachFn = undefined;
  }

  /**
   * Fold one event into the projection, then notify subscribers — one synchronous
   * block, which is what makes `snapshot()` + `subscribe()` an exact seam.
   * `time` is supplied by durable replay so reopening preserves the record's wall clock;
   * live callers omit it and use the apply time.
   */
  apply(event: AgentEvent, time: number = Date.now()): void {
    if (event.type === "workflow.progress") {
      const run = this.workflowFor(event.runId);
      if (event.toolCallId !== undefined) run.toolCallId = event.toolCallId;
      this.foldWorkflow(run, event.progress, time);
    } else {
      const state = this.stateFor(event.address);
      state.lastEventAt = time;
      this.fold(state, event);
    }
    this.lastEventId = event.eventId;
    if (this.listeners.size > 0) {
      // Copy so a listener subscribing/unsubscribing mid-notify can't skew delivery.
      for (const listener of [...this.listeners]) listener(event);
    }
  }

  /**
   * Post-apply event feed. Listeners MUST be synchronous and non-blocking —
   * backpressure belongs to the transport (drop the slow client), never here. Prefer
   * `observe()` when the consumer also needs an initial snapshot.
   */
  subscribe(listener: ProjectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Establish the exact snapshot/live seam as one operation, so callers cannot accidentally
   * split `subscribe()` and `snapshot()` with asynchronous work. The subscription is installed
   * first; because `apply()` folds and notifies synchronously, every event is represented by
   * exactly one side of the returned boundary.
   */
  observe(listener: ProjectionListener, options?: SnapshotOptions): ProjectionObservation {
    const unsubscribe = this.subscribe(listener);
    try {
      return { snapshot: this.snapshot(options), unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  directory(): DirectoryEntry[] {
    return [...this.agents.values()].map((state) => ({
      address: state.address,
      ...(state.agent !== undefined ? { agent: state.agent } : {}),
      live: state.live,
      running: state.turn !== undefined,
      ...(state.messages.length > 0 ? { lastMessage: state.messages[state.messages.length - 1] } : {}),
      ...(state.lastEventAt !== undefined ? { lastEventAt: state.lastEventAt } : {}),
    }));
  }

  snapshot(options: SnapshotOptions = {}): SessionSnapshot {
    const wanted = options.addresses === undefined ? undefined : new Set(options.addresses);
    const agents: AgentSnapshot[] = [];
    for (const state of this.agents.values()) {
      if (wanted !== undefined && !wanted.has(state.address)) continue;
      agents.push(snapshotAgent(state, options.maxMessages ?? DEFAULT_SNAPSHOT_MAX_MESSAGES));
    }
    const workflows: WorkflowRunSnapshot[] = [];
    for (const run of this.workflows.values()) {
      workflows.push({
        runId: run.runId,
        ...(run.toolCallId !== undefined ? { toolCallId: run.toolCallId } : {}),
        live: run.live,
        phases: [...run.phases],
        agents: [...run.agents.values()],
        logs: [...run.logs],
        ...(run.lastEventAt !== undefined ? { lastEventAt: run.lastEventAt } : {}),
      });
    }
    return {
      sessionId: this.sessionId,
      ...(this.lastEventId !== undefined ? { lastEventId: this.lastEventId } : {}),
      directory: this.directory(),
      agents,
      workflows,
    };
  }

  private workflowFor(runId: string): WorkflowRunState {
    const existing = this.workflows.get(runId);
    if (existing !== undefined) return existing;
    const created: WorkflowRunState = { runId, live: true, phases: [], agents: new Map(), logs: [] };
    this.workflows.set(runId, created);
    return created;
  }

  private stateFor(address: string): AgentState {
    const existing = this.agents.get(address);
    if (existing !== undefined) return existing;
    const created: AgentState = { address, live: false, messages: [], origins: [], pendingSteers: [] };
    this.agents.set(address, created);
    return created;
  }

  private foldWorkflow(
    run: WorkflowRunState,
    step: import("./events.ts").WorkflowProgressEvent,
    time: number | undefined,
  ): void {
    if (time !== undefined) run.lastEventAt = time;
    if (step.type === "started") {
      // workflowFor() already established the run; name is currently presentation-only.
    } else if (step.type === "phase") {
      if (!run.phases.some((phase) => phase.index === step.index)) {
        run.phases.push({ index: step.index, title: step.title, kind: step.kind });
      }
    } else if (step.type === "agent") {
      run.agents.set(step.record.index, step.record);
    } else if (step.type === "log") {
      run.logs.push(step.message);
    } else {
      run.live = false;
    }
  }

  // ── the fold ──
  // Every in-flight item has a birth event and a death event, so the state is
  // self-cleaning: memory is bounded by one step's output plus the message list
  // (which holds references, not copies). The switch is exhaustive over
  // AgentEventBody so adding an event type fails compilation here, same
  // discipline as reduceHistory.
  private fold(state: AgentState, event: AgentEvent): void {
    switch (event.type) {
      case "agent.started":
        state.live = true;
        state.agent = event.agent;
        if (event.parentToolCallId !== undefined) state.parentToolCallId = event.parentToolCallId;
        break;
      case "agent.ended":
        state.live = false;
        state.turn = undefined;
        break;
      case "turn.started":
        state.turn = {
          turnId: event.turnId,
          ...(event.origin !== undefined ? { origin: event.origin } : {}),
          step: 0,
          parts: [],
          textTail: "",
          thinkingTail: "",
          toolCalls: new Map(),
        };
        break;
      case "turn.ended":
        state.turn = undefined;
        break;
      case "turn.step.started": {
        const turn = state.turn;
        if (turn === undefined) break;
        turn.step = event.step;
        turn.stepId = event.stepId;
        // A new step implies the previous step's calls all settled (the loop contract);
        // clearing here is defensive against a missed tool.result.
        turn.parts = [];
        turn.textTail = "";
        turn.thinkingTail = "";
        turn.toolCalls.clear();
        turn.paused = undefined;
        break;
      }
      case "turn.step.completed":
        // Parts stay until the step's assistant message is appended (message.appended
        // clears them) — the durable form supersedes the in-flight one, not the
        // step boundary.
        break;
      case "turn.step.retrying":
        break;
      case "turn.step.reset": {
        const turn = state.turn;
        if (turn === undefined) break;
        turn.parts = [];
        turn.textTail = "";
        turn.thinkingTail = "";
        break;
      }
      case "turn.step.interrupted": {
        const turn = state.turn;
        if (turn === undefined) break;
        turn.textTail = "";
        turn.thinkingTail = "";
        break;
      }
      case "content.part": {
        const turn = state.turn;
        if (turn === undefined) break;
        turn.parts.push(event.part);
        if (event.part.type === "text") turn.textTail = "";
        else turn.thinkingTail = "";
        break;
      }
      case "assistant.delta": {
        const turn = state.turn;
        if (turn !== undefined) turn.textTail += event.delta;
        break;
      }
      case "thinking.delta": {
        const turn = state.turn;
        if (turn !== undefined) turn.thinkingTail += event.delta;
        break;
      }
      case "message.appended": {
        foldAppend(state, event.message, event.origin);
        const turn = state.turn;
        if (turn !== undefined && event.message.role === "assistant") {
          // The step's parts are now durable inside this message.
          turn.parts = [];
          turn.textTail = "";
          turn.thinkingTail = "";
          for (const part of event.message.content) {
            if (part.type !== "toolCall") continue;
            turn.toolCalls.set(part.id, {
              toolCallId: part.id,
              toolName: part.name,
              args: part.arguments,
              detachable: false,
            });
          }
        }
        if (turn !== undefined && event.message.role === "toolResult") {
          const toolCallId = event.message.toolCallId;
          turn.toolCalls.delete(toolCallId);
          if (turn.paused !== undefined) {
            const remaining = turn.paused.filter((pending) => pending.toolCallId !== toolCallId);
            turn.paused = remaining.length > 0 ? remaining : undefined;
          }
        }
        const origin = event.origin;
        const steerId = origin !== undefined && "steerId" in origin ? origin.steerId : undefined;
        if (steerId !== undefined && state.pendingSteers.length > 0) {
          state.pendingSteers = state.pendingSteers.filter((pending) => pending.steerId !== steerId);
        }
        break;
      }
      // History is not append-only. Both of these run the SAME operation replay runs, so a
      // transcript watched live and the same transcript after a reopen cannot diverge —
      // which they silently did while these mutations were journaled but never broadcast.
      case "history.replaced":
        foldReplace(state, event.messages, event.origins);
        break;
      case "history.compacted":
        foldCompaction(state, event.cutoff, event.summary, event.summaryTimestamp);
        break;
      case "steer.queued":
        state.pendingSteers.push({
          steerId: event.steerId,
          channel: event.channel,
          origin: event.origin,
          message: event.message,
        });
        break;
      case "delivery.accepted":
        break;
      case "tool.call.started": {
        const turn = state.turn;
        if (turn === undefined) break;
        turn.toolCalls.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          detachable: false,
        });
        break;
      }
      case "tool.call.delta":
        // Pre-execution argument streaming; the complete args arrive on
        // tool.call.started. Not folded (mirrors VOLATILE_EVENT_TYPES intent).
        break;
      case "tool.progress": {
        const call = state.turn?.toolCalls.get(event.toolCallId);
        if (call !== undefined) call.progress = event.update;
        break;
      }
      case "tool.detachable": {
        const call = state.turn?.toolCalls.get(event.toolCallId);
        if (call !== undefined) call.detachable = true;
        break;
      }
      case "tool.suspended": {
        const call = state.turn?.toolCalls.get(event.toolCallId);
        if (call !== undefined) call.suspended = event.request ?? null;
        break;
      }
      case "tool.result": {
        const turn = state.turn;
        if (turn === undefined) break;
        turn.toolCalls.delete(event.toolCallId);
        if (turn.paused !== undefined) {
          const remaining = turn.paused.filter((pending) => pending.toolCallId !== event.toolCallId);
          turn.paused = remaining.length > 0 ? remaining : undefined;
        }
        break;
      }
      case "turn.paused": {
        const turn = state.turn;
        if (turn !== undefined) turn.paused = event.pending;
        break;
      }
      // Directory-level or audit-only signals: they bump lastEventAt (done in apply)
      // but carry no per-agent state the projection tracks.
      case "goal.updated":
      case "plan.updated":
      case "skill.activated":
      case "background.task.started":
      case "background.task.terminated":
      case "extension":
      case "agent.handoff":
      case "compaction.started":
      // compaction.completed is a process signal; history.compacted already performed the
      // transcript fold from the same journal mutation.
      case "compaction.completed":
      case "guardrail.blocked":
      case "error":
      case "warning":
        break;
      case "usage.updated":
        state.usage = event.usage;
        break;
      case "workflow.progress": {
        // Routed before this per-agent fold in apply(). Keeping the case makes the
        // AgentEventBody switch exhaustive without creating a workflow:* AgentState.
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new Error(`SessionProjection: unhandled event type ${String((exhaustive as AgentEvent).type)}`);
      }
    }
  }
}

async function collectRecords(store: SessionStore): Promise<readonly AgentRecord[]> {
  const records: AgentRecord[] = [];
  for await (const record of store.readRecords()) records.push(record);
  return records;
}

function snapshotAgent(state: AgentState, maxMessages?: number): AgentSnapshot {
  // One slice point for both arrays: `origins[i]` describes `messages[i]`, and a tail limit
  // that trimmed only one of them would silently misattribute every remaining message.
  const from =
    maxMessages !== undefined && state.messages.length > maxMessages ? state.messages.length - maxMessages : 0;
  const messages = state.messages.slice(from);
  const origins = state.origins.slice(from, from + messages.length);
  while (origins.length < messages.length) origins.push(undefined);
  return {
    address: state.address,
    ...(state.agent !== undefined ? { agent: state.agent } : {}),
    ...(state.parentToolCallId !== undefined ? { parentToolCallId: state.parentToolCallId } : {}),
    live: state.live,
    messages,
    origins,
    messageCount: state.messages.length,
    ...(state.turn !== undefined ? { turn: snapshotTurn(state.turn) } : {}),
    pendingSteers: [...state.pendingSteers],
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
    ...(state.lastEventAt !== undefined ? { lastEventAt: state.lastEventAt } : {}),
  };
}

function snapshotTurn(turn: TurnState): ProjectedTurn {
  return {
    turnId: turn.turnId,
    ...(turn.origin !== undefined ? { origin: turn.origin } : {}),
    step: turn.step,
    ...(turn.stepId !== undefined ? { stepId: turn.stepId } : {}),
    parts: [...turn.parts],
    textTail: turn.textTail,
    thinkingTail: turn.thinkingTail,
    toolCalls: [...turn.toolCalls.values()].map((call) => ({ ...call })),
    ...(turn.paused !== undefined ? { paused: turn.paused } : {}),
  };
}
