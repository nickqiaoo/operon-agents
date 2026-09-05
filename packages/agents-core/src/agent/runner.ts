import type { ChatModel } from "../llm/define-model.ts";
import type { AssistantMessage, Message, Usage } from "../protocol/index.ts";
import { addUsage, emptyUsage } from "../loop/usage.ts";
import { runTurn } from "../loop/run-turn.ts";
import { isAbortError } from "../loop/errors.ts";
import { ConversationContext, replayContext } from "../loop/context.ts";
import type { BatchResume, PendingApprovalInterrupt } from "../loop/types.ts";
import type { Machine } from "../tool/machine.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import { PermissionManager } from "../permission/manager.ts";
import type { ApprovalResponse, Responder } from "../permission/types.ts";
import type { Capability, RunContext } from "../capabilities/capability.ts";
import { Scope } from "../scope/scope.ts";
import { T } from "../scope/tokens.ts";
import { assembleCapabilities, type AssembledCapabilities } from "../capabilities/assembler.ts";
import { computeContextBreakdown } from "./context-report.ts";
import {
  type EventSink,
  IterableSink,
  type RunHandle,
} from "../events/index.ts";
import { DEFAULT_ADDRESS, SessionBusyError, type AgentRecord, type SessionStore } from "../store/index.ts";
import type { PromptOrigin, SessionLease, SessionLock } from "../store/index.ts";
import { SteerBus, steerOriginToPromptOrigin } from "../loop/steer.ts";
import {
  INTERRUPTION_STATE_KEY,
  applyInterruptionAnswers,
  findAnchoredAssistant,
  newInterruptionId,
  parseInterruptionState,
  type InterruptAnswer,
  type InterruptionFrame,
  type InterruptionState,
  type PendingRunInterrupt,
} from "../loop/interruption.ts";
import { abortReason, Session, type ConversationHead, type SessionPort } from "./session.ts";
import { Agent, type AgentRunContext } from "./agent.ts";
import type { SubagentInfo, SubagentProvider } from "./profiles.ts";
import {
  createOutputGuardrailMonitor,
  runInputGuardrails,
  isGuardrailTripwireError,
  type GuardrailStage,
} from "./guardrail.ts";
import { buildRunHooks } from "./compose-hooks.ts";
import { assertGraphUnambiguous, duplicateAgentNames, findAgentByName, findAgentsByName } from "./graph.ts";
import { performHandoff } from "./handoff-executor.ts";
import { pauseRun } from "./pause.ts";
import { buildRunTools } from "./toolset.ts";
import { activeDeferredTools } from "../tool/search/activation.ts";
import {
  emitRunEvent,
  finalText,
  historyChangeEmitter,
  injectAtTurnBoundary,
  lastAssistant,
  mapTerminalStatus,
  resolveModelParams,
  runCtxFor,
  tryParseOutput,
} from "./run-support.ts";

/**
 * Engine configuration — VALUES, not lifetimes. Everything with a lifetime (machine, store,
 * events, responder, permission options, capabilities' services) lives in a `Scope`: the
 * harness-tier scope the Runner is constructed on, and the session-tier scope the `session`
 * hook fills for each session the Runner opens itself.
 */
export interface RunnerConfig<TContext = unknown> {
  readonly resolveModel?: (modelId: string) => ChatModel | Promise<ChatModel>;
  /**
   * Called once per session the Runner opens on its own (no `RunOptions.session`): register
   * this session's objects (`T.Store`, `T.Machine`, `T.PermissionOptions`, …) on `scope` and
   * return its capabilities. A caller-supplied session is never passed through here.
   */
  readonly session?: (scope: Scope<"session">, ctx: { readonly sessionId: string | undefined }) => readonly Capability[] | Promise<readonly Capability[]>;
  readonly maxTurns?: number;
  readonly maxStepsPerTurn?: number;
  readonly maxRetriesPerStep?: number;
  /**
   * Exclusive right to run a session, keyed by session id.
   *
   * `Session.withRunLock` only serializes runs that share one Session OBJECT, so a host that
   * opens a session per request (an HTTP backend, a worker pool) gets no mutual exclusion at
   * all: both runs proceed and each replays history from before the other's writes. Supply a
   * lock and a run that cannot take the lease fails with `SessionBusyError` instead of forking
   * the conversation. Omit it and behavior is unchanged.
   */
  readonly lock?: SessionLock;
  /** Runtime source of subagents the `Agent` tool can spawn/resume beyond static `subagents`. */
  readonly subagentProvider?: SubagentProvider<TContext>;
  /**
   * Cap on concurrent subagents spawned from the ROOT frame of one session (nested spawns are
   * deliberately exempt — see `spawnLimiterFor`). Defaults to the same shape the Workflow tool
   * uses; `0` or less disables queuing.
   */
  readonly maxConcurrentSubagents?: number;
  /**
   * Expose the builtin `Workflow` tool (default true).
   *
   * Set false when the host supplies its own workflow orchestration and two
   * overlapping tools would leave the model guessing which to call. This is
   * narrower than dropping `subagentProvider`: subagents stay available and the
   * `Agent` tool is untouched — only `Workflow` is withheld.
   */
  readonly workflowTool?: boolean;
}

export type AgentInput = string | Message[];

/**
 * `skipped` — a capability answered the prompt itself (`beforeRun` returned `handled`), so no
 * turn ran and no model was called. It is a SUCCESS state: the caller gets an `output`, just
 * not one the model produced.
 */
export type RunStatus = "completed" | "interrupted" | "max_turns" | "aborted" | "error" | "guardrail_blocked" | "skipped";

export interface RunInterruption {
  readonly id: string;
  readonly revision: number;
  readonly pending: readonly PendingRunInterrupt[];
}

/** Which guardrail aborted a `guardrail_blocked` run — the batteries-included facade (Harness)
 *  synthesizes this instead of throwing; the low-level `Runner.run` still throws (OpenAI parity). */
export interface RunGuardrailBlock {
  readonly stage: GuardrailStage;
  readonly guardrail: string;
  readonly agent?: string;
}

export interface RunResult {
  readonly status: RunStatus;
  /** Agent that owns the conversation after this run and should receive the next prompt. */
  readonly finalAgent: string;
  /** Root conversation shard owned by `finalAgent`. */
  readonly activeAddress: string;
  readonly output: string;
  readonly outputParsed?: unknown;
  /** Set when the agent's `outputType` schema rejected the final text — `outputParsed` is
   *  then absent. Distinguishes a parse failure from "no outputType configured" (both leave
   *  `outputParsed` undefined) and carries the schema's rejection reason. */
  readonly outputParseError?: string;
  readonly messages: Message[];
  readonly usage: Usage;
  readonly interruption?: RunInterruption;
  /** OpenAI-parity alias for `interruption.pending`: the approvals and tool input requests
   *  awaiting an answer when `status === "interrupted"`. Feed the answers back through
   *  `Runner.resume`. */
  readonly interruptions?: readonly PendingRunInterrupt[];
  /** Set only when `status === "guardrail_blocked"`. */
  readonly guardrail?: RunGuardrailBlock;
}

/** Input to `Runner.resume` — the paused run's control tree plus the caller's answers. */
export interface ResumeInput {
  /** Persisted interruption state. Re-read it from the store before resuming (e.g. after a
   *  crash left `phase: "recovery_required"`); a stale copy (older revision) is rejected. */
  readonly interruption: InterruptionState;
  /** Answers keyed by approvalId (or a unique toolCallId), routed to pending entries by kind. */
  readonly answers: Record<string, InterruptAnswer>;
}

export interface RunOptions<TContext = unknown> {
  readonly context?: TContext;
  /** Id for the runner-owned session opened (and closed) for this call. Ignored only when it
   *  matches `session.id`; setting both to different values throws. */
  readonly sessionId?: string;
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
  /** Reuse an existing open session (the caller keeps ownership; the runner won't close it). */
  readonly session?: Session;
  /** Structured provenance for fresh input. Omit for an ordinary user prompt. */
  readonly inputOrigin?: PromptOrigin;
}

/**
 * A run's runtime: the shared machine (session/store/machine/permission/…, one per
 * agent graph) plus the per-(sub)run frame (`address`, `usage`, `turns`). `Engine.run`
 * takes one of these; `deriveChild` forks a child frame for a spawned sub-agent.
 */
export interface RunState<TContext> {
  readonly runId: string;
  readonly frameId: string;
  readonly agentInstanceId: string;
  readonly parentFrameId?: string;
  readonly sessionId: string;
  /** Narrow session surface (NOT the full `Session`) — see `SessionPort` for the rationale. */
  readonly session: SessionPort;
  readonly context: TContext | undefined;
  readonly signal: AbortSignal;
  usage: Usage;
  turns: number;
  readonly maxTurns: number;
  address: string;
  readonly events: EventSink;
  readonly machine: Machine;
  readonly store?: SessionStore;
  readonly responder?: Responder;
  readonly background?: BackgroundSpawner;
  readonly subagentProvider?: SubagentProvider<TContext>;
  /** Root-frame spawn concurrency cap (see RunnerConfig). */
  readonly maxConcurrentSubagents?: number;
  /** False when the host withholds the builtin `Workflow` tool (see RunnerConfig). */
  readonly workflowTool?: boolean;
  readonly permission: PermissionManager;
  readonly capabilities: AssembledCapabilities;
  readonly steer: SteerBus;
  answers?: Record<string, ApprovalResponse>;
  /** Input answers for suspended tool calls being resumed (toolCallId -> data). */
  inputAnswers?: Readonly<Record<string, unknown>>;
  /** Paused tree being resumed. Agent tools use it to locate child continuations. */
  interruption?: InterruptionState;
  /** Logical turn being continued; resume does not consume a new turn. */
  currentTurnId?: string;
  /** Tool call that spawned this (sub-)agent; surfaced on `agent_start`. Unset for root. */
  readonly parentToolCallId?: string;
}

/** Overrides applied when forking a child runtime frame from a parent (see `deriveChild`). */
export interface DeriveOptions {
  /** The child's journal shard / event address (e.g. `main/<agentId>`). */
  readonly address: string;
  /** The spawning tool call; surfaced on the child's `agent_start`. */
  readonly parentToolCallId?: string;
  /** Per-child abort (background / workflow per-agent); defaults to the parent's. */
  readonly signal?: AbortSignal;
  /** Isolated machine (e.g. a workflow worktree); defaults to the parent's. */
  readonly machine?: Machine;
  /** Own SteerBus (parallel workflow agents can't share the parent's single-turn bus). */
  readonly steer?: SteerBus;
  /** Stable instance identity for a fresh child. Defaults to the address tail. */
  readonly agentInstanceId?: string;
  /** Restore this child frame instead of minting a fresh one. */
  readonly resumeFrame?: InterruptionFrame;
}

/**
 * The engine, seen by a spawning tool: resolve a sub-agent type, fork a child runtime,
 * and run it. `run` is `Engine.run`; the subagent / Agent / Workflow tools all share one
 * of these instead of each reaching into the Runner for `runLoop`. Built by
 * `toolset.ts` (`deriveChild` in `run-support.ts` is the single place child frames are
 * minted).
 */
export interface SubagentSpawner<TContext> {
  /** Available sub-agent types = static `subagents` ∪ runtime provider agents. */
  readonly available: readonly SubagentInfo[];
  /** Type spawned when none is named (prefers `coder`, else the first available). */
  readonly defaultType: string;
  /** Resolve a type to an `Agent` (static graph wins over the provider). */
  resolve(type: string): Promise<Agent<TContext> | undefined>;
  /** Resolve an active handoff target within a subagent definition graph. */
  resolveInGraph(root: Agent<TContext>, key: string): Agent<TContext> | undefined;
  /** Fork a child runtime frame from the parent this spawner was made for. */
  derive(opts: DeriveOptions): RunState<TContext>;
  /** Run an agent to completion under a runtime (the engine call). */
  run(
    agent: Agent<TContext>,
    context: ConversationContext,
    state: RunState<TContext>,
    resumeFrom?: AssistantMessage,
  ): Promise<RunResult>;
  /** Build a run context (sessionId/address/signal/context) for a child frame, e.g. for guardrails. */
  ctxFor(state: RunState<TContext>): AgentRunContext<TContext>;
}

export class Runner<TContext = unknown> {
  /** The harness-tier scope every Runner-opened session hangs under. */
  readonly scope: Scope<"harness" | "workspace">;
  private readonly config: RunnerConfig<TContext>;
  private readonly engine: Engine<TContext>;

  constructor(scope: Scope<"harness" | "workspace">, config: RunnerConfig<TContext> = {}) {
    if ((scope as Scope).kind === "session") throw new Error("Runner needs a harness or workspace scope, not a session scope");
    this.scope = scope;
    this.config = config;
    this.engine = new Engine(config);
  }

  async run(
    agent: Agent<TContext>,
    input: AgentInput,
    opts?: RunOptions<TContext>,
  ): Promise<RunResult> {
    return this.withLease(opts, async (lease) => {
      const { session, owned } = await this.acquireSession(opts, undefined, lease);
      try {
        return await session.withRunLock(() => {
          // Cancelled while queued behind another run: leave without touching the session —
          // no reconcile, no context replay, no `agent.started` on the log.
          opts?.signal?.throwIfAborted();
          return this.execute(agent, input, opts, session);
        });
      } finally {
        if (owned) await session.close();
      }
    });
  }

  /**
   * Hold the session lease for the duration of `fn`, when a lock is configured.
   *
   * Taken BEFORE the session is opened: opening assembles capabilities, may connect MCP servers
   * and may boot a sandbox, none of which should happen for a run that is about to be rejected.
   *
   * Only a session with a known id can be contended. A run that neither reuses a session nor
   * names one is opening a fresh id nobody else can hold, so it skips the lease entirely.
   */
  private async withLease<T>(
    opts: RunOptions<TContext> | undefined,
    fn: (lease?: SessionLease) => Promise<T>,
  ): Promise<T> {
    const lock = this.config.lock;
    const sessionId = opts?.session?.id ?? opts?.sessionId;
    if (lock === undefined || sessionId === undefined) return fn();
    const lease = await lock.acquire(sessionId, opts?.signal !== undefined ? { signal: opts.signal } : {});
    if (lease === undefined) throw new SessionBusyError(sessionId);
    try {
      return await fn(lease);
    } finally {
      await lease.release();
    }
  }

  runStream(agent: Agent<TContext>, input: AgentInput, opts?: RunOptions<TContext>): RunHandle<RunResult> {
    const pull = new IterableSink();
    const completed = this.withLease(opts, async (lease) => {
      // One-shot pull sessions emit straight to `pull` (the bus IS the iterable). For a
      // shared session, subscribe `pull` to its bus so we never replace the channel (Invariant 4).
      const { session, owned } = await this.acquireSession(opts, pull, lease);
      let unsub: (() => void) | undefined;
      try {
        return await session.withRunLock(() => {
          // Cancelled while queued behind another run: leave without touching the session —
          // no reconcile, no context replay, no `agent.started` on the log.
          opts?.signal?.throwIfAborted();
          // Subscribe only now, holding the lock: subscribing while queued would hand this
          // stream the tail of the run ahead of it (its inputs and answers) before its own.
          if (!owned) unsub = session.events.subscribe((ev) => void pull.emit(ev));
          return this.execute(agent, input, opts, session);
        });
      } finally {
        unsub?.();
        pull.close();
        if (owned) await session.close();
      }
    }).catch((error: unknown) => {
      // A rejected lease throws before the body runs, so nothing has closed `pull` — a consumer
      // iterating the handle would hang forever waiting for a stream that never opens.
      pull.close();
      throw error;
    });
    // Avoid an unhandled rejection if the caller only iterates and never awaits `completed`.
    completed.catch(() => undefined);
    return {
      [Symbol.asyncIterator]: () => pull[Symbol.asyncIterator](),
      completed,
    };
  }

  /** Continue an interrupted run. Mirrors `run(agent, input, opts)`: the second argument is
   *  the resume input (paused control tree + answers) instead of a fresh prompt. */
  async resume(
    rootAgent: Agent<TContext>,
    input: ResumeInput,
    opts?: RunOptions<TContext>,
  ): Promise<RunResult> {
    const { interruption, answers } = input;
    assertGraphUnambiguous(rootAgent);
    const parsed = parseInterruptionState(interruption);
    const rootFrame = parsed.frames[parsed.rootFrameId]!;
    const active = findAgentByName(rootAgent, rootFrame.agent.key);
    if (!active) {
      throw new Error(`Cannot resume: agent "${rootFrame.agent.key}" not found in the provided agent graph.`);
    }
    const updated = applyInterruptionAnswers(parsed, answers);
    const baseOpts = opts;
    // Resuming is running: it needs the same exclusivity as a fresh prompt, or two nodes
    // continue the same interrupted run and both consume its answers.
    return this.withLease(baseOpts, async (lease) => {
      const { session, owned } = await this.acquireSession(baseOpts, undefined, lease);
      // Reopening a session: orphaned background subagents (running from a dead process) → lost.
      await session.reconcileSubagents();
      try {
        return await session.withRunLock(async () => {
          baseOpts?.signal?.throwIfAborted();
          const store = session.store;
          if (!store) throw new Error("Cannot resume an interrupted run without a durable session store.");
          const currentRaw = await store.getState(INTERRUPTION_STATE_KEY);
          if (currentRaw === null) throw new Error("Cannot resume: this session has no persisted interruption state.");
          const current = parseInterruptionState(currentRaw);
          if (current.interruptionId !== parsed.interruptionId || current.revision !== parsed.revision) {
            throw new Error(
              `Cannot resume stale interruption state (expected ${current.interruptionId}@${current.revision}, received ${parsed.interruptionId}@${parsed.revision}).`,
            );
          }
          session.setConversationHead({ agentKey: active.name, address: rootFrame.address });
          const state = await this.beginRun(session, baseOpts, updated);
          await store.putState(INTERRUPTION_STATE_KEY, updated);
          // History is the log's job — replay it (the active agent's shard) to rebuild context.
          const context = await replayContext(store, rootFrame.address);
          session.setLiveContext(rootFrame.address, context);
          try {
            const resumeFrom = findAnchoredAssistant(context.messages, rootFrame.anchor);
            const result = await this.engine.run(active, context, state, resumeFrom);
            if (result.status !== "interrupted") await store.deleteState(INTERRUPTION_STATE_KEY);
            return result;
          } catch (error) {
            const current = await store.getState(INTERRUPTION_STATE_KEY);
            if (current !== null) {
              const recovery = parseInterruptionState(current);
              if (recovery.phase === "resuming") {
                await store.putState(INTERRUPTION_STATE_KEY, {
                  ...recovery,
                  phase: "recovery_required",
                  revision: recovery.revision + 1,
                  updatedAt: Date.now(),
                } satisfies InterruptionState);
              }
            }
            throw error;
          } finally {
            await this.settleRun(session, state, context);
          }
        });
      } finally {
        if (owned) await session.close();
      }
    });
  }

  // Internals.

  /** Reuse the caller's session, or open one for this run. `owned` means we created it and the
   *  caller of this method must close it. */
  private async acquireSession(
    opts: RunOptions<TContext> | undefined,
    eventsOverride?: EventSink,
    lease?: SessionLease,
  ): Promise<{ session: Session; owned: boolean }> {
    if (opts?.session) {
      // An explicit session wins, but a contradictory sessionId is a caller bug — surface
      // it instead of silently ignoring one of the two.
      if (opts.sessionId !== undefined && opts.sessionId !== opts.session.id) {
        throw new Error(
          `RunOptions.session (id "${opts.session.id}") and RunOptions.sessionId ("${opts.sessionId}") disagree; pass one of them, or make them match.`,
        );
      }
      return { session: opts.session, owned: false };
    }
    const scope = this.scope.child("session");
    if (opts?.sessionId !== undefined) scope.register(T.SessionId, opts.sessionId);
    // Losing the lease cancels the run: a holder that can no longer renew has, by definition,
    // been superseded, and must stop before its writes race the node that took over. Only the
    // session this runner owns is wired up — a caller-supplied session keeps its own signal.
    const signal = mergeSignals(opts?.signal, lease?.signal);
    if (signal !== undefined) scope.register(T.HostSignal, signal, { owned: false });
    // A one-shot pull stream IS the session's event bus (Invariant 4); it wins over the hook's.
    if (eventsOverride !== undefined) scope.register(T.Events, eventsOverride, { owned: false });
    const capabilities = (await this.config.session?.(scope, { sessionId: opts?.sessionId })) ?? [];
    const session = await Session.open(scope, { capabilities });
    return { session, owned: true };
  }

  /** Resolve the durable conversation owner by following committed handoffs from `main`. */
  private async resolveConversationHead(
    session: Session,
    rootAgent: Agent<TContext>,
  ): Promise<{ agent: Agent<TContext>; address: string }> {
    const cached = session.conversationHead();
    if (cached !== undefined) {
      const matches = findAgentsByName(rootAgent, cached.agentKey);
      if (matches.length === 0) {
        throw new Error(
          `Cannot continue session: active agent "${cached.agentKey}" is not present in the provided agent graph.`,
        );
      }
      if (matches.length === 1) return { agent: matches[0]!, address: cached.address };
      // Several distinct agents share the cached name: the cache stores only the name, so it
      // cannot say WHICH object owns the conversation. Fall through to the cold walk below —
      // it resolves along committed handoff edges, which stays correct under duplicate names.
    }

    let head: ConversationHead = { agentKey: rootAgent.name, address: DEFAULT_ADDRESS };
    let current = rootAgent;
    const store = session.store;
    if (store !== undefined) {
      const visited = new Set<string>();
      let expectedAcceptance: { handoffId: string; fromAddress: string } | undefined;

      while (true) {
        if (visited.has(head.address)) {
          throw new Error(`Cannot continue session: handoff chain contains a cycle at "${head.address}".`);
        }
        if (visited.size >= 64) {
          throw new Error("Cannot continue session: handoff chain exceeds 64 transfers.");
        }
        visited.add(head.address);

        const records: AgentRecord[] = [];
        for await (const record of store.readRecords({ address: head.address })) records.push(record);

        if (
          expectedAcceptance !== undefined &&
          !records.some(
            (record) =>
              record.type === "agent.handoff.accepted" &&
              record.handoffId === expectedAcceptance!.handoffId &&
              record.fromAddress === expectedAcceptance!.fromAddress,
          )
        ) {
          throw new Error(
            `Cannot continue session: handoff "${expectedAcceptance.handoffId}" points to uninitialized shard "${head.address}".`,
          );
        }

        const committed = records.filter(
          (record): record is Extract<AgentRecord, { type: "agent.handoff" }> & {
            handoffId: string;
            toAddress: string;
          } =>
            record.type === "agent.handoff" &&
            typeof record.handoffId === "string" &&
            typeof record.toAddress === "string",
        );
        if (committed.length === 0) {
          // Reuse the leaf records we already read to seed the live cache; otherwise the caller
          // would immediately replay the same shard a second time before appending the prompt.
          if (session.liveContext(head.address) === undefined) {
            const context = new ConversationContext({
              store,
              address: head.address,
            });
            context.loadFromRecords(records);
            session.setLiveContext(head.address, context);
          }
          break;
        }
        if (committed.length > 1) {
          throw new Error(`Cannot continue session: frozen shard "${head.address}" has multiple committed handoffs.`);
        }

        const transfer = committed[0]!;
        // This shard's records were written by `current`, so the committed transfer followed one
        // of its own handoff edges. Resolving along that edge (not a global graph search) retraces
        // the original run, so a same-named agent elsewhere in the graph can never capture the
        // conversation — target names only have to be unambiguous within one agent's handoffs.
        const edges = current.handoffs.filter((h) => h.target.name === transfer.to);
        const target = edges[0]?.target;
        if (target === undefined) {
          throw new Error(
            `Cannot continue session: handoff target "${transfer.to}" is not among agent "${current.name}"'s handoffs.`,
          );
        }
        if (edges.some((h) => h.target !== target)) {
          throw new Error(
            `Cannot continue session: agent "${current.name}" has multiple handoff targets named "${transfer.to}".`,
          );
        }
        current = target;
        expectedAcceptance = { handoffId: transfer.handoffId, fromAddress: head.address };
        head = { agentKey: current.name, address: transfer.toAddress };
      }
    }

    session.setConversationHead(head);
    return { agent: current, address: head.address };
  }

  private async execute(
    rootAgent: Agent<TContext>,
    input: AgentInput,
    opts: RunOptions<TContext> | undefined,
    session: Session,
  ): Promise<RunResult> {
    assertGraphUnambiguous(rootAgent);
    // A normal post-crash continuation is a fresh prompt (for example "continue"), not the
    // HITL-specific Runner.resume path. Reconcile durable task ghosts before request recovery
    // inspects them so BackgroundOutput is given the truthful terminal `lost` status.
    await session.reconcileSubagents();
    if (session.store && (await session.store.getState(INTERRUPTION_STATE_KEY)) !== null) {
      throw new Error("This session has an interrupted run. Resume or resolve it before starting a new prompt.");
    }
    const head = await this.resolveConversationHead(session, rootAgent);
    const agent = head.agent;
    const state = await this.beginRun(session, opts, undefined, head.address);
    // Live runs tolerate duplicate names (edges resolve by object), but durable name-keyed
    // resolution (resume) fails closed on them — warn now, not mid-recovery.
    const duplicates = duplicateAgentNames(rootAgent);
    if (duplicates.length > 0) {
      emitRunEvent(state, {
        type: "warning",
        message: `Agent graph contains duplicate agent names (${duplicates.join(", ")}). Interrupted runs referencing these names cannot be resumed — give agents unique names.`,
      });
    }
    // Continue the conversation. A long-lived session keeps its live context, so we append to it
    // (O(1)) instead of replaying the whole log every turn. Model-visible reminders are ordinary
    // append-only context records, so the live prefix is exactly what a cold replay reconstructs.
    // A cold run (new session, or after a log rewrite) replays the log once and caches it. No
    // store means the same append-only behavior, held only in memory.
    let context = session.liveContext(state.address);
    if (context === undefined) {
      context = state.store
        ? await replayContext(state.store, state.address)
        : new ConversationContext({
            store: state.store,
            address: state.address,
            onHistoryChange: historyChangeEmitter(state.events, state.sessionId),
          });
      session.setLiveContext(state.address, context);
    }
    // Capability interception of the caller's input, BEFORE guardrails and before anything is
    // journaled: a rewrite here is what the run (and its replay) sees as the prompt. Guardrails
    // then judge what actually enters history, not what the caller originally sent.
    const runStart = await this.applyRunStarts(state, agent.name, toMessages(input));
    const messages = runStart.input;
    let inputAccepted = false;
    try {
      // A capability answered it. Nothing is journaled — not the prompt, not a reply — so the
      // session is byte-identical to before the call, and `messages` reflects that. Inside the
      // try so teardown still runs through the one `settleRun` in `finally`.
      if (runStart.handled !== undefined) {
        return {
          status: "skipped",
          finalAgent: agent.name,
          activeAddress: state.address,
          output: runStart.handled.output ?? "",
          messages: [...context.messages],
          usage: emptyUsage(),
        };
      }
      await runInputGuardrails(agent.guardrails.input ?? [], {
        agent,
        input: messages,
        context: runCtxFor(state),
      });
      // Append + journal the new user input as the next turn of history, surfacing each via
      // `message.appended` so consumers can rebuild the transcript uniformly (prompts get a
      // signal too, not just assistant/toolResult). These fire before agent.started — the input
      // exists before the agent begins — and the tracing bridge ignores non-assistant messages.
      for (const message of messages) context.appendMessage(message, opts?.inputOrigin);
      inputAccepted = true;
      // No input of its own ⇒ a wake run, whose prompt IS whatever is queued (a background task
      // that settled after its spawning turn ended, a cron fire, a peer message). Let the first
      // iteration drain, or the turn would run with nothing new in front of the model.
      return await this.engine.run(agent, context, state, undefined, messages.length === 0);
    } catch (error) {
      // A guardrail tripwire aborts the whole run by throwing (like OpenAI Agents). Emit a
      // clean terminal frame first so streaming consumers don't see the event stream silently
      // truncate; the run still rejects with the enriched GuardrailTripwireError.
      if (isGuardrailTripwireError(error)) {
        if (error.usage !== undefined) {
          state.usage = addUsage(state.usage, error.usage);
          const activeContext = session.liveContext(state.address) ?? context;
          activeContext.record({ type: "usage.record", usage: error.usage, total: state.usage });
          if (state.store === undefined) void emitRunEvent(state, { type: "usage.updated", usage: state.usage });
        }
        const blocked = {
          type: "guardrail.blocked",
          stage: error.stage,
          guardrail: error.guardrailName,
          ...(error.agentName !== undefined ? { agent: error.agentName } : {}),
          ...(error.turnId !== undefined ? { turnId: error.turnId } : {}),
          ...(error.step !== undefined ? { step: error.step } : {}),
          ...(error.stepId !== undefined ? { stepId: error.stepId } : {}),
          message: error.message,
        } as const;
        const activeContext = session.liveContext(state.address) ?? context;
        activeContext.record({
          ...blocked,
          ...(error.stage === "input" && !inputAccepted ? { input: [...messages] } : {}),
        });
        if (state.store === undefined) void emitRunEvent(state, blocked);
      }
      throw error;
    } finally {
      await this.settleRun(session, state, context);
    }
  }

  /**
   * Chain the capabilities' run-tier input hooks. Each sees the previous one's rewrite; a hook
   * that throws is skipped (fault isolation — a broken capability must not sink the prompt).
   */
  private async applyRunStarts(
    state: RunState<TContext>,
    agentName: string,
    input: readonly Message[],
  ): Promise<{ input: Message[]; handled?: { output?: string } }> {
    let current = input;
    for (const hook of state.capabilities.runStarts) {
      try {
        const result = await hook({
          sessionId: state.sessionId,
          address: state.address,
          agent: agentName,
          signal: state.signal,
          input: current,
        });
        // First claim wins: once a hook answers the prompt there is nothing left to rewrite.
        if (result?.handled !== undefined) return { input: [...current], handled: result.handled };
        if (result?.input !== undefined) current = result.input;
      } catch (error) {
        emitRunEvent(state, {
          type: "warning",
          message: `beforeRun hook failed; input left unchanged: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { input: [...current] };
  }

  /**
   * The run teardown invariant shared by execute() and resume(): flush the run's ACTIVE
   * shard — not the entry `context`; a handoff during the run re-points `state.address`
   * at a new shard (session.setLiveContext), and that shard's context is what holds the
   * run's latest unflushed writes — then stop capabilities and surface their diagnostics.
   */
  private async settleRun(session: Session, state: RunState<TContext>, context: ConversationContext): Promise<void> {
    await (session.liveContext(state.address) ?? context).flush();
    await state.capabilities.stop();
    await session.flushEvents();
    this.reportDiagnostics(state);
  }

  private async beginRun(
    session: Session,
    opts: RunOptions<TContext> | undefined,
    interruption?: InterruptionState,
    initialAddress: string = DEFAULT_ADDRESS,
  ): Promise<RunState<TContext>> {
    // Per-run cancel handle, downstream of the caller's (or the session's) signal. Capabilities
    // that abort stop THIS run — the session stays usable for the next prompt — while an
    // upstream abort still tears the run down. `AbortSignal.any` owns the listener lifetime.
    const runController = new AbortController();
    const upstream = opts?.signal ?? session.signal;
    const signal = AbortSignal.any([upstream, runController.signal]);
    const ctx: Omit<RunContext, "injection" | "gates"> = {
      scope: session.scope,
      sessionId: session.id,
      signal,
      // Same session controls, except `abort` is scoped to this run rather than the session.
      controls: {
        ...session.controls(),
        abort: (reason) => {
          if (!runController.signal.aborted) runController.abort(abortReason(reason ?? "run aborted by a capability"));
        },
      },
    };
    const capabilities = await assembleCapabilities(session.capabilities, ctx);
    const permission = session.permission;
    const frame = interruption?.frames[interruption.rootFrameId];
    const state: RunState<TContext> = {
      runId: interruption?.runId ?? newInterruptionId("run"),
      frameId: frame?.frameId ?? newInterruptionId("frame"),
      agentInstanceId: frame?.agentInstanceId ?? "root",
      sessionId: session.id,
      session,
      context: opts?.context,
      signal,
      usage: frame?.execution.usage ?? emptyUsage(),
      turns: frame?.execution.turns ?? 0,
      maxTurns: frame?.execution.maxTurns ?? opts?.maxTurns ?? this.config.maxTurns ?? 16,
      address: frame?.address ?? initialAddress,
      events: session.events,
      machine: session.machine,
      store: session.store,
      responder: session.responder,
      background: session.background,
      subagentProvider: this.config.subagentProvider,
      ...(this.config.maxConcurrentSubagents !== undefined ? { maxConcurrentSubagents: this.config.maxConcurrentSubagents } : {}),
      workflowTool: this.config.workflowTool,
      permission,
      capabilities,
      steer: session.steer,
      answers: frame ? { ...frame.decisions } : undefined,
      inputAnswers: frame?.inputAnswers,
      interruption,
      currentTurnId: frame?.turnId,
    };
    // Emit any session-tier diagnostics (openSession failures) once, on first run.
    for (const diagnostic of session.drainDiagnostics()) {
      const message = `[capability ${diagnostic.capability}/${diagnostic.phase}] ${diagnostic.message}`;
      emitRunEvent(state, diagnostic.level === "error" ? { type: "error", message } : { type: "warning", message });
    }
    return state;
  }

  private reportDiagnostics(state: RunState<TContext>): void {
    for (const diagnostic of state.capabilities.diagnostics) {
      const message = `[capability ${diagnostic.capability}/${diagnostic.phase}] ${diagnostic.message}`;
      emitRunEvent(state, diagnostic.level === "error" ? { type: "error", message } : { type: "warning", message });
    }
  }
}

/**
 * The engine that actually runs an agent. `run` is the loop; it holds no run state —
 * everything flows through `(agent, context, state)`, and its only tie to the Runner is
 * the shared `RunnerConfig`. `Runner.run`/`resume` build a default runtime and call
 * `engine.run`; a tool (subagent / Agent / Workflow) that holds a runtime calls it too,
 * so "run an agent" is one engine call, not a privilege reached out of the Runner.
 */
class Engine<TContext> {
  private readonly config: RunnerConfig<TContext>;

  constructor(config: RunnerConfig<TContext>) {
    this.config = config;
  }

  async run(
    initial: Agent<TContext>,
    context: ConversationContext,
    state: RunState<TContext>,
    resumeFrom?: AssistantMessage,
    /**
     * Let the FIRST iteration drain queued follow-ups. Set only for a wake run — one started
     * with no input precisely to consume what is already queued (a settled background task, a
     * cron fire). The usual bar against draining on iteration one exists so a follow-up is not
     * merged into the caller's prompt; with no prompt there is nothing to merge into, and
     * refusing to drain would run a turn with no new input at all.
     */
    drainQueuedAtStart?: boolean,
  ): Promise<RunResult> {
    let messages = context.messages; // replaced only when a handoff opens a fresh root shard
    let current = initial;
    let resume = resumeFrom;
    let canDrainFollowUps = drainQueuedAtStart === true;
    emitRunEvent(state, { type: "agent.started", agent: current.name, ...(state.parentToolCallId ? { parentToolCallId: state.parentToolCallId } : {}) });

    while (true) {
      state.signal.throwIfAborted();
      const resumingInterruptedTurn = resume !== undefined;
      if (!resumingInterruptedTurn) {
        if (state.turns >= state.maxTurns) {
          return this.finish(state, "max_turns", current, messages);
        }
        state.turns += 1;
      }

      // A follow-up belongs after work that has already run. In particular, never drain one
      // on the first iteration (where it would be merged into the initial prompt) or at the
      // start of an interrupted-turn resume. The prior iteration's terminal path decides
      // whether to loop; this next iteration consumes the queued prompts as its new input.
      // Deliberately NOT reset on handoff: the pre-handoff agent's turn already ran, so the
      // target agent's first iteration draining a queued follow-up still honors this rule.
      if (canDrainFollowUps) {
        for (const { id, message, origin } of state.steer.drainFollowUps()) {
          context.appendMessage(message, steerOriginToPromptOrigin(origin, id));
        }
      }

      // Fresh turns append durable reminders to the context tail. HITL resume continues the
      // already-framed model turn: injecting here would separate its assistant tool call from
      // the resumed tool result and would change the cached request prefix.
      const injectionTokens = resumingInterruptedTurn ? new Map<string, number>() : injectAtTurnBoundary(state, context);

      const model = await this.resolveModelFor(current, state);
      const system = await current.resolveInstructions(runCtxFor(state));
      // The engine's run loop rides into the toolset as a plain callback: the spawner the
      // subagent/Agent/Workflow tools share calls it to run child agents.
      const toolset = await buildRunTools(
        current,
        state,
        (agent, childContext, childState, childResume) =>
          this.run(agent, childContext, childState, childResume),
        model,
      );
      const hooks = buildRunHooks(current, state, context, toolset.tools);
      const visibleTools = activeDeferredTools(
        toolset.tools,
        toolset.deferredToolNames,
        context.messages,
      );

      // Stamp a context-window breakdown snapshot from exactly what this turn will send, so
      // `session.getContextBreakdown()` (and the app-server RPC) can report where tokens go.
      state.session.recordContextBreakdown(
        computeContextBreakdown({
          model,
          system,
          tools: visibleTools,
          messages: context.messages,
          injectionTokens,
          compactBufferTokens: state.session.compaction?.reservedContextTokens ?? 0,
          capturedAt: Date.now(),
        }),
      );
      const turnId = state.currentTurnId ?? `${state.sessionId}-t${state.turns}`;
      const outputGuardrails = current.guardrails.output ?? [];

      if (resume === undefined) emitRunEvent(state, { type: "turn.started", turnId });
      state.steer.beginTurn(turnId);
      let r;
      try {
        r = await runTurn({
          turnId,
          address: state.address,
          sessionId: state.sessionId,
          signal: state.signal,
          model,
          machine: state.machine,
          background: state.background,
          responder: state.responder,
          // Per-address ledger: main agent and each subagent line keep independent
          // read-before-write state that survives across turns and run() calls.
          fileLedger: state.session.fileLedgerFor(state.address),
          system,
          context,
          tools: toolset.tools,
          deferredToolNames: toolset.deferredToolNames,
          hooks,
          params: resolveModelParams(current.modelSettings, state.session.thinkingSetting),
          createOutputGuardrailMonitor: outputGuardrails.length > 0
            ? (options) => createOutputGuardrailMonitor(outputGuardrails, current, runCtxFor(state), options)
            : undefined,
          maxSteps: current.maxStepsPerTurn ?? this.config.maxStepsPerTurn,
          maxRetriesPerStep: this.config.maxRetriesPerStep,
          drainSteering: () => state.steer.drainSteering().map((s) => ({ message: s.message, origin: steerOriginToPromptOrigin(s.origin, s.id) })),
          // One sink: the loop dispatches real AgentEvent bodies; we only add the envelope.
          dispatchEvent: (body) => void emitRunEvent(state, body),
          logger: state.session.logger,
          resumeFrom: resume,
          resume: resume !== undefined ? frameResume(state) : undefined,
        });
      } catch (error) {
        // The turn we opened above must not end without a `turn.ended` — a streaming consumer
        // would otherwise see the event stream truncate with nothing to say it stopped, and a
        // client waiting on this turn would wait forever. A guardrail tripwire is the one throw
        // that already carries its own terminal frame (`guardrail.blocked`, emitted by the
        // outer handler), so we leave it be; everything else is closed here before it propagates.
        // An aborted signal is a cancel, not a failure; anything else is a genuine failure and
        // carries its message so a later reader learns why, not just that it stopped.
        if (!isGuardrailTripwireError(error)) {
          const aborted = state.signal.aborted || isAbortError(error);
          emitRunEvent(state, {
            type: "turn.ended",
            turnId,
            reason: aborted ? "cancelled" : "failed",
            ...(aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
            contextWindow: model.contextWindow,
          });
        }
        throw error;
      } finally {
        state.steer.endTurn();
      }
      canDrainFollowUps = true;
      resume = undefined;
      state.currentTurnId = undefined;
      state.usage = addUsage(state.usage, r.usage);
      // Audit record: per-turn cost, journaled in order with the message stream (not history).
      context.record({ type: "usage.record", model: model.id, usage: r.usage, total: state.usage });
      if (state.store === undefined) emitRunEvent(state, { type: "usage.updated", usage: state.usage });
      if (r.stopReason === "interrupt") {
        const pending = r.pending ?? [];
        const suspensions = r.suspensions ?? [];
        // Live: an injected Responder that answers approvals inline does so in place, then we
        // resume in memory. When no responder is present, or it reports it isn't a live approver
        // (`isLiveApprover() === false`), we fall through to the durable pause — this is the
        // "no live responder ⇒ durable" rule. Child suspensions have already gone through the same
        // responder, so a live responder only needs to answer this frame's direct approvals.
        // Tool input suspensions always go durable: a tool that wanted a live answer would have
        // used the responder channel instead of suspending.
        const approvals = pending.filter((p): p is PendingApprovalInterrupt => p.kind === "approval");
        if (pending.length > 0 && approvals.length === pending.length && suspensions.length === 0 && state.responder && (state.responder.isLiveApprover?.() ?? true)) {
          const answers: Record<string, ApprovalResponse> = {};
          for (const p of approvals) {
            // A batch can contain several approval-required tools. Stop must end the
            // currently visible request without advancing to the next one in the batch.
            if (state.signal.aborted) return this.finish(state, "aborted", current, messages);
            const answer = await state.responder.requestApproval(
              {
                toolCallId: p.toolCallId,
                toolName: p.toolName,
                approvalRule: p.approvalRule,
                display: p.display,
              },
              { signal: state.signal },
            );
            if (state.signal.aborted) return this.finish(state, "aborted", current, messages);
            answers[p.toolCallId] = answer;
          }
          // Continue the SAME model turn in this loop with the pending batch pre-answered — a
          // loop, not recursion, so memory stays flat across many live-approval rounds and the
          // still-running agent does not re-emit `agent.started`.
          state.answers = { ...state.answers, ...answers };
          state.currentTurnId = turnId;
          resume = lastAssistant(messages)!;
          // Mirror the reset a fresh run() entry would have done: a resumed interrupted turn
          // must not drain follow-ups at its start (see the drain rule above).
          canDrainFollowUps = false;
          continue;
        }
        return pauseRun(current, context, pending, suspensions, state, turnId);
      }

      emitRunEvent(state, {
        type: "turn.ended",
        turnId,
        // A turn can settle on an error without throwing — a model that returns an error stop,
        // an unclaimed context overflow. That is a failed turn, not a completed one, and saying
        // "completed" would be the same silent lie a missing `turn.ended` is.
        reason: r.stopReason === "error" ? "failed" : "completed",
        contextWindow: model.contextWindow,
      });

      if (r.stopReason === "handoff" && r.handoff) {
        const next = await performHandoff(current, context, r.handoff, state);
        if (!next) return this.finish(state, "error", current, messages);
        current = next.agent;
        context = next.context;
        messages = context.messages;
        continue;
      }

      // Terminal stop reasons.
      if (r.stopReason === "end_turn") {
        // A follow-up that landed during this turn (a background task finished, a cron fired)
        // makes the agent run one more turn to consume it instead of stopping — the boundary
        // drain above injects it. User steers can't reach here: runTurn keeps them in-turn.
        if (state.steer.hasFollowUps()) continue;
        // wants another turn, loop (re-injecting at the boundary) instead of finishing.
        if (await this.shouldContinueAtBoundary(state, model, r.usage)) continue;
      }
      return this.finish(state, mapTerminalStatus(r.stopReason), current, messages);
    }
  }

  private finish(state: RunState<TContext>, status: RunStatus, agent: Agent<TContext>, history: readonly Message[]): RunResult {
    // Snapshot: RunResult.messages must not alias the LIVE context array, or a later turn
    // (or a caller mutating the result) would corrupt the other side.
    const messages = [...history];
    emitRunEvent(state, { type: "agent.ended", agent: agent.name });
    const output = finalText(messages);
    let outputParsed: unknown;
    let outputParseError: string | undefined;
    if (agent.outputType && output) {
      const parsed = tryParseOutput(agent.outputType, output);
      outputParsed = parsed.value;
      outputParseError = parsed.error;
      if (parsed.error !== undefined) {
        emitRunEvent(state, { type: "warning", message: `Agent "${agent.name}" outputType rejected the final output: ${parsed.error}` });
      }
    }
    return {
      status,
      finalAgent: agent.name,
      activeAddress: state.address,
      output,
      outputParsed,
      ...(outputParseError !== undefined ? { outputParseError } : {}),
      messages,
      usage: state.usage,
    };
  }

  private async shouldContinueAtBoundary(state: RunState<TContext>, model: ChatModel, usage: Usage): Promise<boolean> {
    for (const hook of state.capabilities.boundaryContinuations) {
      const result = await hook({
        turnId: `${state.sessionId}-t${state.turns}`,
        stepNumber: state.turns,
        usage,
        stopReason: "end_turn",
        signal: state.signal,
        model,
      });
      if (result?.continue === true) return true;
    }
    return false;
  }

  private async resolveModelFor(agent: Agent<TContext>, state: RunState<TContext>): Promise<ChatModel> {
    const model = state.session.modelSetting ?? agent.model;
    if (!model) throw new Error(`Agent "${agent.name}" has no model.`);
    if (typeof model !== "string") return model;
    if (!this.config.resolveModel) {
      throw new Error(`Agent "${agent.name}" uses model id "${model}" but no resolveModel was configured.`);
    }
    return this.config.resolveModel(model);
  }
}

// Pure helpers.

/**
 * The paused frame's batch-resume payload (pending entries + input answers), consumed by the
 * tool-call layer when re-running the interrupted batch: answered suspended calls get their
 * continuation, unanswered ones re-park. Live in-memory resumes have no reified frame → undefined.
 */
function frameResume<TContext>(state: RunState<TContext>): BatchResume | undefined {
  const frame = state.interruption?.frames[state.frameId];
  if (!frame) return undefined;
  return { pending: frame.pending, inputAnswers: state.inputAnswers ?? {} };
}

function toMessages(input: AgentInput): Message[] {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }];
  }
  return [...input];
}

/** Combine optional signals: the result aborts when either does. */
function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}
