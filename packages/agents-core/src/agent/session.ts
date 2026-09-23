import type { Environment } from "../tool/environment.ts";
import { FileFreshnessLedger } from "../tool/file-freshness.ts";
import type { ChatModel } from "../llm/define-model.ts";
import type { ThinkingLevel } from "../llm/model.ts";
import type { PermissionMode, PermissionPolicy, Responder } from "../permission/types.ts";
import { PermissionManager } from "../permission/manager.ts";
import { STAGED_POLICY_SLOTS } from "../permission/policies.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import { NullEnvironment } from "../tool/environment-null.ts";
import type {
  BackgroundTaskInfo,
  BackgroundTaskOutputDelta,
  BackgroundTaskOutputSnapshot,
  BackgroundTaskStatus,
} from "../capabilities/background/index.ts";
import type { GoalSnapshot } from "../capabilities/goal/index.ts";
import { WorkflowManager } from "./workflow/manager.ts";
import type { WorkflowJournal } from "./workflow/journal.ts";
import type { WorkflowSnapshot, WorkflowSnapshotStatus } from "./workflow/snapshot.ts";
import type { ContextBreakdown } from "./context-report.ts";
import type { PlanData } from "../capabilities/plan/index.ts";
import type { CompactRequestOptions, PendingCompaction } from "../capabilities/compaction/index.ts";
import type { ActivateSkillRequest, SkillActivationResult, SkillSummary } from "../capabilities/skills/index.ts";
import type { PluginInfo, PluginSummary, ReloadSummary } from "../plugins/index.ts";
import { type EventSink, joinAddress, ListenerSink, SessionEventPublisher } from "../events/index.ts";
import { type Logger, envLogger, noopLogger } from "../logging/index.ts";
import { type AgentRecord, type AgentRecordBody, DEFAULT_ADDRESS, type SessionStore } from "../store/index.ts";
import { eventSinkTracingBridge, type TracingProcessor } from "../tracing/index.ts";
import { subscribeTelemetryProjection } from "../telemetry/projection.ts";
import { ConversationContext } from "../loop/context.ts";
import { readLog } from "../capabilities/capability-state.ts";
import { CapabilityData } from "../capabilities/capability-data.ts";
import type { McpServerView, MCPTool } from "../mcp/index.ts";
import { SteerBus, type SteerContent, type SteerOptions, type SteerOrigin, type SteerReceipt } from "../loop/steer.ts";
import type { Capability, CapabilityDiagnostic, SessionContext, SessionControls } from "../capabilities/capability.ts";
import { type SubagentRecord, type SubagentStatus } from "./subagent.ts";
import { SystemPromptContextCache, type SystemPromptContext } from "./instruction-context.ts";
import type { GoalStore } from "../capabilities/goal/goal-store.ts";
import type { PlanMode } from "../capabilities/plan/plan-mode.ts";
import type { TodoStore } from "../capabilities/todo/todo-store.ts";
import type { TaskStore } from "../capabilities/task/task-store.ts";
import type { SkillsService } from "../capabilities/skills/service.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { McpServersHandle } from "../mcp/manager.ts";
import type { BackgroundManager } from "../capabilities/background/manager.ts";
import type { CompactionService } from "../capabilities/compaction/service.ts";
import type { EnvironmentFactory } from "../tool/environment.ts";
import type { EventPublicationMode } from "../events/index.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import type { PermissionManagerOptions } from "../permission/manager.ts";

/** The session's whole append log, read once at open and memoized (see `Session.open`). */
export type SessionLogReader = () => Promise<readonly AgentRecord[]>;

let CLOSE_TIMEOUT_MS = 5_000;
/** store.flush persists data (vs. telemetry), so it gets a longer grace. The run journal
 *  is already settled by settleRun's context.flush() before close — this is only a
 *  best-effort tail sync of whatever the store implementation buffers itself. */
let STORE_FLUSH_TIMEOUT_MS = 15_000;

/** Test-only (exported via `operon-agents-core/internal`): shrink the close deadlines
 *  so hang-isolation tests don't wait wall-clock seconds. */
export function setSessionCloseTimeoutsForTest(ms: { close?: number; storeFlush?: number }): void {
  if (ms.close !== undefined) CLOSE_TIMEOUT_MS = ms.close;
  if (ms.storeFlush !== undefined) STORE_FLUSH_TIMEOUT_MS = ms.storeFlush;
}


let sessionCounter = 0;

export function newSessionId(): string {
  sessionCounter += 1;
  return `s${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
}

/**
 * What `Session.open` takes besides the scope. Everything with a lifetime — environment, store,
 * events, steer, responder, logger, permission options — is READ FROM THE SCOPE, registered
 * there by whoever opened it (the harness, a runner, a test). `open` only fills the gaps with
 * defaults (`provide`), never overrides what the creator registered.
 */
export interface SessionOpenOptions {
  readonly capabilities?: readonly Capability[];
  /**
   * This session's id. Defaults to a fresh one.
   *
   * An ARGUMENT, not a service: it has no lifetime to manage, nothing inherits it from a parent
   * scope, and nobody shares it — a capability reads `ctx.sessionId`. It used to be registered on
   * the scope only because `open` took no other parameter, which made the registry double as a
   * parameter list.
   */
  readonly sessionId?: string;
  /** The host's cancel handle. The session's own signal is derived from it, never replaces it. */
  readonly signal?: AbortSignal;
  /**
   * The durable store behind this session (disk / Pg / Redis / memory). Omit for a storeless,
   * in-memory session. `open` wraps it so record-backed events publish on commit and hands
   * THAT wrapper out as `SessionContext.store` — which is what capabilities and the loop write
   * through.
   */
  readonly store?: SessionStore;
  /**
   * The session's full append log, pre-read by the caller. `open` then skips its own
   * `readLog` and every open-time consumer (log-fold capabilities, context pre-build)
   * folds THESE records — sharing the read AND the `Message` object graph with whatever
   * else the caller seeded from them (e.g. a `SessionProjection`), instead of holding a
   * second parsed+blob-rehydrated copy for the session's lifetime.
   * Must be the complete log (all addresses, append order) as `readRecords()` returns it.
   */
  readonly preloadedLog?: readonly AgentRecord[];
  /** Reopened from a store (vs created fresh). Only telemetry cares; the stream cannot tell. */
  readonly resumed?: boolean;

  // ── What the host injects. Passed by value: a session is handed its dependencies, it does
  //    not go looking for them, and what is not passed here it does not have. ──────────────
  /**
   * Where this session's tools execute: an instance, or a factory called once with the session's
   * id and signal. Omitted, the session gets a `NullEnvironment` — no filesystem, and any file
   * tool that slips through fails loudly instead of touching the host disk.
   *
   * The session only OPERATES it. Disposal stays with whoever created it: a sandbox usually
   * outlives any one session, so closing a session must not pull it out from under the others.
   */
  readonly environment?: Environment | EnvironmentFactory;
  readonly events?: EventSink;
  readonly steer?: SteerBus;
  /** Answers permission prompts live (as opposed to the interrupt/resume path). */
  readonly responder?: Responder;
  readonly permissionOptions?: PermissionManagerOptions;
  readonly logger?: Logger;
  readonly tracing?: TracingProcessor;
  /** Product telemetry (docs/telemetry.md). Absent = nothing is counted. */
  readonly telemetry?: TelemetryService;
  readonly eventPublication?: EventPublicationMode;
  /** Spawns background work when no background capability is open. */
  readonly spawner?: BackgroundSpawner;
}

/** The current owner and root conversation shard for the next user prompt. */
export interface ConversationHead {
  readonly agentKey: string;
  readonly address: string;
}

export interface BackgroundTaskListOptions {
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export interface ReadBackgroundTaskOutputOptions {
  readonly maxBytes?: number;
}

export interface ReadBackgroundTaskOutputDeltaOptions {
  readonly cursor: number;
  readonly maxBytes?: number;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly budget?: GoalBudgetInput;
}

export interface GoalBudgetInput {
  readonly turns?: number;
  readonly tokens?: number;
  readonly wallClockMs?: number;
}

export interface GoalStatusInput {
  readonly reason?: string;
}

export interface PlanModeOptions {
  readonly createFile?: boolean;
}

/**
 * The narrow session surface a runtime frame (`RunState.session`) may touch. The full
 * `Session` carries every capability convenience; the engine and the spawn tools must not
 * depend on that breadth — everything they are allowed to reach is enumerated here, so a
 * new dependency on session state is an explicit interface change, not a silent grab.
 * Settings exposed as getters (`modelSetting`/`thinkingSetting`) stay lazy on purpose:
 * they take effect per step, never snapshotted at run start.
 */
export interface SessionPort {
  readonly store?: SessionStore;
  readonly logger: Logger;
  /** Per-address file-freshness ledger (read-before-write state shared across turns). */
  fileLedgerFor(address: string): FileFreshnessLedger;
  /** Session model override; wins over the agent's own model. */
  readonly modelSetting: string | ChatModel | undefined;
  readonly thinkingSetting: ThinkingLevel | undefined;
  /** Compaction service view: reserved headroom plus full-compaction invalidation revision.
   *  PROBE, unlike `Session.compaction` — the loop runs fine without the capability. */
  readonly compactionView: { readonly reservedContextTokens: number; readonly revision: number } | undefined;
  /** A resume journal for one workflow run, bound to this session's store (the workflow
   *  capability's manager, or the session's in-memory fallback) — all the kernel's `Workflow`
   *  tool needs; the manager itself stays behind `session.workflow`. */
  newWorkflowJournal(runId: string, parentToolCallId?: string): WorkflowJournal;
  resolveSystemPromptContext(environment: Environment): Promise<SystemPromptContext>;
  recordContextBreakdown(breakdown: ContextBreakdown): void;
  flushEvents(): Promise<void>;
  setLiveContext(address: string, ctx: ConversationContext): void;
  setConversationHead(head: ConversationHead): void;
  /** Register a forked frame's inbox; the returned function unregisters it. */
  registerFrameBus(address: string, bus: SteerBus): () => void;
}

/** An attach or detach waiting for a moment with no run in flight. */
interface PendingCapabilityChange {
  readonly apply: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Service access on a session has two tiers, one rule each:
 *  - PROBE — `session.service("x")` returns `undefined` when that capability is not open
 *    (the capability is not open). Use it to feature-test.
 *  - REQUIRE — `session.requireService("x")` and the convenience wrappers (`createCronTask()`,
 *    `compact()`, `listSkills()`, …) assume the service and throw `ServiceUnavailableError`
 *    when it is missing.
 * The only exceptions are list views documented as degrading to empty when the capability
 * is off (`listWorkflows`, `listSubagents`, `listMcpServers`) — views over durable state
 * that stay meaningful on a session opened without the capability.
 *
 * The session OWNS what its capabilities opened: `close()` runs every `closeSession` in reverse
 * open order, each under a deadline.
 */
export class Session implements SessionPort {
  readonly id: string;
  /** What each open capability published, by capability name. See `service()`. */
  private readonly services = new Map<string, unknown>();
  /** The host's spawner, used when no background capability is open. */
  private readonly injectedSpawner: BackgroundSpawner | undefined;
  /** Open capabilities in registration order — closed in reverse. */
  private openedForClose: readonly Capability[] = [];
  readonly environment: Environment;
  readonly store?: SessionStore;
  readonly events: EventSink;
  private readonly eventPublisher: SessionEventPublisher;
  readonly responder?: Responder;
  private readonly permissionOptions: PermissionManagerOptions | undefined;
  readonly steer: SteerBus;
  readonly signal: AbortSignal;
  /** Upstream of `signal`. Fires only via `abort()`; a host signal aborts independently. */
  private readonly ownController: AbortController;
  readonly logger: Logger;
  private readonly tracing?: TracingProcessor;
  private readonly unsubscribeTracing?: () => void;
  private readonly unsubscribeTelemetry?: () => void;

  private readonly allCapabilities: readonly Capability[];
  // Runtime prompt data is live-Session state, not Agent state: environment identity + cwd isolate
  // root/subagent/worktree frames, and the date stays fixed for the Session's lifetime.
  private readonly systemPromptContexts = new SystemPromptContextCache();
  // Live in-memory conversation context per address, kept across turns so a long-lived session
  // appends instead of replaying the whole log each turn. Invalidated when the log is rewritten.
  private readonly liveContexts = new Map<string, ConversationContext>();
  /** Inboxes of frames currently running under this session, keyed by journal address. */
  private readonly frameBuses = new Map<string, SteerBus>();
  // Rebuildable cache of the leaf reached by following durable `agent.handoff` records from
  // `main`. Storeless sessions keep the same state here for their in-memory lifetime.
  private activeConversationHead: ConversationHead | undefined;
  // File freshness ledger per address (mirrors liveContexts): each agent line — main agent and
  // every subagent — has its own read-before-write state, persisted across turns/runs. A subagent
  // has not "read" what its parent read, so ledgers are never shared across addresses.
  private readonly fileLedgers = new Map<string, FileFreshnessLedger>();
  private modelOverride?: string | ChatModel;
  /** Caller-supplied one-shot log for open (see SessionOpenOptions.preloadedLog); cleared after
   *  provisionCapabilities so the array itself is not pinned for the session's lifetime. */
  private preloadedLog?: readonly AgentRecord[];
  private thinkingOverride?: ThinkingLevel;
  private provisionedCapabilities: readonly Capability[] = [];
  private isOpen = false;
  /** False once `close()` has started. What the scope's `state` used to answer. */
  get open(): boolean {
    return this.isOpen;
  }
  /** The one close in flight (or finished): every `close()` call returns THIS promise. */
  private closing: Promise<void> | undefined;
  private runChain: Promise<void> = Promise.resolve();
  private readonly pendingDiagnostics: CapabilityDiagnostic[] = [];
  /** Builds the context a capability is opened with; set by `openCapabilities`, reused by attach. */
  private contextFor: ((owner: string) => SessionContext) | undefined;
  /** Runs currently holding an assembly of `capabilities` — see `enterRun` / `exitRun`. */
  private activeRuns = 0;
  /** Attach/detach requests waiting for a moment with no run in flight. */
  private readonly pendingChanges: PendingCapabilityChange[] = [];
  /** Serializes applied changes, and lets `close()` wait for the one in progress. */
  private changeChain: Promise<void> = Promise.resolve();
  // Most-recent per-turn context-window breakdown, stamped by the Runner at each turn boundary.
  // Undefined until the first turn assembles a request.
  private lastContextBreakdown?: ContextBreakdown;
  /** Built at the end of `open`, once every capability's policies are in. */
  private permissionManager?: PermissionManager;

  private constructor(
    id: string,
    signal: AbortSignal,
    ownController: AbortController,
    publisher: SessionEventPublisher,
    environment: Environment,
    opts: SessionOpenOptions,
  ) {
    this.id = id;
    this.signal = signal;
    this.ownController = ownController;
    this.environment = environment;
    this.eventPublisher = publisher;
    // The publishing wrapper around the host's store: record-backed events surface on `events` when
    // the append commits, so everything in the session writes through THIS store.
    this.store = this.eventPublisher.store;
    this.events = this.eventPublisher;
    this.tracing = opts.tracing;
    this.unsubscribeTracing = this.tracing === undefined ? undefined : eventSinkTracingBridge(this.events, this.tracing);
    // Product telemetry rides the same stream. One subscription per session; the projection
    // tells sub-agents apart by address. `resumed` is the one fact the stream cannot tell.
    const telemetry = opts.telemetry;
    this.unsubscribeTelemetry =
      telemetry === undefined
        ? undefined
        : subscribeTelemetryProjection(this.events, telemetry.withContext({ session_id: id }), { resumed: opts.resumed === true });
    this.responder = opts.responder;
    this.injectedSpawner = opts.spawner;
    this.permissionOptions = opts.permissionOptions;
    this.steer = opts.steer ?? new SteerBus();
    // Every enqueue — user steer/follow-up, cron fire, background settle, a managed delivery —
    // is journaled as a `steer.queued` record and surfaces on the event stream. The write is
    // handed back so the producer's receipt can settle on durability; clients render a pending
    // queue from the events and match `origin.steerId` on the consuming `message.appended` to
    // know when the model actually saw it. `steer.queued` is a persisted lifecycle event, so
    // this one emit is both the record and the broadcast.
    this.steer.setEnqueueListener((item) =>
      this.events.emit({
        type: "steer.queued",
        steerId: item.id,
        channel: item.channel,
        origin: item.origin,
        message: item.message,
        address: "main",
        sessionId: id,
      }));
    // Env fallback (`AGENTS_LOG`) is resolved here so every entry point — direct `Session.open`,
    // the Runner's ephemeral session, or the harness — honors it from one place. The harness
    // normally passes its logger in; a session opened directly has nothing else to fall back on.
    this.logger = opts.logger ?? envLogger() ?? noopLogger;
    this.allCapabilities = opts.capabilities ?? [];
    this.preloadedLog = opts.preloadedLog;
  }

  /**
   * Open a session. Everything it depends on arrives in `opts`; `open` fills in the defaults for
   * whatever is missing, builds the session's own objects (signal, event publisher, log reader,
   * controls), opens every capability in order, then builds the permission manager.
   */
  static async open(opts: SessionOpenOptions = {}): Promise<Session> {
    const id = opts.sessionId ?? newSessionId();
    // The session owns a cancel handle of its own, downstream of whatever the host passed in:
    // `session.abort()` stops the session without taking the host's signal away from it, and a
    // host abort still propagates. `AbortSignal.any` owns the listener lifetime for us.
    const ownController = new AbortController();
    const signal = opts.signal === undefined ? ownController.signal : AbortSignal.any([opts.signal, ownController.signal]);
    // Resolved here rather than in the constructor because a factory is async and needs the id.
    const environment =
      opts.environment === undefined
        ? new NullEnvironment()
        : typeof opts.environment === "function"
          ? await opts.environment({ sessionId: id, signal })
          : opts.environment;
    // The publisher is the session's OWN object — one producer, one consumer, both inside this
    // class — so it is built here and held as a field.
    const publisher = new SessionEventPublisher(id, opts.events ?? new ListenerSink(), opts.store, opts.eventPublication ?? "immediate");
    const session = new Session(id, signal, ownController, publisher, environment, opts);
    await session.openCapabilities();
    return session;
  }

  /**
   * Build every capability's declared services and register them.
   *
   * Each capability is handed its own view of the session: the shared objects plus a
   * `state` / `records` / `record` partitioned by its name. The per-RUN pair is `start`/`stop`,
   * which the assembler drives.
   */
  private async openCapabilities(): Promise<void> {
    // Shared restore: read the log at most once and let every log-fold capability
    // (goal/plan/todo) reconstruct from that one read via `SessionContext.logRecords`, then reuse it to
    // pre-build the main conversation context — instead of each capability, plus the first
    // run's `replayContext`, re-reading the log separately. A caller-preloaded log IS that
    // one read, done outside.
    let log: readonly AgentRecord[] | undefined = this.preloadedLog;
    this.preloadedLog = undefined;
    const logRecords: SessionLogReader = async () => {
      if (log === undefined) log = await readLog(this.store);
      return log;
    };
    const data = new CapabilityData({
      ...(this.store !== undefined ? { store: this.store } : {}),
      readLog: logRecords,
      append: (body) => this.appendToMain(body),
    });
    const shared = {
      sessionId: this.id,
      environment: this.environment,
      events: this.events,
      signal: this.signal,
      steer: this.steer,
      controls: this.controls(),
      logRecords,
      ...(this.store !== undefined ? { store: this.store } : {}),
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
    };
    const contextFor = (this.contextFor = (owner: string): SessionContext => ({
      ...shared,
      state: data.stateFor(owner),
      records: data.recordsFor(owner),
      record: data.recorderFor(owner),
    }));
    const opened: Capability[] = [];
    const seen = new Set<string>();
    for (const cap of this.allCapabilities) {
      if (seen.has(cap.name)) {
        this.pendingDiagnostics.push({
          capability: cap.name,
          phase: "register",
          level: "error",
          message: `duplicate capability name "${cap.name}"; second registration skipped.`,
        });
        continue;
      }
      seen.add(cap.name);
      try {
        // A capability that throws here is absent for the session — its per-run assembly too,
        // since it is not pushed onto `opened`. An `invariant` one is not allowed to be absent,
        // so its failure fails the open instead.
        await cap.openSession?.(contextFor(cap.name));
      } catch (error) {
        // An `invariant` capability may not be absent, so its failure fails the open — but the
        // capabilities already opened are this session's, and nobody else will close them. Undo
        // them here, newest first, before the error leaves.
        if (cap.contract === "invariant") {
          await this.closeOpened(opened);
          throw error;
        }
        this.pendingDiagnostics.push({
          capability: cap.name,
          phase: "start",
          level: "error",
          message: `openSession failed; capability absent for the session: ${messageOf(error)}`,
        });
        this.logger.log("error", `capability "${cap.name}" openSession failed`, { capability: cap.name, phase: "start", error: messageOf(error) });
        continue;
      }
      if (cap.service !== undefined) this.services.set(cap.name, cap.service);
      opened.push(cap);
    }
    this.provisionedCapabilities = opened;
    this.openedForClose = opened;
    await this.buildPermissionManager(opened, logRecords);
    // A session opened without the workflow capability still needs ONE manager per session (the
    // resume journals of every workflow run in the session must land in the same store).
    if (!this.services.has("workflow")) this.services.set("workflow", new WorkflowManager(this.store));
    // If a capability triggered the log read, reuse those records to seed the main live
    // context so the first run appends to it instead of replaying the log a second time.
    if (log !== undefined && this.store !== undefined && this.liveContext(DEFAULT_ADDRESS) === undefined) {
      const context = new ConversationContext({
        store: this.store,
        address: DEFAULT_ADDRESS,
      });
      context.loadFromRecords([...log]);
      this.setLiveContext(DEFAULT_ADDRESS, context);
    }
    this.isOpen = true;
  }

  /**
   * Journal a capability's record into the main conversation. Through its live context when
   * there is one, so the record keeps its place in the context's write order; straight to the
   * store before the first run has built it. A storeless session with no context keeps nothing
   * durable — `records()` still sees the write, from memory.
   */
  private appendToMain(body: AgentRecordBody): void {
    const context = this.liveContext(DEFAULT_ADDRESS);
    if (context !== undefined) {
      context.record(body);
      return;
    }
    if (this.store === undefined) return;
    this.store.appendRecord({ time: Date.now(), address: DEFAULT_ADDRESS, ...body } as AgentRecord).catch((error: unknown) => {
      this.logger.log("warn", "capability record failed to persist", { error: messageOf(error) });
    });
  }

  // ==========================================================================
  // Capabilities added and removed while the session is open
  // ==========================================================================

  /**
   * Open `capability` in this live session. With no run in flight that is immediate; otherwise it
   * waits for the last run to stop, so a run never sees its capability set change under it — the
   * next run assembles with it. Resolves once `openSession` has run and the capability is part of
   * the session; rejects, leaving nothing behind, when it throws.
   *
   * Only a `detachable` capability can come and go: an `invariant` one (permission, compaction)
   * is part of the session from open — its policies were folded into the permission manager then.
   */
  attachCapability(capability: Capability): Promise<void> {
    return this.submitChange(() => this.attachNow(capability));
  }

  /** Close and remove a `detachable` capability, at the same quiet point `attachCapability` uses. */
  detachCapability(name: string): Promise<void> {
    return this.submitChange(() => this.detachNow(name));
  }

  /** @internal The Runner is about to assemble `capabilities` for a run. Pair with `exitRun`. */
  enterRun(): void {
    this.activeRuns += 1;
  }

  /** @internal The run has stopped its capabilities. The last one out applies queued changes. */
  async exitRun(): Promise<void> {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns === 0) await this.drainChanges();
  }

  private submitChange(apply: () => Promise<void>): Promise<void> {
    if (this.closing !== undefined || !this.isOpen) return Promise.reject(new Error("session is closed"));
    return new Promise<void>((resolve, reject) => {
      this.pendingChanges.push({ apply, resolve, reject });
      if (this.activeRuns === 0) void this.drainChanges();
    });
  }

  private drainChanges(): Promise<void> {
    const next = this.changeChain.then(async () => {
      while (this.pendingChanges.length > 0 && this.activeRuns === 0) {
        const change = this.pendingChanges.shift()!;
        try {
          if (this.closing !== undefined) throw new Error("session is closed");
          await change.apply();
          change.resolve();
        } catch (error) {
          change.reject(error);
        }
      }
    });
    this.changeChain = next.catch(() => undefined);
    return this.changeChain;
  }

  private async attachNow(capability: Capability): Promise<void> {
    const name = capability.name;
    // Colon-free: the name partitions state and records (`extension:<name>:`), and a colon would
    // let one capability's partition swallow another's.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      throw new Error(`capability name "${name}" must be a slug ([A-Za-z0-9_.-], no colons)`);
    }
    if (capability.contract === "invariant") {
      throw new Error(`capability "${name}" is invariant: it is part of the session from open and cannot be attached later`);
    }
    if (this.provisionedCapabilities.some((open) => open.name === name)) {
      throw new Error(`a capability named "${name}" is already open in this session`);
    }
    await capability.openSession?.(this.contextFor!(name));
    if (capability.service !== undefined) this.services.set(name, capability.service);
    this.provisionedCapabilities = [...this.provisionedCapabilities, capability];
    this.openedForClose = [...this.openedForClose, capability];
  }

  private async detachNow(name: string): Promise<void> {
    const capability = this.provisionedCapabilities.find((open) => open.name === name);
    if (capability === undefined) throw new Error(`no capability named "${name}" is open in this session`);
    if (capability.contract === "invariant") {
      throw new Error(`capability "${name}" is invariant and cannot be detached`);
    }
    // Out of the session first — nothing assembles it again — then torn down.
    this.provisionedCapabilities = this.provisionedCapabilities.filter((open) => open !== capability);
    this.openedForClose = this.openedForClose.filter((open) => open !== capability);
    if (this.services.get(name) === capability.service) this.services.delete(name);
    if (capability.closeSession === undefined) return;
    try {
      await withTimeout(Promise.resolve(capability.closeSession("detach")), CLOSE_TIMEOUT_MS);
    } catch (error) {
      this.logger.log("warn", `capability "${name}" closeSession failed/timed out on detach`, { capability: name, phase: "stop", error: messageOf(error) });
    }
  }

  /** Close capabilities in reverse open order, each fault-isolated: used to undo a failed open. */
  private async closeOpened(opened: readonly Capability[]): Promise<void> {
    for (const cap of [...opened].reverse()) {
      if (cap.closeSession === undefined) continue;
      try {
        await withTimeout(Promise.resolve(cap.closeSession("close")), CLOSE_TIMEOUT_MS);
      } catch (error) {
        this.logger.log("warn", `capability "${cap.name}" closeSession failed while undoing a failed open`, {
          capability: cap.name,
          phase: "stop",
          error: messageOf(error),
        });
      }
    }
  }

  /**
   * Construct the session-lived PermissionManager: capability policy slots are collected from
   * the opened capabilities' static `policies` (session-tier fault isolation: a capability whose
   * provision failed contributes nothing; a per-run `start()` failure does NOT retract its
   * policies — they are pure evaluators over session-lived state). Then runtime permission
   * state is folded back from the log — `permission.set_mode` (last wins) and approve-for-session
   * grants (`permission.record_approval` with scope "session").
   */
  private async buildPermissionManager(
    opened: readonly Capability[],
    logRecords: SessionLogReader,
  ): Promise<void> {
    const overrides = new Map<string, PermissionPolicy>();
    for (const capability of opened) {
      for (const policy of capability.policies ?? []) {
        if (!STAGED_POLICY_SLOTS.has(policy.name)) {
          this.pendingDiagnostics.push({
            capability: capability.name,
            phase: "register",
            level: "warn",
            message: `policy "${policy.name}" matches no reserved staged slot; ignored.`,
          });
          continue;
        }
        if (overrides.has(policy.name)) {
          this.pendingDiagnostics.push({
            capability: capability.name,
            phase: "register",
            level: "warn",
            message: `policy slot "${policy.name}" already filled; "${capability.name}" duplicate ignored.`,
          });
          continue;
        }
        overrides.set(policy.name, policy);
      }
    }

    const options = this.permissionOptions;
    const permission = new PermissionManager({
      ...options,
      mode: options?.mode,
      // The Runner-driven path answers approvals via interrupt/resume (or the live responder
      // in onInterrupt) — never inline through the manager, so it gets no responder here.
      responder: undefined,
      cwd: options?.cwd ?? safeCwd(this.environment),
      pathClass: options?.pathClass ?? this.environment.pathClass(),
      environment: options?.environment ?? this.environment,
      policyOverrides: overrides,
      logger: this.logger,
    });
    this.permissionManager = permission;

    if (this.store === undefined) return;
    for (const record of await logRecords()) {
      if (record.type === "permission.set_mode") {
        permission.setMode(record.mode as PermissionMode);
      } else if (
        record.type === "permission.record_approval" &&
        record.decision === "approved" &&
        record.scope === "session" &&
        record.approvalRule !== undefined
      ) {
        permission.applyApproval(record.approvalRule, { decision: "approved", scope: "session" });
      }
    }
  }

  /** The session-lived permission manager (policy chain + mode + approval memory). Built by
   *  `open` once every capability's policies are known; another session's manager is meaningless,
   *  so it is a field rather than a registry entry. */
  get permission(): PermissionManager {
    if (this.permissionManager === undefined) throw new Error("the permission manager is built during Session.open");
    return this.permissionManager;
  }

  get capabilities(): readonly Capability[] {
    return this.provisionedCapabilities;
  }

  /** PROBE tier: what the capability named `name` published, or undefined when it is not open. */
  service<S = unknown>(name: string): S | undefined {
    return this.services.get(name) as S | undefined;
  }
  /** REQUIRE tier: the same, or a throw naming the capability that would have provided it. */
  requireService<S = unknown>(name: string): S {
    const found = this.services.get(name);
    if (found === undefined) throw new Error(`no capability named "${name}" is open in this session`);
    return found as S;
  }
  // ── capability services ───────────────────────────────────────────────────────────────
  // One accessor per capability, instead of a facade method per operation.
  //
  // Which tier an accessor belongs to is decided by ONE question: when the capability is not
  // open, is that a FAILURE or an ANSWER?
  //  - A failure → REQUIRE (`T`). Asking for a goal on a session with no goal capability is a
  //    configuration mistake, and the throw names the capability that provides it. Returning
  //    `undefined` here would turn a misconfiguration into a silent no-op.
  //  - An answer → PROBE (`T | undefined`). A session with no MCP has no servers to report; a
  //    session with no background capability has no past runs. The caller has something
  //    sensible to do with "none", and the emptiness stays visible at the call site.
  //
  // To FEATURE-TEST a REQUIRE accessor, use `session.service("goal")`. Not `session.goal?.…`:
  // optional chaining guards a null result, not a throwing getter, so it reads as safe and is
  // not.
  //
  // These accessors are the one place core names capabilities (§3.4 holds for their BEHAVIOUR:
  // the kernel and the assembler know only interfaces). It is a deliberate trade: `session.goal`
  // over `session.requireService("goal")` at 58 call sites, paid for by this class listing eleven
  // capability names. A host's own capability is reached through `session.require(tok)` and
  // needs nothing here.
  //
  // The operations themselves live on the services, where the state they change lives: a goal
  // transition announces itself because `GoalStore` announces it, not because a facade method
  // remembered to.

  /** The workflow manager: the capability's, or the in-memory fallback `open` provides. */
  get workflow(): WorkflowManager {
    return this.requireService<WorkflowManager>("workflow");
  }
  get goal(): GoalStore {
    return this.requireService<GoalStore>("goal");
  }
  get plan(): PlanMode {
    return this.requireService<PlanMode>("plan");
  }
  get todo(): TodoStore {
    return this.requireService<TodoStore>("todo");
  }
  get task(): TaskStore {
    return this.requireService<TaskStore>("task");
  }
  get skills(): SkillsService {
    return this.requireService<SkillsService>("skills");
  }
  get plugins(): PluginManager {
    return this.requireService<PluginManager>("plugins");
  }
  /** The MCP control plane. Absent when no MCP capability is open — hence `get`, not `require`:
   *  a session without MCP has no servers to report, and that is an answer, not a failure. */
  get mcp(): McpServersHandle | undefined {
    return this.service<McpServersHandle>("mcp");
  }
  newWorkflowJournal(runId: string, parentToolCallId?: string): WorkflowJournal {
    return this.workflow.newJournal(runId, parentToolCallId);
  }
  get compaction(): CompactionService {
    return this.requireService<CompactionService>("compaction");
  }
  /** The PROBE view of the same service, for the loop: absent when compaction is not open. */
  get compactionView(): CompactionService | undefined {
    return this.service<CompactionService>("compaction");
  }
  /** The spawner the Agent/Workflow tools use: the background capability's manager, else the
   *  host-injected `spawner` (`SessionOpenOptions.spawner`). */
  get spawner(): BackgroundSpawner | undefined {
    return this.service<BackgroundManager>("background") ?? this.injectedSpawner;
  }

  /**
   * The durable task ledger — background tasks, subagents and workflow runs.
   *
   * PROBE tier (`| undefined`), unlike the accessors above, and deliberately: a session opened
   * without the background capability has no past runs, which is an ANSWER — so a caller writes
   * `session.background?.listSubagents() ?? []` and the emptiness is visible at the call site
   * instead of hidden inside a facade method. Callers that genuinely require it (stopping a
   * task, detaching a tool call) should say so with `session.requireService("background")`.
   */
  get background(): BackgroundManager | undefined {
    return this.service<BackgroundManager>("background");
  }

  /** The most-recent context-window breakdown (system/tools/messages/injections/free), stamped
   *  by the Runner at each turn boundary — or undefined if no turn has assembled a request yet.
   *  A read-only snapshot: it reflects the last turn sent, not a fresh recomputation. */
  getContextBreakdown(): ContextBreakdown | undefined {
    return this.lastContextBreakdown;
  }

  /** Runner-internal: record the breakdown assembled for the turn about to be sent. */
  recordContextBreakdown(breakdown: ContextBreakdown): void {
    this.lastContextBreakdown = breakdown;
  }

  // ── Conversation log (flat, linear) ──────────────────────────────────────────────────────
  // The log is a single append-only record stream per address (no branching). `getRecords`
  // exposes it read-only for inspection / transcript rendering.

  /** Every record of an address in append order (for rendering the transcript). */
  async getRecords(address?: string): Promise<AgentRecord[]> {
    if (this.store === undefined) {
      throw new Error("Session has no store; the conversation log requires a durable store.");
    }
    const records: AgentRecord[] = [];
    for await (const record of this.store.readRecords({ ...(address !== undefined ? { address } : {}) })) records.push(record);
    return records;
  }

  // ── live context cache (perf: append across turns instead of replaying the log) ──
  /** @internal The kept live context for an address, or undefined (cold → caller replays). */
  liveContext(address: string): ConversationContext | undefined {
    return this.liveContexts.get(address);
  }
  /** @internal Cache the live context so the next turn on this address reuses it. */
  setLiveContext(address: string, ctx: ConversationContext): void {
    this.liveContexts.set(address, ctx);
  }
  /**
   * @internal Register a running frame's inbox so `steerTo` can reach it.
   *
   * Called when a subagent frame is forked; the returned function unregisters. Guarded by identity
   * so a late unregister from a finished run cannot evict a newer frame that reused the address.
   */
  registerFrameBus(address: string, bus: SteerBus): () => void {
    this.frameBuses.set(address, bus);
    return () => {
      if (this.frameBuses.get(address) === bus) this.frameBuses.delete(address);
    };
  }

  /**
   * Hand a message to the frame running at `address`; undefined when nobody is there.
   *
   * This is the whole seam an external coordinator needs in order to address a subagent: it can
   * already learn who exists from `agent.started` / `agent.ended` (both carry `address`), but it
   * has no way to reach a child's queue — every frame owns a private `SteerBus`. Deliberately
   * knows nothing about peers, rosters or visibility: those are policy, and policy belongs to
   * whoever is coordinating, not to the engine.
   */
  steerTo(address: string, content: SteerContent, origin: SteerOrigin, options?: SteerOptions): SteerReceipt | undefined {
    const bus = address === DEFAULT_ADDRESS ? this.steer : this.frameBuses.get(address);
    if (bus === undefined) return undefined;
    return bus.steer(content, origin, options);
  }

  /** @internal Cached conversation owner. Durable sessions can always rebuild it from the log. */
  conversationHead(): ConversationHead | undefined {
    return this.activeConversationHead;
  }
  /** @internal Update the cache only after the source-side handoff commit has been flushed. */
  setConversationHead(head: ConversationHead): void {
    this.activeConversationHead = head;
  }
  /** @internal Force the next prompt to fold the handoff chain again. */
  invalidateConversationHead(): void {
    this.activeConversationHead = undefined;
  }
  /** Drop the cached live context(s) so the next turn replays from the store (e.g. after a log
   *  rewrite, or an out-of-band store mutation). Omit `address` to clear all. */
  invalidateLiveContext(address?: string): void {
    if (address === undefined) this.liveContexts.clear();
    else this.liveContexts.delete(address);
    this.invalidateConversationHead();
  }

  /** The file freshness ledger for one agent line (address); created on first use and kept for
   *  the session lifetime, so read-before-write state survives across turns and run() calls. */
  fileLedgerFor(address: string): FileFreshnessLedger {
    let ledger = this.fileLedgers.get(address);
    if (ledger === undefined) {
      ledger = new FileFreshnessLedger();
      this.fileLedgers.set(address, ledger);
    }
    return ledger;
  }

  /** Resolve environment + AGENTS.md for the active runtime frame, cached for this Session. */
  resolveSystemPromptContext(environment: Environment): Promise<SystemPromptContext> {
    return this.systemPromptContexts.resolve(environment, this.compactionView?.revision ?? 0);
  }

  /**
   * The `SessionControls` view handed to capabilities that act on the session (the extension
   * runtime's `ctx.actions`). Bound methods over the same public operations a host would call —
   * no new reach, just a typed handle that does not leak the whole Session.
   */
  controls(): SessionControls {
    return {
      abort: (reason) => this.abort(reason),
      compact: async (options) => this.compaction.request(options),
      getContextBreakdown: () => this.getContextBreakdown(),
      setModel: (model) => this.setModel(model),
      setThinking: (level) => this.setThinking(level),
    };
  }

  /**
   * Cancel the session: every run riding `session.signal` unwinds as `status: "aborted"`.
   * The reason is shaped as an `AbortError` so the loop classifies it as cancellation rather
   * than as a failure (see `isAbortError`). Idempotent — a second call is a no-op.
   */
  abort(reason?: string): void {
    if (this.ownController.signal.aborted) return;
    this.ownController.abort(abortReason(reason ?? "session aborted"));
  }

  setModel(model: string | ChatModel): void {
    this.modelOverride = model;
  }
  setThinking(level: ThinkingLevel): void {
    this.thinkingOverride = level;
  }
  /**
   * Switch the permission mode. Takes effect in memory immediately — policies read the
   * manager's mode lazily at each tool authorization, so the next tool call (mid-turn
   * included) sees it. The returned promise settles when the mode is also journaled
   * (so it survives reopen) and REJECTS if that persistence fails, so callers who care
   * about durability can surface the failure. Fire-and-forget callers may ignore it:
   * the in-memory switch has already happened, and the failure is still logged (the
   * rejection is pre-handled internally, so ignoring it never trips unhandledRejection).
   */
  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permission.setMode(mode);
    if (this.store === undefined) return Promise.resolve();
    const persisted = this.store.appendRecord({ type: "permission.set_mode", mode, address: DEFAULT_ADDRESS });
    persisted.catch((error) => {
      this.logger.log("warn", "failed to journal permission.set_mode", { error: error instanceof Error ? error.message : String(error) });
    });
    return persisted.then(() => undefined);
  }
  get modelSetting(): string | ChatModel | undefined {
    return this.modelOverride;
  }
  get thinkingSetting(): ThinkingLevel | undefined {
    return this.thinkingOverride;
  }
  get permissionModeSetting(): PermissionMode | undefined {
    return this.permission.mode;
  }

  drainDiagnostics(): CapabilityDiagnostic[] {
    return this.pendingDiagnostics.splice(0, this.pendingDiagnostics.length);
  }

  async withRunLock<T>(body: () => Promise<T>): Promise<T> {
    const prev = this.runChain;
    let release!: () => void;
    this.runChain = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      return await body();
    } finally {
      release();
    }
  }

  flushEvents(): Promise<void> {
    return this.eventPublisher.flush();
  }

  /**
   * Close the session: flush telemetry and the store, then close the scope — which disposes
   * every capability provision in reverse order (each under a deadline) and finally the
   * session's own infrastructure. Every call returns the SAME promise, so a second caller
   * (or the facade above) waits for the teardown instead of returning while it is still running.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = this.isOpen ? this.runClose() : Promise.resolve();
    return this.closing;
  }

  private async runClose(): Promise<void> {
    this.isOpen = false;
    // Nothing queued will be applied now; one already being applied finishes first, so the
    // capability it opens is on the list the teardown below walks.
    for (const change of this.pendingChanges.splice(0)) change.reject(new Error("session is closed"));
    await this.changeChain;
    this.systemPromptContexts.clear();
    this.unsubscribeTracing?.();
    this.unsubscribeTelemetry?.();
    this.provisionedCapabilities = [];
    try {
      await withTimeout(Promise.resolve(this.tracing?.forceFlush()), CLOSE_TIMEOUT_MS);
    } catch (error) {
      this.pendingDiagnostics.push({
        capability: "tracing",
        phase: "stop",
        level: "warn",
        message: `forceFlush failed/timed out: ${messageOf(error)}`,
      });
      this.logger.log("warn", "tracing forceFlush failed/timed out", { capability: "tracing", phase: "stop", error: messageOf(error) });
    }
    try {
      await withTimeout(this.eventPublisher.flush(), STORE_FLUSH_TIMEOUT_MS);
      await withTimeout(Promise.resolve(this.store?.flush?.()), STORE_FLUSH_TIMEOUT_MS);
    } catch (error) {
      this.pendingDiagnostics.push({
        capability: "store",
        phase: "stop",
        level: "warn",
        message: `store flush failed/timed out: ${messageOf(error)}`,
      });
      this.logger.log("warn", "store flush failed/timed out", { capability: "store", phase: "stop", error: messageOf(error) });
    }
    // Capabilities go down in reverse open order, each under CLOSE_TIMEOUT_MS: a straggler is
    // abandoned (and logged) so close() can never hang on one of them, and a failure is isolated
    // so the ones after it still get torn down. The environment is NOT closed here: its lifetime
    // belongs to whoever created it, and a sandbox usually outlives any one session.
    for (const cap of [...this.openedForClose].reverse()) {
      if (cap.closeSession === undefined) continue;
      try {
        await withTimeout(Promise.resolve(cap.closeSession("close")), CLOSE_TIMEOUT_MS);
      } catch (error) {
        this.pendingDiagnostics.push({ capability: cap.name, phase: "stop", level: "warn", message: `closeSession failed/timed out: ${messageOf(error)}` });
        this.logger.log("warn", `capability "${cap.name}" closeSession failed/timed out`, { capability: cap.name, phase: "stop", error: messageOf(error) });
      }
    }
    this.services.clear();
  }

  /** Public URL for a port inside the environment, or undefined when the backend can't expose one. */
  async resolveExposedPort(port: number): Promise<string | undefined> {
    return await this.environment.exposedPortUrl?.(port);
  }
}

function normalizeGoalBudget(input: GoalBudgetInput): GoalBudgetInput {
  let fields = 0;
  const budget: { turns?: number; tokens?: number; wallClockMs?: number } = {};
  if (input.turns !== undefined) {
    budget.turns = positiveInt("turns", input.turns);
    fields += 1;
  }
  if (input.tokens !== undefined) {
    budget.tokens = positiveInt("tokens", input.tokens);
    fields += 1;
  }
  if (input.wallClockMs !== undefined) {
    budget.wallClockMs = positiveInt("wallClockMs", input.wallClockMs);
    fields += 1;
  }
  if (fields === 0) throw new Error("At least one goal budget field is required.");
  return budget;
}

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Goal budget ${name} must be a positive integer.`);
  return value;
}

function safeCwd(environment: Environment): string {
  try {
    return environment.getcwd();
  } catch {
    return "";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plain text of a message content (string, or the text parts of a content array). */
/**
 * `AbortController.abort(x)` stores `x` verbatim as `signal.reason`, and `throwIfAborted()`
 * rethrows exactly that. The loop classifies cancellation by `error.name === "AbortError"`
 * (`isAbortError`), so a caller-supplied reason has to be wrapped, or an intentional abort
 * would surface as a run failure.
 */
export function abortReason(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── Background agent-task → SubagentRecord projection ──────────────────────────
// A background subagent is a task of kind "agent"; its SubagentRecord view is derived from
// the task's persisted info, replacing the old conversation fold.

const SUBAGENT_STATUS_SET: ReadonlySet<string> = new Set<SubagentStatus>([
  "running",
  "completed",
  "error",
  "paused",
  "cancelled",
  "lost",
]);

function taskToSubagentRecord(info: BackgroundTaskInfo): SubagentRecord | undefined {
  if (info.kind !== "agent" || info.agentId === undefined) return undefined;
  if (info.outputRef?.kind !== "conversation") return undefined;
  const address = info.outputRef.address;
  return {
    agentId: info.agentId,
    type: info.subagentType ?? "unknown",
    address,
    description: info.description,
    background: true,
    taskId: info.taskId,
    createdAt: info.startedAt,
    status: subagentStatusFromTask(info.status, info.agentStatus),
    updatedAt: info.endedAt ?? info.startedAt,
  };
}

/** Map a background task status to the finer subagent status, preferring the run's own
 *  `agentStatus` (e.g. "paused") when it reported one. */
function subagentStatusFromTask(status: BackgroundTaskStatus, agentStatus?: string): SubagentStatus {
  if (agentStatus !== undefined && SUBAGENT_STATUS_SET.has(agentStatus)) return agentStatus as SubagentStatus;
  switch (status) {
    case "completed":
      return "completed";
    case "killed":
      return "cancelled";
    case "paused":
      return "paused";
    case "lost":
      return "lost";
    case "running":
      return "running";
    default:
      return "error"; // failed / timed_out
  }
}

// ── Background workflow-task → WorkflowSnapshot projection ─────────────────────
// A background workflow run is a task of kind "workflow"; its discovery row is derived from the
// task's persisted info, replacing the old conversation fold (WorkflowSnapshotStore).

const WORKFLOW_STATUS_SET: ReadonlySet<string> = new Set<WorkflowSnapshotStatus>([
  "running",
  "completed",
  "failed",
  "aborted",
]);

function taskToWorkflowSnapshot(info: BackgroundTaskInfo): WorkflowSnapshot | undefined {
  if (info.kind !== "workflow" || info.runId === undefined) return undefined;
  return {
    runId: info.runId,
    workflowName: info.workflowName ?? "unknown",
    description: info.description,
    status: workflowStatusFromTask(info.status, info.runStatus),
    background: true,
    taskId: info.taskId,
    startedAt: new Date(info.startedAt).toISOString(),
    endedAt: info.endedAt !== null ? new Date(info.endedAt).toISOString() : undefined,
  };
}

/** Map a background task status to the workflow discovery status, preferring the run's own
 *  `runStatus` (e.g. "failed") when it reported one. */
function workflowStatusFromTask(status: BackgroundTaskStatus, runStatus?: string): WorkflowSnapshotStatus {
  if (runStatus !== undefined && WORKFLOW_STATUS_SET.has(runStatus)) return runStatus as WorkflowSnapshotStatus;
  switch (status) {
    case "completed":
      return "completed";
    case "killed":
    case "lost":
      return "aborted";
    case "running":
      return "running";
    default:
      return "failed"; // failed / timed_out
  }
}
