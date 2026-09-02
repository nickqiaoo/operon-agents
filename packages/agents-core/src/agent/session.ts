import type { Machine, MachineFactory, MachineOpenContext } from "../tool/machine.ts";
import { FileFreshnessLedger } from "../tool/file-freshness.ts";
import type { ChatModel } from "../llm/define-model.ts";
import type { ThinkingLevel } from "../llm/model.ts";
import type { PermissionMode, PermissionPolicy, Responder } from "../permission/types.ts";
import { PermissionManager, type PermissionManagerOptions } from "../permission/manager.ts";
import { STAGED_POLICY_SLOTS } from "../permission/policies.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import { NullMachine } from "../tool/machine-null.ts";
import type {
  BackgroundManager,
  BackgroundTaskInfo,
  BackgroundTaskOutputDelta,
  BackgroundTaskOutputSnapshot,
  BackgroundTaskStatus,
} from "../capabilities/background/index.ts";
import type { GoalSnapshot, GoalStore } from "../capabilities/goal/index.ts";
import type { WorkflowManager } from "../capabilities/workflow/index.ts";
import type { WorkflowSnapshot, WorkflowSnapshotStatus } from "./workflow/snapshot.ts";
import type { ContextBreakdown } from "./context-report.ts";
import type { PlanData, PlanMode } from "../capabilities/plan/index.ts";
import type { CompactRequestOptions, CompactionService, PendingCompaction } from "../capabilities/compaction/index.ts";
import type {
  ActivateSkillRequest,
  SkillActivationResult,
  SkillSummary,
  SkillsService,
} from "../capabilities/skills/index.ts";
import type { PluginInfo, PluginManager, PluginSummary, ReloadSummary } from "../plugins/index.ts";
import {
  type EventPublicationMode,
  type EventSink,
  joinAddress,
  ListenerSink,
  SessionEventPublisher,
} from "../events/index.ts";
import { type Logger, envLogger, noopLogger } from "../logging/index.ts";
import { type AgentRecord, DEFAULT_ADDRESS, type SessionStore } from "../store/index.ts";
import { eventSinkTracingBridge, type TracingProcessor } from "../tracing/index.ts";
import { ConversationContext } from "../loop/context.ts";
import { readLog } from "../capabilities/capability-state.ts";
import type { McpServersHandle, McpServerView, MCPTool } from "../mcp/index.ts";
import { SteerBus, steerOriginToPromptOrigin, type SteerContent, type SteerOrigin } from "../loop/steer.ts";
import type { Capability, CapabilityDiagnostic, SessionContext, SessionControls } from "../capabilities/capability.ts";
import { type SubagentRecord, type SubagentStatus } from "./subagent.ts";
import { SystemPromptContextCache, type SystemPromptContext } from "./instruction-context.ts";

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

export interface SessionConfig {
  /**
   * The machine this session operates. Pass a {@link Machine} directly, or a
   * {@link MachineFactory} when it can only be built once the session id is known.
   * Omitted → a {@link NullMachine}: a stateless session with no filesystem, where any
   * file tool that slips through fails loudly instead of touching the host disk.
   *
   * Either way the session only OPERATES the machine — disposal stays with whoever
   * created it. See {@link MachineFactory}.
   */
  readonly machine?: Machine | MachineFactory;
  readonly store?: SessionStore;
  readonly events?: EventSink;
  /** `immediate` is optimized for an in-process UI. `committed` makes one ordered stream in
   *  which record-backed events are emitted only after durable append succeeds. */
  readonly eventPublication?: EventPublicationMode;
  readonly tracing?: TracingProcessor;
  readonly responder?: Responder;
  readonly permission?: PermissionManagerOptions;
  readonly capabilities?: readonly Capability[];
  readonly steer?: SteerBus;
  readonly background?: BackgroundSpawner;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /**
   * The session's full append log, pre-read by the caller. `open` then skips its own
   * `readLog` and every open-time consumer (log-fold capabilities, context pre-build)
   * folds THESE records — sharing the read AND the `Message` object graph with whatever
   * else the caller seeded from them (e.g. a `SessionProjection`), instead of holding a
   * second parsed+blob-rehydrated copy for the session's lifetime.
   * Must be the complete log (all addresses, append order) as `readRecords()` returns it.
   */
  readonly preloadedLog?: readonly AgentRecord[];
}

/**
 * Thrown by `Session`'s capability-backed convenience methods when the capability they
 * wrap is not open on this session. Detect with `instanceof`; `capability` names the
 * missing one. The probe tier never throws — the getters (`session.cron`, `.goal`, …)
 * return `undefined` instead.
 */
export class CapabilityMissingError extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(`Session has no open "${capability}" capability.`);
    this.name = "CapabilityMissingError";
    this.capability = capability;
  }
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
  /** Compaction service view: reserved headroom plus full-compaction invalidation revision. */
  readonly compaction: { readonly reservedContextTokens: number; readonly revision: number } | undefined;
  readonly workflow: WorkflowManager | undefined;
  resolveSystemPromptContext(machine: Machine): Promise<SystemPromptContext>;
  recordContextBreakdown(breakdown: ContextBreakdown): void;
  flushEvents(): Promise<void>;
  setLiveContext(address: string, ctx: ConversationContext): void;
  setConversationHead(head: ConversationHead): void;
  /** Register a forked frame's inbox; the returned function unregisters it. */
  registerFrameBus(address: string, bus: SteerBus): () => void;
}

/**
 * Capability access on a session has two tiers, one rule each:
 *  - PROBE — the service getters (`session.cron`, `.goal`, `.plan`, `.backgroundManager`,
 *    `.mcp`, …) return `undefined` when that capability is not open. Use these to feature-test.
 *  - REQUIRE — the convenience wrappers (`createCronTask()`, `compact()`, `listSkills()`, …)
 *    assume the capability and throw {@link CapabilityMissingError} when it is missing.
 * The only exceptions are list views documented as degrading to empty when the capability
 * is off (`listWorkflows`, `listSubagents`, `listMcpServers`) — views over durable state
 * that stay meaningful on a session opened without the capability.
 */
export class Session implements SessionPort {
  readonly id: string;
  readonly machine: Machine;
  readonly store?: SessionStore;
  readonly events: EventSink;
  private readonly eventPublisher: SessionEventPublisher;
  readonly responder?: Responder;
  private readonly permissionOptions?: PermissionManagerOptions;
  /** Session-lived permission manager: one policy chain + approval memory +
   *  mode for the whole session. Constructed in `openCapabilities` (needs capability policy
   *  slots and the replayed log); runs reference it instead of building their own. */
  private _permission!: PermissionManager;
  readonly steer: SteerBus;
  readonly signal: AbortSignal;
  /** Upstream of `signal`. Fires only via `abort()`; a host signal aborts independently. */
  private readonly ownController: AbortController;
  readonly logger: Logger;
  private readonly tracing?: TracingProcessor;
  private readonly unsubscribeTracing?: () => void;

  private readonly injectedBackground?: BackgroundSpawner;
  private readonly allCapabilities: readonly Capability[];
  private readonly services = new Map<string, unknown>();
  // Runtime prompt data is live-Session state, not Agent state: machine identity + cwd isolate
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
  /** Caller-supplied one-shot log for open (see SessionConfig.preloadedLog); cleared after
   *  openCapabilities so the array itself is not pinned for the session's lifetime. */
  private preloadedLog?: readonly AgentRecord[];
  private thinkingOverride?: ThinkingLevel;
  private openedCapabilities: readonly Capability[] = [];
  private isOpen = false;
  private runChain: Promise<void> = Promise.resolve();
  private readonly pendingDiagnostics: CapabilityDiagnostic[] = [];
  // Most-recent per-turn context-window breakdown, stamped by the Runner at each turn boundary.
  // Undefined until the first turn assembles a request.
  private lastContextBreakdown?: ContextBreakdown;

  private constructor(
    cfg: SessionConfig,
    id: string,
    eventPublisher: SessionEventPublisher,
    steer: SteerBus,
    signal: AbortSignal,
    machine: Machine,
    ownController: AbortController,
  ) {
    this.id = id;
    this.machine = machine;
    this.ownController = ownController;
    this.eventPublisher = eventPublisher;
    this.store = eventPublisher.store;
    this.events = eventPublisher;
    this.tracing = cfg.tracing;
    this.unsubscribeTracing = cfg.tracing === undefined ? undefined : eventSinkTracingBridge(this.events, cfg.tracing);
    this.responder = cfg.responder;
    this.permissionOptions = cfg.permission;
    this.steer = steer;
    // Every enqueue — user steer/follow-up, cron fire, background settle — surfaces on the
    // event stream, so clients can render a pending queue and later match `origin.steerId`
    // on the consuming `message.appended` to know when the model actually saw it.
    steer.setEnqueueListener((item, channel) => {
      void this.events.emit({
        type: "steer.queued",
        steerId: item.id,
        channel,
        origin: steerOriginToPromptOrigin(item.origin, item.id),
        message: item.message,
        address: "main",
        sessionId: id,
      });
    });
    this.injectedBackground = cfg.background;
    this.signal = signal;
    // Env fallback (`AGENTS_LOG`) is resolved here so every entry point — direct `Session.open`,
    // the Runner's ephemeral session, or the harness — honors it from one place.
    this.logger = cfg.logger ?? envLogger() ?? noopLogger;
    this.allCapabilities = cfg.capabilities ?? [];
    this.preloadedLog = cfg.preloadedLog;
  }

  static async open(cfg: SessionConfig): Promise<Session> {
    const events = cfg.events ?? new ListenerSink();
    const steer = cfg.steer ?? new SteerBus();
    // The session owns a cancel handle of its own, downstream of whatever the host passed in:
    // `session.abort()` stops the session without taking the host's signal away from it, and a
    // host abort still propagates. `AbortSignal.any` owns the listener lifetime for us.
    const ownController = new AbortController();
    const signal = cfg.signal === undefined
      ? ownController.signal
      : AbortSignal.any([cfg.signal, ownController.signal]);
    const id = cfg.sessionId ?? newSessionId();
    const eventPublisher = new SessionEventPublisher(id, events, cfg.store, cfg.eventPublication ?? "immediate");
    const machine = await resolveMachine(cfg, { sessionId: id, signal });
    const session = new Session(cfg, id, eventPublisher, steer, signal, machine, ownController);
    await session.openCapabilities();
    return session;
  }

  private async openCapabilities(): Promise<void> {
    // Shared restore: read the log at most once and
    // let every log-fold capability (goal/plan/todo) reconstruct from that one read via
    // `readSessionLog(ctx)`, then reuse it to pre-build the main conversation context — instead
    // of each capability, plus the first run's `replayContext`, re-reading the log separately.
    // A caller-preloaded log (SessionConfig.preloadedLog) IS that one read, done outside.
    let log: readonly AgentRecord[] | undefined = this.preloadedLog;
    this.preloadedLog = undefined;
    const logRecords = async (): Promise<readonly AgentRecord[]> => {
      if (log === undefined) log = await readLog(this.store);
      return log;
    };
    const ctx: SessionContext = {
      sessionId: this.id,
      machine: this.machine,
      store: this.store,
      events: this.events,
      signal: this.signal,
      steer: this.steer,
      controls: this.controls(),
      logRecords,
    };
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
        if (cap.openSession) await cap.openSession(ctx);
      } catch (error) {
        // per-run assembly too, since it isn't pushed onto `opened`.
        this.pendingDiagnostics.push({
          capability: cap.name,
          phase: "start",
          level: "error",
          message: `openSession failed; capability absent for the session: ${messageOf(error)}`,
        });
        this.logger.log("error", `capability "${cap.name}" openSession failed`, { capability: cap.name, phase: "start", error: messageOf(error) });
        continue;
      }
      opened.push(cap);
      if (cap.service !== undefined) this.services.set(cap.name, cap.service);
    }
    this.openedCapabilities = opened;
    await this.buildPermissionManager(opened, logRecords);
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
   * Construct the session-lived PermissionManager: capability policy slots are collected from
   * the opened capabilities' static `policies` (session-tier fault isolation: a capability whose
   * `openSession` failed contributes nothing; a per-run `start()` failure does NOT retract its
   * policies — they are pure evaluators over session-lived state). Then runtime permission
   * state is folded back from the log — `permission.set_mode` (last wins) and approve-for-session
   * grants (`permission.record_approval` with scope "session").
   */
  private async buildPermissionManager(
    opened: readonly Capability[],
    logRecords: () => Promise<readonly AgentRecord[]>,
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

    this._permission = new PermissionManager({
      ...this.permissionOptions,
      mode: this.permissionOptions?.mode,
      // The Runner-driven path answers approvals via interrupt/resume (or the live responder
      // in onInterrupt) — never inline through the manager, so it gets no responder here.
      responder: undefined,
      cwd: this.permissionOptions?.cwd ?? safeCwd(this.machine),
      pathClass: this.permissionOptions?.pathClass ?? this.machine.pathClass(),
      machine: this.permissionOptions?.machine ?? this.machine,
      policyOverrides: overrides,
      logger: this.logger,
    });

    if (this.store === undefined) return;
    for (const record of await logRecords()) {
      if (record.type === "permission.set_mode") {
        this._permission.setMode(record.mode as PermissionMode);
      } else if (
        record.type === "permission.record_approval" &&
        record.decision === "approved" &&
        record.scope === "session" &&
        record.approvalRule !== undefined
      ) {
        this._permission.applyApproval(record.approvalRule, { decision: "approved", scope: "session" });
      }
    }
  }

  /** The session-lived permission manager (policy chain + mode + approval memory). */
  get permission(): PermissionManager {
    return this._permission;
  }

  get capabilities(): readonly Capability[] {
    return this.openedCapabilities;
  }

  service<T = unknown>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }
  /** The REQUIRE tier (see the class doc): unwrap a probed service or throw the typed error. */
  private requireCapability<T>(service: T | undefined, name: string): T {
    if (service === undefined) throw new CapabilityMissingError(name);
    return service;
  }
  get goal(): GoalStore | undefined {
    return this.services.get("goal") as GoalStore | undefined;
  }
  get workflow(): WorkflowManager | undefined {
    return this.services.get("workflow") as WorkflowManager | undefined;
  }
  get skills(): SkillsService | undefined {
    return this.services.get("skills") as SkillsService | undefined;
  }
  get plugins(): PluginManager | undefined {
    return this.services.get("plugins") as PluginManager | undefined;
  }
  get backgroundManager(): BackgroundManager | undefined {
    return this.services.get("background") as BackgroundManager | undefined;
  }
  get plan(): PlanMode | undefined {
    return this.services.get("plan") as PlanMode | undefined;
  }
  get compaction(): CompactionService | undefined {
    return this.services.get("compaction") as CompactionService | undefined;
  }
  get mcp(): McpServersHandle | undefined {
    return this.services.get("mcp") as McpServersHandle | undefined;
  }
  get background(): BackgroundSpawner | undefined {
    return (this.services.get("background") as BackgroundSpawner | undefined) ?? this.injectedBackground;
  }

  async listBackgroundTasks(options: BackgroundTaskListOptions = {}): Promise<readonly BackgroundTaskInfo[]> {
    const background = this.requireCapability(this.backgroundManager, "background");
    return background.list(options.activeOnly ?? false, options.limit);
  }

  /** Past BACKGROUND workflow runs (newest first), from the durable task store. A foreground
   *  workflow is a plain `Workflow` tool call — its record is the conversation plus its journal
   *  shard — so it is not listed here (its shard stays resumable by runId). */
  async listWorkflows(): Promise<readonly WorkflowSnapshot[]> {
    const manager = this.backgroundManager;
    if (manager === undefined) return [];
    const runs: WorkflowSnapshot[] = [];
    for (const info of manager.list(false)) {
      const snap = taskToWorkflowSnapshot(info);
      if (snap !== undefined) runs.push(snap);
    }
    runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return runs;
  }

  /** One background workflow run's snapshot by runId, or undefined if unknown. */
  async getWorkflow(runId: string): Promise<WorkflowSnapshot | undefined> {
    return (await this.listWorkflows()).find((run) => run.runId === runId);
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

  /** The background subagents of this session, from the durable task store (live + reconciled
   *  ghosts). Foreground subagents are plain `Agent` tool calls — their record is the conversation
   *  plus their own shard — so they are not listed here (their shard stays resumable by id). */
  async listSubagents(): Promise<readonly SubagentRecord[]> {
    const manager = this.backgroundManager;
    if (manager === undefined) return [];
    const records: SubagentRecord[] = [];
    for (const info of manager.list(false)) {
      const record = taskToSubagentRecord(info);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  /**
   * Reclassify orphaned background work (spawned by a dead process, never settled) as `lost`
   * through the task store: the manager writes the terminal status back and steers the lost
   * notification (the durable settle record), so later opens won't re-report. Also emits a warning
   * per reclassified subagent. Call when reopening an existing session. Returns the lost subagents
   * (resume any with `Agent(resume="<id>", ...)`).
   */
  async reconcileSubagents(): Promise<readonly SubagentRecord[]> {
    const manager = this.backgroundManager;
    if (manager === undefined || this.store === undefined) return [];
    const lost: SubagentRecord[] = [];
    for (const info of await manager.reconcile()) {
      const record = taskToSubagentRecord(info);
      if (record === undefined) continue;
      lost.push(record);
      await this.emitControlEvent({
        type: "warning",
        message: `Background subagent "${record.agentId}" (${record.type}) was running when the previous process exited; marked lost. Resume with Agent(resume="${record.agentId}", ...).`,
      });
    }
    return lost;
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
   * Hand a message to the frame running at `address`; `false` when nobody is there.
   *
   * This is the whole seam an external coordinator needs in order to address a subagent: it can
   * already learn who exists from `agent.started` / `agent.ended` (both carry `address`), but it
   * has no way to reach a child's inbox — every frame owns a private `SteerBus`. Deliberately
   * knows nothing about peers, rosters or visibility: those are policy, and policy belongs to
   * whoever is coordinating, not to the engine.
   */
  steerTo(address: string, content: SteerContent, origin: SteerOrigin): boolean {
    const bus = address === DEFAULT_ADDRESS ? this.steer : this.frameBuses.get(address);
    if (bus === undefined) return false;
    bus.steer(content, origin);
    return true;
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
  resolveSystemPromptContext(machine: Machine): Promise<SystemPromptContext> {
    return this.systemPromptContexts.resolve(machine, this.compaction?.revision ?? 0);
  }

  /** A bounded view of the task's authoritative output, with explicit size/truncation metadata. */
  async readBackgroundTaskOutput(
    taskId: string,
    options: ReadBackgroundTaskOutputOptions = {},
  ): Promise<BackgroundTaskOutputSnapshot> {
    const background = this.requireCapability(this.backgroundManager, "background");
    return background.readOutput(taskId, options.maxBytes ?? 16 * 1024);
  }

  /**
   * Everything a task appended since `cursor` — what a live panel polls so each tick
   * carries only what is new, instead of re-fetching the same window. `followable: false`
   * means this task keeps no byte-addressable output; use `readBackgroundTaskOutput` instead.
   */
  async readBackgroundTaskOutputDelta(
    taskId: string,
    options: ReadBackgroundTaskOutputDeltaOptions,
  ): Promise<BackgroundTaskOutputDelta> {
    const background = this.requireCapability(this.backgroundManager, "background");
    return background.readOutputDelta(taskId, options.cursor, options.maxBytes);
  }

  async stopBackgroundTask(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined> {
    const background = this.requireCapability(this.backgroundManager, "background");
    return background.stop(taskId, reason);
  }

  /**
   * Move a running, detachable tool call (bash / subagent / workflow) from the foreground into
   * a background task — the "move to background" action. Returns false if no such call is
   * currently in its detachable window (already finished, or not a detachable tool).
   */
  detachTool(toolCallId: string): boolean {
    const background = this.requireCapability(this.backgroundManager, "background");
    return background.detach(toolCallId);
  }

  /** Connected MCP servers and their status. Empty when no MCP capability is open. */
  listMcpServers(): readonly McpServerView[] {
    return this.mcp?.list() ?? [];
  }

  /**
   * Tools one MCP server exposes — for showing a host's user what a server can do.
   * Empty when the capability is off, the server is unknown, or it is not connected,
   * for the same reason `listMcpServers` degrades to empty rather than throwing.
   */
  async listMcpTools(name: string): Promise<readonly MCPTool[]> {
    return (await this.mcp?.listTools(name)) ?? [];
  }

  /** Force-reconnect one MCP server by name. Throws if no MCP capability is open. */
  async reconnectMcpServer(name: string): Promise<void> {
    const mcp = this.requireCapability(this.mcp, "mcp");
    await mcp.reconnect(name);
  }

  async createGoal(input: CreateGoalInput): Promise<GoalSnapshot> {
    const goal = this.requireCapability(this.goal, "goal");
    if (input.objective.trim().length === 0) throw new Error("Goal objective cannot be empty.");
    if (goal.has()) goal.update({ status: "complete" });
    let snapshot = goal.update({
      objective: input.objective.trim(),
      completionCriterion: input.completionCriterion?.trim(),
      status: "active",
    });
    if (input.budget !== undefined) snapshot = goal.setBudget(normalizeGoalBudget(input.budget));
    if (snapshot === null) throw new Error("Goal was not created.");
    await this.emitControlEvent({ type: "goal.updated", snapshot });
    return snapshot;
  }

  async getGoal(): Promise<GoalSnapshot | null> {
    const goal = this.requireCapability(this.goal, "goal");
    return goal.snapshot();
  }

  async pauseGoal(options: GoalStatusInput = {}): Promise<GoalSnapshot | null> {
    return this.updateExistingGoal("paused", options.reason);
  }

  async resumeGoal(options: GoalStatusInput = {}): Promise<GoalSnapshot | null> {
    return this.updateExistingGoal("active", options.reason);
  }

  async cancelGoal(options: GoalStatusInput = {}): Promise<GoalSnapshot | null> {
    const goal = this.requireCapability(this.goal, "goal");
    const previous = goal.snapshot();
    if (previous === null) return null;
    goal.update({ status: "complete", reason: options.reason });
    await this.emitControlEvent({ type: "goal.updated", snapshot: null });
    return previous;
  }

  async setGoalBudget(budget: GoalBudgetInput): Promise<GoalSnapshot | null> {
    const goal = this.requireCapability(this.goal, "goal");
    const snapshot = goal.setBudget(normalizeGoalBudget(budget));
    await this.emitControlEvent({ type: "goal.updated", snapshot });
    return snapshot;
  }

  async setPlanMode(enabled: boolean, options: PlanModeOptions = {}): Promise<PlanData> {
    const plan = this.requireCapability(this.plan, "plan");
    if (enabled && !plan.isActive) {
      await plan.enter(options.createFile ?? true);
    } else if (!enabled && plan.isActive) {
      plan.exit();
    }
    const snapshot = await plan.data();
    await this.emitControlEvent({ type: "plan.updated", snapshot });
    return snapshot;
  }

  async getPlan(): Promise<PlanData> {
    const plan = this.requireCapability(this.plan, "plan");
    return plan.data();
  }

  async clearPlan(): Promise<PlanData> {
    return this.setPlanMode(false);
  }

  /**
   * The `SessionControls` view handed to capabilities that act on the session (the extension
   * runtime's `ctx.actions`). Bound methods over the same public operations a host would call —
   * no new reach, just a typed handle that does not leak the whole Session.
   */
  controls(): SessionControls {
    return {
      abort: (reason) => this.abort(reason),
      compact: (options) => this.compact(options),
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

  async compact(options: CompactRequestOptions = {}): Promise<PendingCompaction> {
    const compaction = this.requireCapability(this.compaction, "compaction");
    return compaction.request(options);
  }

  async pendingCompaction(): Promise<PendingCompaction | null> {
    const compaction = this.requireCapability(this.compaction, "compaction");
    return compaction.pending();
  }

  async cancelCompaction(): Promise<PendingCompaction | null> {
    const compaction = this.requireCapability(this.compaction, "compaction");
    return compaction.cancel();
  }

  private async updateExistingGoal(status: "active" | "blocked" | "paused", reason?: string): Promise<GoalSnapshot | null> {
    const goal = this.requireCapability(this.goal, "goal");
    if (goal.snapshot() === null) return null;
    const snapshot = goal.update({ status, reason });
    await this.emitControlEvent({ type: "goal.updated", snapshot });
    return snapshot;
  }

  private async emitControlEvent(body: import("../events/index.ts").AgentEventBody): Promise<void> {
    await this.events.emit({ ...body, address: "main", sessionId: this.id });
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    const skills = this.requireCapability(this.skills, "skills");
    return skills.listSkills();
  }

  async activateSkill(name: string, args?: string): Promise<SkillActivationResult>;
  async activateSkill(request: ActivateSkillRequest): Promise<SkillActivationResult>;
  async activateSkill(nameOrRequest: string | ActivateSkillRequest, args?: string): Promise<SkillActivationResult> {
    const skills = this.requireCapability(this.skills, "skills");
    const request = typeof nameOrRequest === "string" ? { name: nameOrRequest, ...(args !== undefined ? { args } : {}) } : nameOrRequest;
    return skills.activateSkill(request);
  }

  async listPlugins(): Promise<readonly PluginSummary[]> {
    const plugins = this.requireCapability(this.plugins, "plugins");
    return plugins.summaries();
  }

  async getPluginInfo(id: string): Promise<PluginInfo | undefined> {
    const plugins = this.requireCapability(this.plugins, "plugins");
    return plugins.info(id);
  }

  async installPlugin(source: string): Promise<PluginSummary> {
    const plugins = this.requireCapability(this.plugins, "plugins");
    const record = await plugins.install(source);
    const summary = plugins.summaries().find((plugin) => plugin.id === record.id);
    if (summary === undefined) throw new Error(`Plugin "${record.id}" was installed but no summary was produced.`);
    return summary;
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const plugins = this.requireCapability(this.plugins, "plugins");
    await plugins.setEnabled(id, enabled);
  }

  async setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const plugins = this.requireCapability(this.plugins, "plugins");
    await plugins.setMcpServerEnabled(id, server, enabled);
  }

  async removePlugin(id: string): Promise<void> {
    const plugins = this.requireCapability(this.plugins, "plugins");
    await plugins.remove(id);
  }

  async reloadPlugins(): Promise<ReloadSummary> {
    const plugins = this.requireCapability(this.plugins, "plugins");
    return plugins.reload();
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
    this._permission.setMode(mode);
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
    return this._permission.mode;
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

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.systemPromptContexts.clear();
    this.unsubscribeTracing?.();
    for (const cap of [...this.openedCapabilities].reverse()) {
      if (!cap.closeSession) continue;
      try {
        await withTimeout(Promise.resolve(cap.closeSession()), CLOSE_TIMEOUT_MS);
      } catch (error) {
        this.pendingDiagnostics.push({
          capability: cap.name,
          phase: "stop",
          level: "warn",
          message: `closeSession failed/timed out: ${messageOf(error)}`,
        });
        this.logger.log("warn", `capability "${cap.name}" closeSession failed/timed out`, { capability: cap.name, phase: "stop", error: messageOf(error) });
      }
    }
    this.openedCapabilities = [];
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
    // The machine is deliberately NOT closed here: its lifetime belongs to whoever created
    // it (see `MachineFactory`). A sandbox usually outlives any one session, so closing it
    // on session.close would pull the workspace out from under the user's other sessions.
  }

  /** Public URL for a port inside the machine, or undefined when the backend can't expose one. */
  async resolveExposedPort(port: number): Promise<string | undefined> {
    return await this.machine.exposedPortUrl?.(port);
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

async function resolveMachine(cfg: SessionConfig, ctx: MachineOpenContext): Promise<Machine> {
  // No machine configured → stateless session with no filesystem. A NullMachine
  // answers metadata but refuses all I/O, so a stray file tool fails loudly
  // rather than silently touching the host disk.
  if (!cfg.machine) return new NullMachine();
  return typeof cfg.machine === "function" ? await cfg.machine(ctx) : cfg.machine;
}

function safeCwd(machine: Machine): string {
  try {
    return machine.getcwd();
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
