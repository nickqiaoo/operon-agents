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
import { type AgentRecord, DEFAULT_ADDRESS, type SessionStore } from "../store/index.ts";
import { eventSinkTracingBridge, type TracingProcessor } from "../tracing/index.ts";
import { subscribeTelemetryProjection } from "../telemetry/projection.ts";
import { ConversationContext } from "../loop/context.ts";
import { readLog } from "../capabilities/capability-state.ts";
import type { McpServerView, MCPTool } from "../mcp/index.ts";
import { SteerBus, type SteerContent, type SteerOptions, type SteerOrigin, type SteerReceipt } from "../loop/steer.ts";
import type { Capability, CapabilityDiagnostic, ProvisionContext, SessionControls } from "../capabilities/capability.ts";
import { assertDependencyTiers, resolveNeeds } from "../capabilities/needs.ts";
import { type SubagentRecord, type SubagentStatus } from "./subagent.ts";
import { SystemPromptContextCache, type SystemPromptContext } from "./instruction-context.ts";
import { Scope } from "../scope/scope.ts";
import type { Token } from "../scope/token.ts";
import type { GoalStore } from "../capabilities/goal/goal-store.ts";
import type { PlanMode } from "../capabilities/plan/plan-mode.ts";
import type { TodoStore } from "../capabilities/todo/todo-store.ts";
import type { TaskStore } from "../capabilities/task/task-store.ts";
import type { SkillsService } from "../capabilities/skills/service.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { McpServersHandle } from "../mcp/manager.ts";
import type { BackgroundManager } from "../capabilities/background/manager.ts";
import type { CompactionService } from "../capabilities/compaction/service.ts";
import { Tokens, type SessionLogReader } from "../scope/tokens.ts";

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
   * in-memory session. `open` wraps it so record-backed events publish on commit and registers
   * THAT wrapper as `Tokens.Store` — which is what capabilities and the loop write through.
   *
   * Falls back to `Tokens.StoreBackend`, which is how a `Runner`'s `session` hook supplies one:
   * the hook can only write to the scope, and the Runner that calls `open` never sees the store.
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

/**
 * Service access on a session has two tiers, one rule each:
 *  - PROBE — `session.get(Tokens.X)` returns `undefined` when that service is not registered
 *    (the capability is not open). Use it to feature-test.
 *  - REQUIRE — `session.require(Tokens.X)` and the convenience wrappers (`createCronTask()`,
 *    `compact()`, `listSkills()`, …) assume the service and throw `ServiceUnavailableError`
 *    when it is missing.
 * The only exceptions are list views documented as degrading to empty when the capability
 * is off (`listWorkflows`, `listSubagents`, `listMcpServers`) — views over durable state
 * that stay meaningful on a session opened without the capability.
 *
 * The session OWNS its scope: `close()` closes it, disposing every service registered there
 * (capability provisions first, in reverse order, then the infrastructure).
 */
export class Session implements SessionPort {
  readonly id: string;
  /** The session-tier scope: every session-lived object, registered by the opener or by `open`. */
  readonly scope: Scope<"session">;
  readonly environment: Environment;
  readonly store?: SessionStore;
  readonly events: EventSink;
  private readonly eventPublisher: SessionEventPublisher;
  readonly responder?: Responder;
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
  /** The one close in flight (or finished): every `close()` call returns THIS promise. */
  private closing: Promise<void> | undefined;
  private runChain: Promise<void> = Promise.resolve();
  private readonly pendingDiagnostics: CapabilityDiagnostic[] = [];
  // Most-recent per-turn context-window breakdown, stamped by the Runner at each turn boundary.
  // Undefined until the first turn assembles a request.
  private lastContextBreakdown?: ContextBreakdown;
  /** Built at the end of `open`, once every capability's policies are in. */
  private permissionManager?: PermissionManager;

  private constructor(
    scope: Scope<"session">,
    id: string,
    signal: AbortSignal,
    ownController: AbortController,
    publisher: SessionEventPublisher,
    opts: SessionOpenOptions,
  ) {
    this.scope = scope;
    this.id = id;
    this.signal = signal;
    this.ownController = ownController;
    this.environment = scope.require(Tokens.Environment);
    this.eventPublisher = publisher;
    // The publishing wrapper around `Tokens.Store`: record-backed events surface on `events` when
    // the append commits, so everything in the session writes through THIS store.
    this.store = this.eventPublisher.store;
    this.events = this.eventPublisher;
    this.tracing = scope.get(Tokens.Tracing);
    this.unsubscribeTracing = this.tracing === undefined ? undefined : eventSinkTracingBridge(this.events, this.tracing);
    // Product telemetry rides the same stream. One subscription per session; the projection
    // tells sub-agents apart by address. `resumed` is the one fact the stream cannot tell.
    const telemetry = scope.get(Tokens.Telemetry);
    this.unsubscribeTelemetry =
      telemetry === undefined
        ? undefined
        : subscribeTelemetryProjection(this.events, telemetry.withContext({ session_id: id }), { resumed: opts.resumed === true });
    this.responder = scope.get(Tokens.Responder);
    this.steer = scope.require(Tokens.Steer);
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
    // tier normally provides `Tokens.Logger`; a parentless session scope has nothing above it.
    this.logger = scope.get(Tokens.Logger) ?? envLogger() ?? noopLogger;
    this.allCapabilities = opts.capabilities ?? [];
    this.preloadedLog = opts.preloadedLog;
  }

  /**
   * Open a session on a session-tier scope. The opener registers what it decides (`Tokens.Environment`,
   * `Tokens.Store`, `Tokens.Events`, `Tokens.Responder`, `Tokens.PermissionOptions`, `Tokens.HostSignal`, `Tokens.SessionId`, …);
   * `open` provides the defaults for whatever is missing, builds the session's own objects
   * (signal, event publisher, log reader, controls), runs every capability's provisions in
   * order, then builds the permission manager. From here on the session owns the scope.
   */
  static async open(scope: Scope<"session">, opts: SessionOpenOptions = {}): Promise<Session> {
    if (scope.kind !== "session") throw new Error(`Session.open needs a session scope, got a ${scope.kind} scope`);
    const id = opts.sessionId ?? newSessionId();
    // The session owns a cancel handle of its own, downstream of whatever the host passed in:
    // `session.abort()` stops the session without taking the host's signal away from it, and a
    // host abort still propagates. `AbortSignal.any` owns the listener lifetime for us.
    const ownController = new AbortController();
    const signal = opts.signal === undefined ? ownController.signal : AbortSignal.any([opts.signal, ownController.signal]);
    scope.register(Tokens.SessionSignal, signal);
    scope.provide(Tokens.Events, () => new ListenerSink());
    scope.provide(Tokens.Steer, () => new SteerBus());
    // Environment: the opener's registration wins; else a workspace- or harness-level factory
    // (resolved here because it needs the session id + signal, and `provide` is sync); else a
    // NullEnvironment — a stateless session with no filesystem, where any file tool that slips
    // through fails loudly instead of touching the host disk. The session only OPERATES the
    // environment — disposal stays with whoever created it (`owned: false`).
    if (!scope.hasLocal(Tokens.Environment)) {
      const factory = scope.get(Tokens.SessionEnvironmentFactory) ?? scope.get(Tokens.WorkspaceEnvironmentFactory) ?? scope.get(Tokens.EnvironmentFactory);
      if (factory !== undefined) {
        const environment = typeof factory === "function" ? await factory({ sessionId: id, signal }) : factory;
        scope.register(Tokens.Environment, environment, { owned: false });
      }
    }
    scope.provide(Tokens.Environment, () => new NullEnvironment());
    // The publisher is the session's OWN object — one producer, one consumer, both inside this
    // class — so it is built here and held as a field rather than round-tripped through the
    // registry. Nothing outside a session can meaningfully hold another session's publisher.
    const publisher = new SessionEventPublisher(
      id,
      scope.require(Tokens.Events),
      opts.store ?? scope.get(Tokens.StoreBackend),
      scope.get(Tokens.SessionEventPublication) ?? scope.get(Tokens.EventPublication) ?? "immediate",
    );
    const session = new Session(scope, id, signal, ownController, publisher, opts);
    // `Tokens.Store` is the publishing wrapper — what capabilities, the loop and the host write through.
    if (session.store !== undefined) scope.register(Tokens.Store, session.store, { owned: false });
    scope.register(Tokens.SessionControls, session.controls());
    await session.provisionCapabilities();
    return session;
  }

  /**
   * Build every capability's declared services and register them.
   *
   * Not "open": a capability has no open/close pair — its services are torn down by
   * `scope.close()`, not by a matching call here. What it has is `provides`, so this is the verb
   * for it. The per-RUN pair is `start`/`stop`, which the assembler drives.
   */
  /**
   * Undo one capability's session registrations, newest first, after its assembly failed.
   *
   * Only what THIS capability registered on THIS pass, by token, so a host's own service or a
   * concurrent replacement is never collateral. `unregister` drains and disposes, so an object
   * that was half-wired still gets its `close()`; a disposer that throws is logged and the rest
   * of the withdrawal continues, because the error that matters is the original one.
   */
  private async withdraw(tokens: readonly Token<unknown, "session">[], capability: string): Promise<void> {
    for (const tok of [...tokens].reverse()) {
      try {
        await this.scope.unregister(tok, {
          disposeTimeoutMs: 5_000,
          onDisposeError: (name, error) => {
            this.pendingDiagnostics.push({
              capability,
              phase: "register",
              level: "warn",
              message: `rolling back after a failed provision: disposing "${name}" failed: ${messageOf(error)}`,
            });
          },
        });
      } catch (error) {
        this.pendingDiagnostics.push({
          capability,
          phase: "register",
          level: "warn",
          message: `rolling back after a failed provision: withdrawing "${tok.name}" failed: ${messageOf(error)}`,
        });
      }
    }
  }

  private async provisionCapabilities(): Promise<void> {
    // Shared restore: read the log at most once and let every log-fold capability
    // (goal/plan/todo) reconstruct from that one read via `Tokens.SessionLog`, then reuse it to
    // pre-build the main conversation context — instead of each capability, plus the first
    // run's `replayContext`, re-reading the log separately. A caller-preloaded log IS that
    // one read, done outside.
    let log: readonly AgentRecord[] | undefined = this.preloadedLog;
    this.preloadedLog = undefined;
    const logRecords: SessionLogReader = async () => {
      if (log === undefined) log = await readLog(this.store);
      return log;
    };
    this.scope.register(Tokens.SessionLog, logRecords);
    const ctx: ProvisionContext = { sessionId: this.id, signal: this.signal };
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
      // What THIS capability registered in the session scope, in order. A capability is all or
      // nothing: if a later provision fails, these come back out before the next capability is
      // assembled, so nothing can build on the remains of something that is not open.
      const registered: Token<unknown, "session">[] = [];
      try {
        for (const provision of cap.provides ?? []) {
          // Declarations are checked before anything is built or looked up — including when the
          // shared service already exists and the factory will be skipped. A workspace service
          // that names a session one is wrong even on the run where it does not get built.
          assertDependencyTiers(cap.name, provision.token, provision.needs);
          const options = provision.dispose !== undefined ? { dispose: provision.dispose as (instance: unknown) => void | Promise<void> } : {};
          // The token's tier picks the scope, which is how a capability owns both halves of
          // itself: the shared one, built once per workspace by whichever session declares it
          // first, and the per-session one.
          if (provision.token.scope === "session") {
            const tok = provision.token as Token<unknown, "session">;
            // `create`, not `await create(); register()`: between those two the object belongs
            // to nobody, and a session closing mid-open would drop it on the floor.
            await this.scope.create(tok, () => provision.create(resolveNeeds(this.scope, provision.needs, cap.name), ctx), options);
            registered.push(tok);
            continue;
          }
          const host = this.scope.scopeOf(provision.token.scope);
          if (host === undefined) {
            throw new Error(
              `provision for "${provision.token.name}" is ${provision.token.scope}-scoped, but this session has no ${provision.token.scope} scope above it`,
            );
          }
          // Dependencies resolve from the scope that OWNS the service, and are resolved inside
          // the factory — so an existing shared service is reused without this session's
          // dependencies being consulted at all, and a new one can never capture them.
          await host.ensure(
            provision.token as Token<unknown, never>,
            (build) => provision.create(resolveNeeds(host, provision.needs, cap.name), { signal: build.signal }),
            options,
          );
        }
      } catch (error) {
        // Fault isolation: the capability is absent for the session (its per-run assembly too,
        // since it isn't pushed onto `opened`). Its session services are withdrawn here; a
        // workspace service it had already published stays — other sessions may hold it.
        await this.withdraw(registered, cap.name);
        this.pendingDiagnostics.push({
          capability: cap.name,
          phase: "start",
          level: "error",
          message: `provision failed; capability absent for the session: ${messageOf(error)}`,
        });
        this.logger.log("error", `capability "${cap.name}" provision failed`, { capability: cap.name, phase: "start", error: messageOf(error) });
        continue;
      }
      opened.push(cap);
    }
    this.provisionedCapabilities = opened;
    await this.buildPermissionManager(opened, logRecords);
    // A session opened without the workflow capability still needs ONE manager per session (the
    // resume journals of every workflow run in the session must land in the same store).
    this.scope.provide(Tokens.Workflow, () => new WorkflowManager(this.store));
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

    const options = this.scope.get(Tokens.PermissionOptions);
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

  /** PROBE tier: the service, or undefined when nothing registered it (see the class doc). */
  get<S>(tok: Token<S>): S | undefined {
    return this.scope.get(tok);
  }
  /** REQUIRE tier: the service, or a `ServiceUnavailableError` naming what is missing. */
  require<S>(tok: Token<S>): S {
    return this.scope.require(tok);
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
  // To FEATURE-TEST a REQUIRE accessor, use `session.get(Tokens.X)`. Not `session.goal?.…`:
  // optional chaining guards a null result, not a throwing getter, so it reads as safe and is
  // not.
  //
  // These accessors are the one place core names capabilities (§3.4 holds for their BEHAVIOUR:
  // the kernel and the assembler know only interfaces). It is a deliberate trade: `session.goal`
  // over `session.require(Tokens.Goal)` at 58 call sites, paid for by this class listing eleven
  // capability names. A host's own capability is reached through `session.require(tok)` and
  // needs nothing here.
  //
  // The operations themselves live on the services, where the state they change lives: a goal
  // transition announces itself because `GoalStore` announces it, not because a facade method
  // remembered to.

  /** The workflow manager: the capability's, or the in-memory fallback `open` provides. */
  get workflow(): WorkflowManager {
    return this.scope.require(Tokens.Workflow);
  }
  get goal(): GoalStore {
    return this.scope.require(Tokens.Goal);
  }
  get plan(): PlanMode {
    return this.scope.require(Tokens.Plan);
  }
  get todo(): TodoStore {
    return this.scope.require(Tokens.Todo);
  }
  get task(): TaskStore {
    return this.scope.require(Tokens.Task);
  }
  get skills(): SkillsService {
    return this.scope.require(Tokens.Skills);
  }
  get plugins(): PluginManager {
    return this.scope.require(Tokens.Plugins);
  }
  /** The MCP control plane. Absent when no MCP capability is open — hence `get`, not `require`:
   *  a session without MCP has no servers to report, and that is an answer, not a failure. */
  get mcp(): McpServersHandle | undefined {
    return this.scope.get(Tokens.Mcp);
  }
  newWorkflowJournal(runId: string, parentToolCallId?: string): WorkflowJournal {
    return this.workflow.newJournal(runId, parentToolCallId);
  }
  get compaction(): CompactionService {
    return this.scope.require(Tokens.Compaction);
  }
  /** The PROBE view of the same service, for the loop: absent when compaction is not open. */
  get compactionView(): CompactionService | undefined {
    return this.scope.get(Tokens.Compaction);
  }
  /** The spawner the Agent/Workflow tools use: the background capability's manager, else the
   *  host-injected `Tokens.BackgroundSpawner`. */
  get spawner(): BackgroundSpawner | undefined {
    return this.scope.get(Tokens.Background) ?? this.scope.get(Tokens.BackgroundSpawner);
  }

  /**
   * The durable task ledger — background tasks, subagents and workflow runs.
   *
   * PROBE tier (`| undefined`), unlike the accessors above, and deliberately: a session opened
   * without the background capability has no past runs, which is an ANSWER — so a caller writes
   * `session.background?.listSubagents() ?? []` and the emptiness is visible at the call site
   * instead of hidden inside a facade method. Callers that genuinely require it (stopping a
   * task, detaching a tool call) should say so with `session.require(Tokens.Background)`.
   */
  get background(): BackgroundManager | undefined {
    return this.scope.get(Tokens.Background);
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
    return this.systemPromptContexts.resolve(environment, this.get(Tokens.Compaction)?.revision ?? 0);
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
    // Provisions (MCP connections, the background manager's subscription, …) go down in
    // reverse registration order, each dispose under CLOSE_TIMEOUT_MS. The environment is NOT
    // closed here unless this session registered it as owned: its lifetime belongs to whoever
    // created it (see `EnvironmentFactory`) — a sandbox usually outlives any one session, so
    // closing it on session.close would pull the workspace out from under other sessions.
    await this.scope.close({ disposeTimeoutMs: CLOSE_TIMEOUT_MS, onDisposeError: (name, error) => {
      this.pendingDiagnostics.push({ capability: name, phase: "stop", level: "warn", message: `dispose failed/timed out: ${messageOf(error)}` });
      this.logger.log("warn", `service "${name}" dispose failed/timed out`, { capability: name, phase: "stop", error: messageOf(error) });
    } });
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
