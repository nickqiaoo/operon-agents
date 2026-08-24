/**
 * Mode 2 — batteries-included, in-process Harness facade.
 *
 * Wraps the `operon-agents-core` engine into the kind of ergonomic interface a CLI
 * backend wants: `createHarness()` manages sessions, and each session exposes
 * `prompt()/steer()/followUp()/cancel()/onEvent()/setApprovalHandler()` plus the full
 * control plane (goals, plan mode, compaction, skills, plugins, …) delegated to
 * the core `Session`.
 *
 * It is a pure composition of core primitives — no new engine behavior. For the
 * low-level "assemble it yourself / stateless server" path, import from
 * `operon-agents/core` instead.
 */
import {
  type AgentEvent,
  type AgentRecord,
  type EventPublicationMode,
  type AgentEventListener,
  type AgentInput,
  readLog,
  SessionProjection,
  type SessionSnapshot,
  type SnapshotOptions,
  type DirectoryEntry,
  type ProjectionObservation,
  type ProjectionListener,
  type ApprovalRequest,
  type ApprovalResponse,
  type Capability,
  type InterruptAnswer,
  type ChatModel,
  ListenerSink,
  agentEventFromRecord,
  newAgentEventId,
  type PermissionManagerOptions,
  type PermissionMode,
  type PendingRunInterrupt,
  type QuestionRequest,
  type QuestionResult,
  type Responder,
  type RunHandle,
  type RunResult,
  type SessionStore,
  type SessionHandle,
  type SessionSummary,
  type ListSessionsFilter,
  type CreateSessionInput,
  type OpenSessionOptions,
  type DeleteSessionOptions,
  type ThinkingLevel,
  type Tool,
  type Logger,
  type PromptOrigin,
  type ExternalOriginMetadataValue,
  type SteerChannel,
  type SteerOrigin,
  Agent,
  buildAgentFromProfile,
  INTERRUPTION_STATE_KEY,
  flattenPendingInterrupts,
  parseInterruptionState,
  Runner,
  Session,
  emptyUsage,
  renderSteerText,
  isGuardrailTripwireError,
  type GuardrailTripwireError,
  askUserQuestionTool,
  backgroundCapability,
  compactionCapability,
  filesystemTools,
  goalCapability,
  LocalMachine,
  McpOAuthService,
  MemorySessionRepository,
  SessionRepositoryNotFoundError,
  planCapability,
  skillsCapability,
  SkillRegistry,
  mcpServersCapability,
  pluginsCapability,
  userHooksCapability,
  type HookDef,
  type McpServerConfig,
  type PluginManager,
  type ApprovalRequestOptions,
  type Machine,
  type MachineFactory,
  type SessionRepository,
  type ResolvedAgentProfile,
  taskCapability,
  workflowCapability,
  DEFAULT_AGENT_PROFILES,
  DEFAULT_AGENT_PROFILE_NAME,
  DEFAULT_SUBAGENT_NAMES,
  profileSubagentProvider,
  type SubagentProvider,
  type ModelRuntime,
  DEFAULT_ADDRESS,
} from "operon-agents-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { extensionsCapability, ExtensionRuntime, HarnessExtensionManager, ServiceRegistry, stageDefinition, type ExtensionDefinition, type ExtensionHost, type ServiceOptions, type StagedDefinition } from "./extensions/index.ts";
import { createExtensionCommandRegistry, type CommandRegistry, type CommandResult } from "operon-agents-core";

export type ApprovalHandler = (
  request: ApprovalRequest,
  options?: ApprovalRequestOptions,
) => Promise<ApprovalResponse> | ApprovalResponse;
export type QuestionHandler = (
  request: QuestionRequest,
  options?: { readonly signal?: AbortSignal },
) => Promise<QuestionResult> | QuestionResult;

export type HarnessSessionState = "idle" | "running" | "interrupted" | "closed";
export type DeliveryMode = "auto" | "steer" | "follow_up";

/** Rendezvous budget for `replaceExtension` when the caller names none. */
const DEFAULT_REPLACE_TIMEOUT_MS = 30_000;
/** Session-store key holding the per-session extension params map (see `createSession({ params })`). */
const EXTENSION_PARAMS_STATE_KEY = "extensions:params";

export interface DeliveryOptions {
  readonly source: string;
  readonly actor?: string;
  readonly metadata?: Readonly<Record<string, ExternalOriginMetadataValue>>;
  /** auto: steer a running turn, or start an idle one. */
  readonly mode?: DeliveryMode;
}

export interface DeliveryReceipt {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly acceptedAt: number;
  readonly status: "started" | "queued";
  readonly channel: "turn" | SteerChannel;
  readonly steerId?: string;
  /** Present when delivery started an idle session. */
  readonly completion?: Promise<RunResult>;
}

export interface HarnessSessionStatus {
  readonly state: HarnessSessionState;
  readonly activeTurnId: string | null;
  readonly hasQueuedMessages: boolean;
}

export interface DefaultCapabilitiesOptions {
  /** Context window budget used to size compaction. Defaults to 200_000. */
  readonly maxContextTokens?: number;
  /** Workspace MCP servers. When set (or with `pluginManager`), an MCP capability is included. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /**
   * Installed-plugin manager. When set, the framework self-drives the plugin's contributions into
   * this capability set: its skills (merged into the skills capability), its MCP servers (merged
   * into the MCP capability), its shell hooks (merged into user-hooks), and its session-start skill
   * (rendered via a shared skill registry). Build capabilities fresh per session (a harness
   * capability factory) and load the manager first, so each session reflects the current plugin set
   * — read here at construction.
   */
  readonly pluginManager?: PluginManager;
  /**
   * Session shell hooks from config (`config.hooks`). Merged with plugin hooks when a
   * `pluginManager` is present (config first, then plugins). Wired as `userHooksCapability`.
   */
  readonly hooks?: readonly HookDef[];
  /**
   * OAuth service backing MCP servers that need it. Its credential store is the injection point:
   * a `JsonFileStore` locally, a `MemoryMcpCredentialStore` (hydrated from external storage) on a
   * server. Only consulted when an MCP capability is built.
   */
  readonly oauthService?: McpOAuthService;
}

/**
 * The standard coding-agent capability bundle (goal / plan / todo / skills /
 * cron / background / compaction). Filesystem access is NOT here — it is a tool
 * on the agent (`filesystemTools()`), not a capability; so is AskUserQuestion
 * (`askUserQuestionTool`, wired through ToolRunContext.responder).
 *
 * With `mcpServers` and/or `pluginManager`, an MCP capability is added; with `pluginManager`, the
 * plugin's skills/MCP/session-start are wired in too. Intended to be called fresh per session (via
 * a harness capability factory) so per-session state (goal/plan/todo/…) and the plugin set are
 * isolated per session, mirroring a fresh-Session-per-create model.
 */
export function defaultCapabilities(options: DefaultCapabilitiesOptions = {}): Capability[] {
  const manager = options.pluginManager;
  // Shared registry so the plugin session-start injector can render a skill the skills capability
  // loaded (its roots include the plugin skill dirs below).
  const registry = manager !== undefined ? new SkillRegistry() : undefined;
  // `includeDefaultRoots` because the plugin dirs ADD to the project/user `.agents/skills` roots —
  // without it, enabling a single skill-bearing plugin would hide every local skill.
  const skills =
    manager !== undefined
      ? skillsCapability({ registry, roots: manager.skillRoots(), includeDefaultRoots: true })
      : skillsCapability();
  const capabilities: Capability[] = [
    goalCapability(),
    workflowCapability(),
    planCapability(),
    taskCapability(),
    skills,
    backgroundCapability(),
    compactionCapability({ maxContextTokens: options.maxContextTokens ?? 200_000 }),
  ];
  // Cron is a local-only capability (Invariant 7): the server host doesn't install it.
  // MCP: workspace servers + enabled plugin servers (namespaced, so they can't collide).
  if (options.mcpServers !== undefined || manager !== undefined) {
    capabilities.push(
      mcpServersCapability(
        { ...(options.mcpServers ?? {}), ...(manager?.mcpServerConfigs() ?? {}) },
        options.oauthService !== undefined ? { oauthService: options.oauthService } : {},
      ),
    );
  }
  // Plugins: load the manager + render the plugin's session-start skill from the shared registry
  // (skills opens before this, so by injection time the registry holds the plugin skills).
  if (manager !== undefined && registry !== undefined) {
    capabilities.push(pluginsCapability(manager, (_pluginId, skillName) => registry.getSkill(skillName)?.content));
  }
  // Shell hooks: config first, then enabled plugin hooks (single HookEngine / SessionStart injector).
  const hookDefs: HookDef[] = [
    ...(options.hooks ?? []),
    ...(manager !== undefined ? manager.hookDefs() : []),
  ];
  if (hookDefs.length > 0) {
    capabilities.push(userHooksCapability(hookDefs));
  }
  return capabilities;
}

/**
 * The builtin subagents (`coder` / `explore` / `plan`) the `Agent` and `Workflow` tools spawn by
 * default. The profiles declare no model, so each subagent inherits the session's model; their tool
 * names resolve against the default agent's toolset (sharing read/write/edit/grep/glob/bash).
 */
function defaultSubagentProvider<TContext>(
  agentTools: readonly Tool[],
  resolveModel: HarnessOptions<TContext>["resolveModel"],
  extraProfiles: Record<string, ResolvedAgentProfile> = {},
): SubagentProvider<TContext> {
  const tools: Record<string, Tool> = {};
  for (const tool of agentTools) tools[tool.schema.name] = tool;
  // Deployment-supplied profiles (disk locally, external on a server) extend the builtin fleet;
  // the SOURCE differs by composition root, the wiring here does not.
  const profiles = { ...DEFAULT_AGENT_PROFILES, ...extraProfiles };
  const only = [...new Set([...DEFAULT_SUBAGENT_NAMES, ...Object.keys(extraProfiles)])];
  return profileSubagentProvider<TContext>(profiles, {
    only,
    tools,
    ...(resolveModel !== undefined ? { resolveModel } : {}),
  });
}

export interface HarnessOptions<TContext = unknown> {
  /** Model for the default agent. Either a constructed `ChatModel` or an id resolved via `resolveModel`. */
  readonly model: string | ChatModel;
  /** Resolve string model ids (needed only if `model`/agent models are strings). */
  readonly resolveModel?: (modelId: string) => ChatModel | Promise<ChatModel>;
  /**
   * The model registry backing `resolveModel`. Only needed to let extensions register or override
   * providers at runtime (`ctx.actions.registerProvider`). Harness-global by nature: one runtime
   * serves every session, so a registration is visible to all of them. Without it those two
   * actions throw and everything else works unchanged.
   */
  readonly modelRuntime?: ModelRuntime;
  /** Default working directory for new sessions. Defaults to `process.cwd()`. */
  readonly workDir?: string;
  /**
   * Cap on subagents running concurrently from one session's root frame. Defaults to the same
   * bound the `Workflow` tool uses, so a batch of `Agent` spawns cannot fan out further than a
   * workflow would. Nested spawns are exempt by design (they would deadlock a shared pool).
   */
  readonly maxConcurrentSubagents?: number;
  /**
   * Session repository (the fleet's store + index) — the harness's only storage knob. Injecting one
   * is how a deployment plugs in storage: `DiskSessionRepository(homeDir)` for local disk, Pg/Redis
   * on a server. Omit for in-memory sessions (`MemorySessionRepository`).
   */
  readonly repository?: SessionRepository;
  /** Event durability policy. Defaults to `immediate` for low-latency local applications.
   *  Managed servers override each opened session to `committed`. */
  readonly eventPublication?: EventPublicationMode;
  /**
   * Extra subagent profiles merged into the builtin `coder`/`explore`/`plan` fleet. The SOURCE is
   * the composition root's concern — disk (`loadAgentProfiles`) locally, external on a server —
   * but the merge/tool-wiring is identical. Ignored when `subagentProvider` is given.
   */
  readonly extraSubagentProfiles?: Record<string, ResolvedAgentProfile>;
  /**
   * The agent for new sessions. Provide a complete `Agent`, or omit it to run the builtin default
   * profile (`DEFAULT_AGENT_PROFILES.agent`) rendered as an agent — there is no piecemeal middle
   * ground. Per-session overrides go through `createSession({ agent })`.
   */
  readonly agent?: Agent<TContext>;
  /**
   * Default host application context for sessions. It is runtime-only: never serialized into
   * the log or SessionStore. Override per session with `createSession({ context })` or provide it
   * again when reopening a process with `resumeSession(id, { context })`.
   */
  readonly context?: TContext;
  /**
   * Process-level shared services, registered into the harness's `ServiceRegistry` at
   * construction. An extension consumes one by naming it in `uses` and receiving it as
   * `ctx.services[name]` -- a stable handle that resolves the current provider on every call,
   * which is what makes a host-side
   * `harness.services.replace()` land without touching any session. A plain value registers
   * as-is (not replaceable); wrap it as `{ instance, replaceable, dispose }` to opt into hot
   * swapping. Design: docs/architecture.md §5.5.
   */
  readonly services?: Record<string, unknown | ({ readonly instance: unknown } & ServiceOptions)>;
  /**
   * Opt-in to FILE extensions, both tiers, from this directory (one folder per extension).
   * The single explicit switch: without it no file-extension machinery exists ("default
   * closed"); with it, `harness.extensions` loads/reloads/unloads them — each load being the
   * manual approval. Extensions with a `create` half publish process-level services and may
   * embed a session half; see docs/architecture.md §5.4-5.5. (Unrelated to
   * `pluginManager`, the Codex-compatible skill/MCP plugin system.)
   */
  readonly extensionDir?: string;
  /**
   * Root of the per-extension data folders handed to `create` halves as `host.dataDir`
   * (`<root>/<id>`). Defaults to `<extensionDir>/.data` when `extensionDir` is set; by value
   * only, set it to give `create` halves a place for their files (absent ⇒ `dataDir` is
   * `undefined`). Kept outside the code folders so an update never touches state.
   */
  readonly extensionDataDir?: string;
  /**
   * Concrete tool palette the default profile's tool NAMES resolve against (and the subagent palette).
   * Defaults to `filesystemTools()` plus `askUserQuestionTool`; capability tools (goal/plan/todo/…) are
   * injected at runtime, so they need not appear here. Ignored when `agent` is given — a complete agent
   * carries its own tools.
   */
  readonly tools?: readonly Tool[];
  /**
   * Extra guidance appended to the default agent's system prompt (the profile's `roleAdditional` slot,
   * rendered after its own prompt). This LAYERS on the default profile — it does not replace it; for a
   * wholly different prompt, pass a complete `agent`. Ignored when `agent` is given.
   */
  readonly appendSystemPrompt?: string;
  /**
   * Subagent fleet the `Agent` / `Workflow` tools spawn by type. Defaults to the builtin
   * `coder` / `explore` / `plan` profiles (each inherits the session model; their tools resolve
   * against the default agent's toolset), so orchestration works out of the box. Pass your own
   * provider to override, or `null` to disable subagents entirely — which also hides the
   * Agent/Workflow tools, since there is nothing for them to spawn.
   */
  readonly subagentProvider?: SubagentProvider<TContext> | null;
  /**
   * Expose the builtin `Workflow` tool (default true).
   *
   * The narrow version of the switch above: use it when the host has its own
   * workflow orchestration and two overlapping tools would leave the model
   * guessing. Subagents and the `Agent` tool are unaffected — unlike
   * `subagentProvider: null`, which necessarily takes both tools with it.
   */
  readonly workflowTool?: boolean;
  /**
   * Machine for sessions — one shared `Machine` (the sandbox case), or a
   * {@link MachineFactory} for a per-session one. Defaults to a `LocalMachine`
   * rooted at each session's own `workDir`.
   */
  readonly machine?: Machine | MachineFactory;
  /**
   * Capabilities for sessions. Defaults to `defaultCapabilities()`. Pass a factory (sync or async)
   * to build a FRESH capability set per session — so per-session state (goal/plan/todo/background/
   * skills/mcp) is isolated and re-reads sources like a plugin manager each session. A plain array
   * is shared across the harness's sessions (fine only when state needn't be isolated).
   *
   * The factory receives the session it is being built for, so capabilities can be
   * scoped to it — see {@link SessionCapabilityContext}. Existing zero-argument
   * factories keep working unchanged.
   */
  readonly capabilities?:
    | readonly Capability[]
    | ((ctx: SessionCapabilityContext) => readonly Capability[] | Promise<readonly Capability[]>);
  /**
   * Programmatic runtime extensions, registered once here — the by-value twin of `extensionDir`.
   * Every definition's `setup` runs in every session; a session varies that with
   * `createSession({ params })` (a value configures, `false` skips). A definition with a
   * `create` half has it run here, once, and the result registered as a service under its `id`
   * before any session opens; `harness.close()` unregisters (and disposes) those services.
   * Each definition's `uses` is checked at this point, in order — a consumer comes after its
   * provider (or after `services`). Synchronous `create`s finish before `createHarness`
   * returns; an async one makes sessions wait for it, so `create` must not open a session of
   * its own. Intentionally independent from Codex-compatible plugins (`pluginManager`): those
   * are skills/MCP/hooks metadata, extensions are trusted host code.
   */
  readonly extensions?: readonly ExtensionDefinition[];
  /** Permission config. Defaults to `{ mode: "yolo" }`. */
  readonly permission?: PermissionManagerOptions;
  /**
   * Logger for loop diagnostics (LLM request/response, tool I/O, compaction). Defaults to the
   * `AGENTS_LOG` env var (`AGENTS_LOG=debug` builds a console logger); omit both to stay silent.
   */
  readonly logger?: Logger;
  /** Context budget for the default compaction capability. */
  readonly maxContextTokens?: number;
  readonly maxTurns?: number;
  readonly maxStepsPerTurn?: number;
}

/**
 * What a capability factory is told about the session it is building for.
 *
 * Exists so conversation-scoped resources don't force conversation-scoped harnesses.
 * MCP is the motivating case: a host that gives each conversation its own server
 * (a REPL kernel keyed by conversation id, say) used to need a whole separate
 * harness per conversation, duplicating the workspace's agent profile, tool palette,
 * plugins and skills along with it. Session-scoped servers keep the harness at
 * workspace scope, where it belongs — `mcpServers` here is the session-level
 * counterpart of the harness-level `DefaultCapabilitiesOptions.mcpServers`.
 */
export interface SessionCapabilityContext {
  readonly sessionId: string;
  readonly workDir: string;
  /** Session-scoped MCP servers, as given to createSession / resumeSession / forkSession. */
  readonly mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Options common to every way of opening a session.
 *
 * Beyond `agent` / `context`, these are per-session overrides of harness-level
 * defaults. They exist so one harness can serve sessions that differ in workspace,
 * persona or permission policy, instead of the host having to stand up a whole
 * harness per combination — which duplicates the agent profile, tool palette,
 * plugins, skills and MCP connections that have nothing to do with the difference.
 * Each one is already a session-level input inside the engine; the harness was
 * simply passing its own value straight through.
 */
interface OpenSessionOptionsBase<TContext = unknown> {
  /** Override the agent for this session only. */
  readonly agent?: Agent<TContext>;
  /** Override the execution machine for this session only. Lifecycle remains host-owned. */
  readonly machine?: Machine | MachineFactory;
  /** Runtime-only application context for this session. Overrides `HarnessOptions.context`. */
  readonly context?: TContext;
  /**
   * MCP servers scoped to this session, surfaced to the capability factory via
   * {@link SessionCapabilityContext}. Merge policy is the factory's call — the
   * harness only carries them across.
   */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /**
   * Per-session argument for each registered extension, by extension id — handed to that
   * extension's `setup(api, ctx)` as `ctx.params`. A value of `false` skips the extension for
   * this session entirely (its `setup` never runs). Persisted with the session, so a
   * `resumeSession` or a reload re-applies the same params without the caller repeating them.
   * This is the per-session knob: definitions themselves are registered once, on the harness.
   */
  readonly params?: Record<string, unknown>;
  /** Permission config for this session. Overrides `HarnessOptions.permission`. */
  readonly permission?: PermissionManagerOptions;
  /** Override this session's event durability policy. */
  readonly eventPublication?: EventPublicationMode;
  /**
   * Extra system-prompt text for this session's default agent. Overrides
   * `HarnessOptions.appendSystemPrompt`. Ignored when `agent` is given, since that
   * replaces the default agent outright.
   */
  readonly appendSystemPrompt?: string;
  /** Turn cap for this session's runs. Overrides `HarnessOptions.maxTurns`. */
  readonly maxTurns?: number;
  /**
   * Step-per-turn cap for this session. Overrides `HarnessOptions.maxStepsPerTurn`.
   * Carried on the session's default agent (the Runner reads the agent's value
   * first), so it is ignored when `agent` is given.
   */
  readonly maxStepsPerTurn?: number;
}

export interface CreateSessionOptions<TContext = unknown> extends OpenSessionOptionsBase<TContext> {
  readonly id?: string;
  readonly workDir?: string;
  /** Partition this session under an owner — see {@link CreateSessionInput.ownerKey}. */
  readonly ownerKey?: string;
  readonly title?: string;
}

export interface ResumeSessionOptions<TContext = unknown> extends OpenSessionOptionsBase<TContext> {}

export interface ForkSessionOptions<TContext = unknown> extends ResumeSessionOptions<TContext> {
  readonly id?: string;
  /** Defaults to the source session's key. */
  readonly ownerKey?: string;
  readonly title?: string;
}

/** A `Responder` whose approval/question handlers can be swapped at runtime (last-wins). */
class MutableResponder implements Responder {
  approvalHandler: ApprovalHandler | undefined;
  questionHandler: QuestionHandler | undefined;

  /** No handler ⇒ not a live approver ⇒ the run interrupts durably (resume later via
   *  `HarnessSession.resume`) instead of auto-rejecting the tool. */
  isLiveApprover(): boolean {
    return this.approvalHandler !== undefined;
  }

  async requestApproval(request: ApprovalRequest, options?: ApprovalRequestOptions): Promise<ApprovalResponse> {
    if (this.approvalHandler) return this.approvalHandler(request, options);
    return { decision: "rejected", feedback: "No approval handler registered on this session." };
  }

  async requestQuestion(request: QuestionRequest, options?: { readonly signal?: AbortSignal }): Promise<QuestionResult> {
    if (this.questionHandler) return this.questionHandler(request, options);
    return null;
  }
}

/**
 * Ergonomic per-session facade. Run-driving methods (`prompt`/`steer`/`followUp`/`cancel`/
 * `onEvent`/approval handlers) live here; everything else delegates to the core
 * `Session` (reachable via `.core` for anything not surfaced).
 */
export class HarnessSession<TContext = unknown> {
  readonly id: string;
  readonly workDir: string;
  /** The underlying core session — escape hatch for the full control plane. */
  readonly core: Session;
  /**
   * The session's event stream folded into state. The consumer split: `onEvent` serves
   * events-as-events (tracing, telemetry); the projection serves state — a late-joining
   * consumer calls `observeProjection()` and gets an exact history/live seam (no loss,
   * no duplicates, no dedup).
   * Attached before the session's first run — see docs/architecture.md §2.3.
   */
  readonly projection: SessionProjection;

  private readonly agent: Agent<TContext>;
  private readonly runner: Runner<TContext>;
  private readonly events: ListenerSink;
  private readonly responder: MutableResponder;
  private readonly onClosed: (id: string) => void;
  private runContext: TContext | undefined;
  private currentRun: AbortController | undefined;
  /** Barrier gate (docs/architecture.md §5.5): while set, no NEW run starts on this
   *  session — prompt/resume park at it, promptStream starts lazily behind it. The in-flight
   *  run is never touched. */
  private runGate: { readonly released: Promise<void>; release(): void } | undefined;
  /** Resolves when the latest run settles — the "arrived at the boundary" signal a barrier
   *  coordinator awaits. Undefined while idle. */
  private runSettled: Promise<void> | undefined;
  private readonly runSettles = new Map<AbortController, () => void>();
  private lastRunInterrupted = false;
  private closed = false;
  private deliveryCounter = 0;
  /** A wake is already scheduled on the microtask queue; more enqueues fold into it. */
  private wakeScheduled = false;
  /** Per-session turn cap; the Runner's own config is the fallback. */
  private readonly maxTurns: number | undefined;

  constructor(args: {
    core: Session;
    agent: Agent<TContext>;
    runner: Runner<TContext>;
    events: ListenerSink;
    responder: MutableResponder;
    projection: SessionProjection;
    workDir: string;
    context?: TContext;
    maxTurns?: number;
    interrupted?: boolean;
    onClosed: (id: string) => void;
  }) {
    this.core = args.core;
    this.id = args.core.id;
    this.projection = args.projection;
    this.workDir = args.workDir;
    this.agent = args.agent;
    this.runner = args.runner;
    this.events = args.events;
    this.responder = args.responder;
    this.runContext = args.context;
    this.maxTurns = args.maxTurns;
    this.lastRunInterrupted = args.interrupted ?? false;
    this.onClosed = args.onClosed;
    // Nothing drains a queue that fills while the session sits idle — the run loop's
    // turn-boundary drain only exists while a run is in flight. Without this, a background
    // task settling minutes after its spawning turn ended (the normal case: spawning to the
    // background is precisely how a turn stops waiting) would leave its result queued until
    // the user happened to prompt again.
    this.core.steer.setIdleWakeListener(() => this.scheduleIdleWake());
  }

  /**
   * Start a turn to consume queued follow-ups, once the current synchronous work is done.
   *
   * Deferred to a microtask for two reasons: several enqueues in one stack fold into a single
   * wake, and a settle that lands in a finishing run's own stack sees `currentRun` already
   * cleared. Re-checked at fire time because either can change in between — and re-checked
   * again after every run, since the queue may have filled during one whose drain had passed.
   */
  private scheduleIdleWake(): void {
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      if (this.closed || this.lastRunInterrupted) return;
      // Held at a barrier: stand down instead of parking a drain run at the gate (stacked
      // parked drains would race on release). `release()` re-schedules this wake.
      if (this.runGate !== undefined) return;
      // A run in flight drains at its own turn boundary; an interrupted one must be resumed,
      // not talked over.
      if (this.currentRun !== undefined) return;
      // Either channel counts. A "steering" item is an interruption of work in flight, but with
      // nothing in flight there is nothing to interrupt — it is simply the next input, and the
      // turn picks it up at the top of its first step (`runTurn`'s drain runs before the model
      // call), just as the follow-up queue is drained before the turn starts.
      if (!this.core.steer.hasItems()) return;
      // No input: the queue IS the prompt for this turn.
      void this.runPrompt([]).catch(() => undefined);
    });
  }

  /** Run options every run on this session carries — currently the session's turn cap. */
  private get runOverrides(): { maxTurns?: number } {
    return this.maxTurns !== undefined ? { maxTurns: this.maxTurns } : {};
  }

  /** Current runtime-only application context supplied to Agent callbacks. */
  get context(): TContext | undefined {
    return this.runContext;
  }

  get status(): HarnessSessionStatus {
    return {
      state: this.closed
        ? "closed"
        : this.currentRun !== undefined
          ? "running"
          : this.lastRunInterrupted
            ? "interrupted"
            : "idle",
      activeTurnId: this.core.steer.activeTurn,
      hasQueuedMessages: this.core.steer.hasItems(),
    };
  }

  /** Durable approvals / tool inputs awaiting answers, including after a reopen where the
   *  historical `turn.paused` event itself is no longer live in Projection. */
  async pendingInterruptions(): Promise<readonly PendingRunInterrupt[]> {
    const raw = await this.core.store?.getState(INTERRUPTION_STATE_KEY);
    if (raw === null || raw === undefined) return [];
    return flattenPendingInterrupts(parseInterruptionState(raw));
  }

  /** Replace the runtime-only context used by subsequent prompt/resume calls. */
  setContext(context: TContext | undefined): void {
    this.runContext = context;
  }

  // ── Run driving (the methods core Session does not have) ──

  private beginRun(controller: AbortController): void {
    this.currentRun = controller;
    this.runSettled = new Promise<void>((resolve) => {
      this.runSettles.set(controller, resolve);
    });
  }

  private endRun(controller: AbortController): void {
    if (this.currentRun === controller) this.currentRun = undefined;
    this.runSettles.get(controller)?.();
    this.runSettles.delete(controller);
  }

  /**
   * Barrier support (docs/architecture.md §5.5): refuse NEW runs until released and
   * report when this session reaches its run boundary. Installing the gate is synchronous — a
   * coordinator gates every affected session FIRST, then awaits quiescence, so the set of
   * running sessions only shrinks. The in-flight run (if any) is never signaled or aborted;
   * `quiescent` settles when it finishes on its own. `release` is idempotent and always safe —
   * a coordinator calls it in a finally so a failed barrier leaves nothing held.
   */
  holdAtBoundary(): { readonly quiescent: Promise<void>; release(): void } {
    let releaseGate!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gate = { released, release: releaseGate };
    this.runGate = gate;
    const quiescent = this.currentRun !== undefined ? (this.runSettled ?? Promise.resolve()) : Promise.resolve();
    return {
      quiescent,
      release: () => {
        if (this.runGate === gate) this.runGate = undefined;
        gate.release();
        // Anything queued while held drains on the normal idle-wake path.
        this.scheduleIdleWake();
      },
    };
  }

  /** Run a turn to completion. Serialized with other runs on this session. */
  async prompt(input: AgentInput): Promise<RunResult> {
    return this.runPrompt(input);
  }

  private async runPrompt(input: AgentInput, inputOrigin?: PromptOrigin): Promise<RunResult> {
    if (this.closed) throw new Error(`session "${this.id}" is closed`);
    // Barrier gate: park (never fail) until released. A loop, not an if — a new hold can land
    // between the release and this task resuming.
    while (this.runGate !== undefined) await this.runGate.released;
    const controller = new AbortController();
    this.beginRun(controller);
    try {
      const result = await this.runner.run(this.agent, input, {
        session: this.core,
        signal: controller.signal,
        context: this.runContext,
        ...(inputOrigin !== undefined ? { inputOrigin } : {}),
        ...this.runOverrides,
      });
      this.lastRunInterrupted = result.status === "interrupted";
      return result;
    } catch (error) {
      // Facade contract: a guardrail tripwire resolves as a terminal RunResult (the low-level
      // Runner still throws — OpenAI parity). Callers branch on `result.status`, no try/catch.
      if (isGuardrailTripwireError(error)) return this.guardrailBlocked(error);
      throw error;
    } finally {
      this.endRun(controller);
      // A follow-up can land after this run's last drain but before it settles — that enqueue
      // saw `currentRun` set and stood down, so the run itself has to look once on the way out.
      this.scheduleIdleWake();
    }
  }

  /**
   * Hand a message to the frame running at `address` in this session (`main` for the root agent,
   * `main/<agentId>` for a subagent); `false` when nobody is there. The seam an out-of-process
   * coordinator uses to address a specific subagent.
   */
  steerTo(address: string, content: string, origin: SteerOrigin): boolean {
    if (this.closed || this.lastRunInterrupted) return false;
    // A run in flight drains its own queues, so handing the message to the frame is enough.
    if (this.currentRun !== undefined) return this.core.steerTo(address, content, origin);
    // Idle: only the root frame can be woken. A subagent whose frame has ended is not a teammate
    // waiting for mail — it is a finished delegation, and only the parent that delegated it can
    // decide to continue it (`Agent(resume=...)`). Its store, capabilities, permissions and
    // lifetime are all the parent's; there is no independent agent here to start.
    if (address !== DEFAULT_ADDRESS) return false;
    // Queue it and let the idle-wake listener start the turn. Going through the bus (rather
    // than synthesizing a prompt here) is what gives the message a `steerId` on its journal
    // record, same as every other producer — the enqueue→consume trail stays unbroken.
    this.core.steer.steer(content, origin);
    return true;
  }

  /**
   * Deliver an externally-originated message. A running session receives it through the
   * requested SteerBus channel; an idle session starts a new turn immediately.
   *
   * ACCEPTANCE IS DURABLE BEFORE THIS RESOLVES. The input is journaled as `inbox.received`
   * and that write is awaited before a receipt exists, so the receipt means "this survives a
   * crash", not merely "this reached a process". Previously the message lived only in memory
   * (SteerBus, or an argument to `runPrompt`) until the run that consumed it journaled it —
   * a crash in that window lost a delivery the caller had already been told was accepted.
   *
   * The provenance of what the model ultimately sees is still persisted on the eventual
   * `message.appended` record: acceptance and processing are journaled separately because
   * they can legitimately differ (capability rewrite, guardrail rejection, or a capability
   * answering the prompt outright).
   */
  async deliver(input: string, options: DeliveryOptions): Promise<DeliveryReceipt> {
    if (this.closed) throw new Error(`session "${this.id}" is closed`);
    if (this.lastRunInterrupted && this.currentRun === undefined) {
      throw new Error(`session "${this.id}" is interrupted; resume it before delivering new work`);
    }
    if (!options.source.trim()) throw new Error("delivery source must not be empty");
    this.deliveryCounter += 1;
    const deliveryId = `delivery_${Date.now().toString(36)}_${this.deliveryCounter.toString(36)}`;
    const mode = options.mode ?? "auto";
    const channel: SteerChannel = mode === "follow_up" ? "follow_up" : "steering";
    const external = {
      kind: "external" as const,
      source: options.source,
      deliveryId,
      actor: options.actor,
      metadata: options.metadata,
      channel,
    };
    const acceptedAt = Date.now();

    // Durable acceptance, before anything is dispatched. A stored session gets its receipt from
    // this record (the store is publication-aware, so the append also produces the
    // `delivery.accepted` event); a storeless one has nothing to be durable about and emits the
    // event directly.
    if (this.core.store !== undefined) {
      await this.core.store.appendRecord({
        type: "inbox.received",
        time: acceptedAt,
        address: "main",
        input,
        origin: external,
        mode,
      });
    } else {
      void this.core.events.emit({
        type: "delivery.accepted",
        deliveryId,
        source: options.source,
        channel,
        address: "main",
        sessionId: this.id,
      });
    }

    return this.dispatchAccepted(input, external, acceptedAt);
  }

  /**
   * Dispatch an input whose acceptance is ALREADY journaled.
   *
   * A worker draining a session's inbox calls this directly: the `inbox.received` record exists,
   * so going back through `deliver` would write a second one and count the delivery twice. The
   * split is the whole reason acceptance and dispatch are separable — accepting is a durable
   * write that must happen before a receipt exists, dispatching is what someone holding the
   * session's lease does with it afterwards, possibly on another machine, possibly much later.
   *
   * Run state is read HERE, not at acceptance: by now a turn may have started or ended, so
   * whether this steers work in flight or starts a fresh turn can only be decided now.
   */
  dispatchAccepted(
    input: string,
    origin: SteerOrigin & { readonly kind: "external" },
    acceptedAt: number = Date.now(),
  ): DeliveryReceipt {
    if (this.closed) throw new Error(`session "${this.id}" is closed`);
    const deliveryId = origin.deliveryId;
    const channel: SteerChannel = origin.channel ?? "steering";

    if (this.currentRun !== undefined) {
      const receipt = this.core.steer.steer(input, origin);
      return {
        deliveryId,
        sessionId: this.id,
        acceptedAt,
        status: "queued",
        channel,
        steerId: receipt.steerId,
      };
    }

    const promptOrigin: PromptOrigin = {
      kind: "external",
      source: origin.source,
      deliveryId,
      ...(origin.actor !== undefined ? { actor: origin.actor } : {}),
      ...(origin.metadata !== undefined ? { metadata: origin.metadata } : {}),
    };
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: renderSteerText(origin, input) }],
      timestamp: acceptedAt,
    };
    const completion = this.runPrompt([message], promptOrigin);
    // Callers may only need acceptance. Keep a fire-and-observe delivery from becoming an
    // unhandled rejection; awaiting `completion` still receives the original rejection.
    completion.catch(() => undefined);
    return { deliveryId, sessionId: this.id, acceptedAt, status: "started", channel: "turn", completion };
  }

  /**
   * Resume a durably-interrupted run. When a `prompt` returns `status:"interrupted"` — which
   * happens when no live approval handler is registered (`no live responder ⇒ durable`) — the run's
   * interruption control tree was persisted to the session store. This loads it, applies the
   * caller's `answers` (prefer `approvalId`; a unique `toolCallId` is also accepted), and continues the
   * run to its next stop. Works across processes as long as the reopened session shares the same
   * durable store. Same guardrail-facade contract as `prompt` (a tripwire resolves as a terminal
   * `RunResult`, not a throw).
   *
   * An answer is either a bare `ApprovalResponse` (shorthand for the common approval case) or a
   * discriminated `InterruptAnswer` — pass `{ kind: "input", data }` to answer a durable input
   * suspension (`ctx.suspend`), which the approval-only shorthand cannot express.
   *
   * Recovery: if a previous resume threw mid-flight, the persisted state is left at
   * `phase: "recovery_required"` with its revision bumped. Calling this again handles it —
   * the state is re-read from the store here, so it is never stale — and continues from the
   * last durable pause. Only callers driving `Runner.resume` directly with a kept-around
   * copy see a "stale interruption state" error; re-fetching the persisted state clears it.
   */
  async resume(answers: Record<string, ApprovalResponse | InterruptAnswer>): Promise<RunResult> {
    // Barrier gate first (a coordinator holding the barrier should not be resumed against —
    // the call parks here until release rather than failing).
    while (this.runGate !== undefined) await this.runGate.released;
    if (this.currentRun !== undefined) throw new Error(`session "${this.id}" already has an active run`);
    const controller = new AbortController();
    // Set this BEFORE the first await (past the gate). A host returning 202 from resume can
    // immediately observe `running`, and a concurrent delivery joins this resumed turn instead
    // of seeing stale interrupted state while the control record is being read.
    this.beginRun(controller);
    try {
      const raw = await this.core.store?.getState(INTERRUPTION_STATE_KEY);
      if (raw === null || raw === undefined) {
        throw new Error("No interrupted run to resume on this session (no persisted interruption state).");
      }
      const interruption = parseInterruptionState(raw);
      // Bare ApprovalResponses (no `kind` field — the common case) are wrapped into the
      // discriminated InterruptAnswer shape; already-discriminated answers (including
      // `kind: "input"` for durable input suspensions) pass through untouched.
      const wrappedAnswers: Record<string, InterruptAnswer> = Object.fromEntries(
        Object.entries(answers).map(([id, answer]) => [
          id,
          isInterruptAnswer(answer) ? answer : { kind: "approval", ...answer },
        ]),
      );
      const result = await this.runner.resume(this.agent, { interruption, answers: wrappedAnswers }, {
        session: this.core,
        signal: controller.signal,
        context: this.runContext,
        ...this.runOverrides,
      });
      this.lastRunInterrupted = result.status === "interrupted";
      return result;
    } catch (error) {
      if (isGuardrailTripwireError(error)) return this.guardrailBlocked(error);
      throw error;
    } finally {
      this.endRun(controller);
    }
  }

  /** Streaming variant: iterate events, await `.completed` for the result. */
  promptStream(input: AgentInput): RunHandle<RunResult> {
    const controller = new AbortController();
    // Ungated: start synchronously, byte-identical to the pre-barrier behavior. Gated: the
    // handle returns immediately but the underlying run starts only after release (lazy start —
    // promptStream has no callers that depend on first-event timing).
    const gated = this.runGate !== undefined;
    if (!gated) this.beginRun(controller);
    const start = (async () => {
      if (gated) {
        while (this.runGate !== undefined) await this.runGate.released;
        this.beginRun(controller);
      }
      return this.runner.runStream(this.agent, input, {
        session: this.core,
        signal: controller.signal,
        context: this.runContext,
        ...this.runOverrides,
      });
    })();
    // Same facade contract as `prompt`: `completed` resolves with a "guardrail_blocked" result
    // instead of rejecting. Events (including the `guardrail.blocked` frame) stream through the
    // original handle unchanged.
    const completed = start
      .then((handle) => handle.completed)
      .then((result) => {
        this.lastRunInterrupted = result.status === "interrupted";
        return result;
      })
      .catch((error) => {
        if (isGuardrailTripwireError(error)) return this.guardrailBlocked(error);
        throw error;
      })
      .finally(() => {
        this.endRun(controller);
      });
    // Guard the floating promise so iterate-only callers don't trip an unhandled rejection
    // (mirrors runStream's own internal guard); awaiters still receive a real rejection.
    completed.catch(() => undefined);
    const iterate = async function* (): AsyncGenerator<AgentEvent> {
      const handle = await start;
      for await (const event of handle) yield event;
    };
    return {
      [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
      completed,
    };
  }

  /** Synthesize the terminal RunResult for a guardrail tripwire (facade contract). */
  private guardrailBlocked(error: GuardrailTripwireError): RunResult {
    // Terminal, like any other completed result: without this, a tripwire during resume()
    // would leave the flag stuck true (the success path at the call sites never runs) and
    // wedge the session in "interrupted" with its durable state already consumed.
    this.lastRunInterrupted = false;
    return {
      status: "guardrail_blocked",
      finalAgent: error.agentName ?? this.agent.name,
      activeAddress: error.address ?? this.core.conversationHead()?.address ?? "main",
      output: "",
      messages: [],
      usage: emptyUsage(),
      guardrail: {
        stage: error.stage,
        guardrail: error.guardrailName,
        ...(error.agentName !== undefined ? { agent: error.agentName } : {}),
      },
    };
  }

  /**
   * Inject a user message into the in-flight (or next) turn. Returns the steer's correlation
   * id: a `steer.queued` event carries it now, and the consuming `message.appended` event's
   * `origin.steerId` matches it when the model actually sees the message.
   */
  steer(input: string): string {
    return this.core.steer.steer(input, { kind: "user" }).steerId;
  }

  /**
   * Queue a user message for a new turn after the current run's active turn finishes.
   * Returns the steer's correlation id (see `steer`), or null when the session has no
   * active run — use `prompt` instead in that case.
   */
  followUp(input: string): string | null {
    if (this.currentRun === undefined) return null;
    return this.core.steer.followUp(input).steerId;
  }

  /** Abort the current run. */
  cancel(): void {
    this.currentRun?.abort();
  }

  /** Subscribe to this session's event stream. Returns an unsubscribe fn. */
  onEvent(listener: AgentEventListener): () => void {
    return this.events.subscribe(listener);
  }

  // ── Projection (state-shaped consumers; see the `projection` field doc) ──

  /** Current folded state. Consumers that also need subsequent events should use
   *  `observeProjection()` for an atomic history/live seam. */
  snapshot(options?: SnapshotOptions): SessionSnapshot {
    return this.projection.snapshot(options);
  }

  /** Post-apply event feed: every delivered event's effect is already in `snapshot()`.
   *  Listeners must be synchronous — backpressure belongs to the transport. */
  subscribeProjection(listener: ProjectionListener): () => void {
    return this.projection.subscribe(listener);
  }

  /** Atomically subscribe to post-fold AgentEvents and capture the authoritative state at
   *  that boundary. Prefer this over coordinating `snapshot()` and `subscribeProjection()`
   *  manually in transports and UIs. */
  observeProjection(listener: ProjectionListener, options?: SnapshotOptions): ProjectionObservation {
    return this.projection.observe(listener, options);
  }

  /** Lightweight per-address summary (which agents exist, who is live/running). */
  directory(): DirectoryEntry[] {
    return this.projection.directory();
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.responder.approvalHandler = handler;
  }

  setQuestionHandler(handler: QuestionHandler | undefined): void {
    this.responder.questionHandler = handler;
  }

  // ── Control plane (delegated to core Session) ──

  setModel(model: string | ChatModel): void {
    this.core.setModel(model);
  }
  setThinking(level: ThinkingLevel): void {
    this.core.setThinking(level);
  }
  /** In-memory switch is immediate; await the returned promise to confirm it was journaled. */
  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.core.setPermissionMode(mode);
  }

  createGoal(...args: Parameters<Session["createGoal"]>): ReturnType<Session["createGoal"]> {
    return this.core.createGoal(...args);
  }
  getGoal(): ReturnType<Session["getGoal"]> {
    return this.core.getGoal();
  }
  setPlanMode(...args: Parameters<Session["setPlanMode"]>): ReturnType<Session["setPlanMode"]> {
    return this.core.setPlanMode(...args);
  }
  getPlan(): ReturnType<Session["getPlan"]> {
    return this.core.getPlan();
  }
  compact(...args: Parameters<Session["compact"]>): ReturnType<Session["compact"]> {
    return this.core.compact(...args);
  }
  listSkills(): ReturnType<Session["listSkills"]> {
    return this.core.listSkills();
  }
  activateSkill(...args: Parameters<Session["activateSkill"]>): ReturnType<Session["activateSkill"]> {
    return (this.core.activateSkill as (...a: unknown[]) => ReturnType<Session["activateSkill"]>)(...args);
  }
  listPlugins(): ReturnType<Session["listPlugins"]> {
    return this.core.listPlugins();
  }
  installPlugin(...args: Parameters<Session["installPlugin"]>): ReturnType<Session["installPlugin"]> {
    return this.core.installPlugin(...args);
  }
  listBackgroundTasks(...args: Parameters<Session["listBackgroundTasks"]>): ReturnType<Session["listBackgroundTasks"]> {
    return this.core.listBackgroundTasks(...args);
  }
  // ── Conversation log (flat, linear) — read the record stream for transcript rendering ──
  getRecords(...args: Parameters<Session["getRecords"]>): ReturnType<Session["getRecords"]> {
    return this.core.getRecords(...args);
  }
  listSubagents(...args: Parameters<Session["listSubagents"]>): ReturnType<Session["listSubagents"]> {
    return this.core.listSubagents(...args);
  }
  reconcileSubagents(...args: Parameters<Session["reconcileSubagents"]>): ReturnType<Session["reconcileSubagents"]> {
    return this.core.reconcileSubagents(...args);
  }

  // ── context introspection — where the model's window is spent, as of the last turn ──
  getContextBreakdown(): ReturnType<Session["getContextBreakdown"]> {
    return this.core.getContextBreakdown();
  }

  // ── extensions — hot attach/detach on the live session (host API; never a model tool) ──
  /**
   * Add an extension mid-session. Applied at the next quiet point: immediately when idle,
   * at the run's stop boundary when one is in flight — its tools appear at the next run's
   * assembly. The change is journaled; it does NOT survive `resumeSession` (re-attach, or
   * register it in `createHarness({ extensions })`, which every open re-evaluates). A definition
   * with a `create` half is accepted only once registered — its service must already exist.
   */
  attachExtension(definition: ExtensionDefinition): Promise<void> {
    return this.extensionRuntime().attach(definition);
  }
  /** Remove an extension mid-session: `session.end("detach")` fires, then its scope unwinds. */
  detachExtension(extensionId: string): Promise<void> {
    return this.extensionRuntime().detach(extensionId);
  }
  /** Ids of currently attached extensions; empty when the session has no extensions capability. */
  attachedExtensionIds(): readonly string[] {
    try {
      return this.extensionRuntime().attachedIds();
    } catch {
      return [];
    }
  }
  /** Currently attached extensions with what each `uses`; empty without an extensions capability. */
  attachedExtensions(): readonly { readonly id: string; readonly uses: readonly string[] }[] {
    try {
      return this.extensionRuntime().attachedExtensions();
    } catch {
      return [];
    }
  }
  /** Run a slash command against this session: the static registry plus capability-contributed
   *  dynamic commands (extensions' `registerCommand`). Commands are the SERIALIZABLE control
   *  surface — what an out-of-process host (app-server RPC) uses where an in-process host
   *  reaches `extensionHandle()`. */
  runCommand(input: string): Promise<CommandResult> {
    return sharedCommands().run(input, { session: this.core });
  }
  /** The control surface an extension published via `api.expose`; undefined when the extension
   *  is absent, detached, or exposed nothing. The generic replacement for per-feature session
   *  facade methods (e.g. cron's — see `cronExtension`). */
  extensionHandle<T = unknown>(extensionId: string): T | undefined {
    try {
      return this.extensionRuntime().exposedHandle<T>(extensionId);
    } catch {
      return undefined;
    }
  }
  private extensionRuntime(): ExtensionRuntime {
    const runtime = this.core.service<ExtensionRuntime>("extensions");
    if (!runtime) throw new Error("this session has no extensions capability");
    return runtime;
  }

  // ── goal lifecycle ──
  pauseGoal(...args: Parameters<Session["pauseGoal"]>): ReturnType<Session["pauseGoal"]> {
    return this.core.pauseGoal(...args);
  }
  resumeGoal(...args: Parameters<Session["resumeGoal"]>): ReturnType<Session["resumeGoal"]> {
    return this.core.resumeGoal(...args);
  }
  cancelGoal(...args: Parameters<Session["cancelGoal"]>): ReturnType<Session["cancelGoal"]> {
    return this.core.cancelGoal(...args);
  }
  setGoalBudget(...args: Parameters<Session["setGoalBudget"]>): ReturnType<Session["setGoalBudget"]> {
    return this.core.setGoalBudget(...args);
  }

  // ── plan + compaction ──
  clearPlan(...args: Parameters<Session["clearPlan"]>): ReturnType<Session["clearPlan"]> {
    return this.core.clearPlan(...args);
  }
  pendingCompaction(...args: Parameters<Session["pendingCompaction"]>): ReturnType<Session["pendingCompaction"]> {
    return this.core.pendingCompaction(...args);
  }
  cancelCompaction(...args: Parameters<Session["cancelCompaction"]>): ReturnType<Session["cancelCompaction"]> {
    return this.core.cancelCompaction(...args);
  }

  // ── background tasks ──
  readBackgroundTaskOutput(...args: Parameters<Session["readBackgroundTaskOutput"]>): ReturnType<Session["readBackgroundTaskOutput"]> {
    return this.core.readBackgroundTaskOutput(...args);
  }
  readBackgroundTaskOutputDelta(...args: Parameters<Session["readBackgroundTaskOutputDelta"]>): ReturnType<Session["readBackgroundTaskOutputDelta"]> {
    return this.core.readBackgroundTaskOutputDelta(...args);
  }
  stopBackgroundTask(...args: Parameters<Session["stopBackgroundTask"]>): ReturnType<Session["stopBackgroundTask"]> {
    return this.core.stopBackgroundTask(...args);
  }
  /** Move a running detachable tool call (bash/subagent/workflow) into a background task. */
  detachTool(...args: Parameters<Session["detachTool"]>): ReturnType<Session["detachTool"]> {
    return this.core.detachTool(...args);
  }

  // ── plugins (full lifecycle) ──
  getPluginInfo(...args: Parameters<Session["getPluginInfo"]>): ReturnType<Session["getPluginInfo"]> {
    return this.core.getPluginInfo(...args);
  }
  setPluginEnabled(...args: Parameters<Session["setPluginEnabled"]>): ReturnType<Session["setPluginEnabled"]> {
    return this.core.setPluginEnabled(...args);
  }
  setPluginMcpServerEnabled(...args: Parameters<Session["setPluginMcpServerEnabled"]>): ReturnType<Session["setPluginMcpServerEnabled"]> {
    return this.core.setPluginMcpServerEnabled(...args);
  }
  removePlugin(...args: Parameters<Session["removePlugin"]>): ReturnType<Session["removePlugin"]> {
    return this.core.removePlugin(...args);
  }
  reloadPlugins(...args: Parameters<Session["reloadPlugins"]>): ReturnType<Session["reloadPlugins"]> {
    return this.core.reloadPlugins(...args);
  }

  // ── MCP ──
  listMcpServers(...args: Parameters<Session["listMcpServers"]>): ReturnType<Session["listMcpServers"]> {
    return this.core.listMcpServers(...args);
  }
  reconnectMcpServer(...args: Parameters<Session["reconnectMcpServer"]>): ReturnType<Session["reconnectMcpServer"]> {
    return this.core.reconnectMcpServer(...args);
  }

  /** Close the session and release its resources. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.projection.detach();
    await this.core.close();
    this.onClosed(this.id);
  }
}

/** Manages a fleet of in-process sessions over a shared engine config. */
export class Harness<TContext = unknown> {
  private readonly options: HarnessOptions<TContext>;
  private readonly runner: Runner<TContext>;
  private readonly repo: SessionRepository;
  /** Concrete tools the default profile's tool NAMES resolve against (keyed by schema name). */
  private readonly toolPalette: Readonly<Record<string, Tool>>;
  private readonly activeSessions = new Map<string, HarnessSession<TContext>>();

  /** Process-level shared services. The host replaces providers here (`services.replace`);
   *  sessions only ever see handles (`ctx.shared`, `ctx.services`). */
  readonly services = new ServiceRegistry();
  /** The one in-flight reshape barrier (mutex: a second barrier operation rejects). Sessions
   *  appearing while it holds are gated at birth — see the tail of `openFromStore`. */
  private activeBarrier: { readonly holds: Map<string, { readonly quiescent: Promise<void>; release(): void }> } | undefined;
  /** File-extension manager (both tiers) — present only when the host opted in with
   *  `extensionDir`. NOT the Codex-compatible skill/MCP plugin system (`pluginManager`). */
  readonly extensions: HarnessExtensionManager | undefined;
  /** Service ids published by by-value `create` halves, in creation order — unregistered (and
   *  disposed) by `close()`, newest first. */
  private readonly createdServices: string[] = [];
  /** The by-value definitions this harness currently mounts into newborn sessions, in
   *  registration order. Seeded from `createHarness({ extensions })` and rewritten in place by
   *  `replaceExtension`, so a swap reaches sessions born after it — reading `options.extensions`
   *  directly would hand new sessions the OLD code, which is exactly the skew the barrier exists
   *  to prevent. */
  private readonly valueDefs = new Map<string, ExtensionDefinition>();
  /** Root of extensions' data folders (`host.dataDir` = `<root>/<id>`); absent ⇒ none handed out. */
  private readonly dataRoot: string | undefined;
  /** Settles once every by-value `create` half has published its service; sessions open after it. */
  private readonly sharedReady: Promise<void>;
  /** The extension whose `create` is running right now — its `createSession` must refuse. */
  private runningCreate: string | undefined;

  constructor(options: HarnessOptions<TContext>) {
    this.options = options;
    const agentTools = options.tools ?? [...filesystemTools(), askUserQuestionTool];
    this.toolPalette = Object.fromEntries(agentTools.map((tool) => [tool.schema.name, tool]));
    // The Agent/Workflow tools only appear when the run has subagents to spawn. Default the fleet
    // to the builtin coder/explore/plan profiles so orchestration works out of the box; an explicit
    // provider overrides it, and `null` opts out (hiding those tools).
    const subagentProvider =
      options.subagentProvider === null
        ? undefined
        : options.subagentProvider ?? defaultSubagentProvider<TContext>(agentTools, options.resolveModel, options.extraSubagentProfiles);
    this.runner = new Runner<TContext>({
      resolveModel: options.resolveModel,
      subagentProvider,
      ...(options.workflowTool !== undefined ? { workflowTool: options.workflowTool } : {}),
      maxTurns: options.maxTurns,
      maxStepsPerTurn: options.maxStepsPerTurn,
      ...(options.maxConcurrentSubagents !== undefined ? { maxConcurrentSubagents: options.maxConcurrentSubagents } : {}),
    });
    // Injected repository (disk locally, Pg/Redis on a server); in-memory when omitted.
    this.repo = options.repository ?? new MemorySessionRepository();
    this.dataRoot = options.extensionDataDir ?? (options.extensionDir !== undefined ? join(options.extensionDir, ".data") : undefined);
    this.extensions = options.extensionDir === undefined
      ? undefined
      : new HarnessExtensionManager({
          directory: options.extensionDir,
          dataDir: this.dataRoot ?? join(options.extensionDir, ".data"),
          bridge: {
            services: this.services,
            createSession: (sessionOptions) => this.createSession(sessionOptions as CreateSessionOptions<TContext>),
            sessions: () => [...this.activeSessions.values()],
            withBarrier: (extensionIds, timeoutMs, fn) => this.withBarrier(extensionIds, timeoutMs, fn),
            warn: (message) => console.warn(`[extensions] ${message}`),
          },
        });
    for (const [name, value] of Object.entries(options.services ?? {})) {
      // A plain object carrying an `instance` key is read as a registration descriptor;
      // anything else registers as the service itself (methods-only, not replaceable).
      if (isServiceDescriptor(value)) {
        const { instance, ...serviceOptions } = value;
        this.services.register(name, instance, serviceOptions);
      } else {
        this.services.register(name, value);
      }
    }
    for (const definition of options.extensions ?? []) {
      if (this.valueDefs.has(definition.id)) throw new Error(`duplicate by-value extension id "${definition.id}" in createHarness({ extensions })`);
      this.valueDefs.set(definition.id, definition);
    }
    this.sharedReady = this.registerDefinitions(options.extensions);
    // Surfaced to whoever opens a session; never an unhandled rejection on its own.
    this.sharedReady.catch(() => undefined);
  }

  /**
   * Run one by-value definition's `create` half against a staging host: the service is COLLECTED,
   * not registered, so a throwing `create` publishes nothing. Stays synchronous when `create` is
   * — what lets a synchronous extension's service exist the moment `createHarness` returns.
   * Shared by construction and `replaceExtension`.
   */
  private stageValue(definition: ExtensionDefinition): StagedDefinition | Promise<StagedDefinition> {
    // The data folder exists before `create` runs (synchronously: `create` may be too).
    const dataDir = this.dataRoot !== undefined ? join(this.dataRoot, definition.id) : undefined;
    if (dataDir !== undefined) mkdirSync(dataDir, { recursive: true });
    this.runningCreate = definition.id;
    const done = (staged: StagedDefinition): StagedDefinition => {
      this.runningCreate = undefined;
      return staged;
    };
    const failed = (error: unknown): never => {
      this.runningCreate = undefined;
      throw error;
    };
    try {
      const staged = stageDefinition(definition, {
        defaultReplaceable: false,
        ...(dataDir !== undefined ? { dataDir } : {}),
        createSession: (sessionOptions) => {
          if (this.runningCreate !== undefined) {
            return Promise.reject(
              new Error(`extension "${this.runningCreate}": createSession is not available inside create() — open sessions later, from setup, a tool, or an event`),
            );
          }
          return this.createSession(sessionOptions as CreateSessionOptions<TContext>);
        },
        warn: (message) => console.warn(`[extensions] ${message}`),
      });
      return staged instanceof Promise ? staged.then(done, failed) : done(staged);
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * Register the by-value definitions, in order: check each one's `uses` against the registry
   * (a consumer must come after its provider), then run its `create` half if it has one and
   * register the result as a service under the extension's `id`. Stays synchronous as long as
   * every `create` is — so `createHarness` returns with a synchronous extension's service
   * already registered; the first async `create` turns the rest of the sequence into a promise
   * chain that `openFromStore` awaits. Staging (`stageDefinition`) collects before registering,
   * so a throwing `create` publishes nothing.
   */
  private registerDefinitions(extensions: readonly ExtensionDefinition[] | undefined): Promise<void> {
    if (extensions === undefined) return Promise.resolve();
    const run = (definition: ExtensionDefinition): void | Promise<void> => {
      for (const name of definition.uses ?? []) {
        if (!this.services.has(name)) {
          throw new Error(`extension "${definition.id}" uses service "${name}", which is not registered — list its provider earlier in createHarness({ extensions }) (or register it in services)`);
        }
      }
      if (definition.create === undefined) return;
      const staged = this.stageValue(definition);
      const publish = (result: StagedDefinition): void => {
        if (result.service !== undefined) {
          this.services.register(result.service.name, result.service.instance, result.service.options);
          this.createdServices.push(result.service.name);
        }
      };
      if (staged instanceof Promise) return staged.then(publish);
      publish(staged);
    };
    let chain: Promise<void> | undefined;
    for (const definition of extensions) {
      if (chain === undefined) {
        const result = run(definition);
        if (result !== undefined) chain = result;
      } else {
        chain = chain.then(() => run(definition));
      }
    }
    return chain ?? Promise.resolve();
  }

  /**
   * The default agent for sessions with no explicit `agent`: the builtin `agent` profile rendered as
   * an Agent — its tool names resolved against {@link toolPalette}, its model forced to `options.model`
   * (the profile declares none). Capability tools (goal/plan/todo/…) still join at runtime via the
   * session's capabilities.
   *
   * Built fresh per session. Runtime-specific prompt data is not captured here: `instructions`
   * resolves the current frame's machine + cwd through the Session cache, so root/subagent/worktree
   * prompts stay isolated without coupling Agent lifetime to machine lifetime.
   */
  private buildDefaultAgent(appendSystemPrompt?: string, maxStepsPerTurn?: number): Promise<Agent<TContext>> {
    const additional = appendSystemPrompt ?? this.options.appendSystemPrompt;
    const steps = maxStepsPerTurn ?? this.options.maxStepsPerTurn;
    return buildAgentFromProfile<TContext>(DEFAULT_AGENT_PROFILES[DEFAULT_AGENT_PROFILE_NAME]!, {
      tools: this.toolPalette,
      model: this.options.model,
      ...(additional !== undefined ? { roleAdditional: additional } : {}),
      ...(steps !== undefined ? { maxStepsPerTurn: steps } : {}),
      ...(this.options.resolveModel !== undefined ? { resolveModel: this.options.resolveModel } : {}),
    });
  }

  get sessions(): ReadonlyMap<string, HarnessSession<TContext>> {
    return this.activeSessions;
  }

  async createSession(opts: CreateSessionOptions<TContext> = {}): Promise<HarnessSession<TContext>> {
    const workDir = opts.workDir ?? this.options.workDir ?? process.cwd();
    const handle = await this.repo.create({ id: opts.id, workDir, ownerKey: opts.ownerKey, title: opts.title });
    return this.openFromStore(handle.id, handle.workDir, handle.store, opts);
  }

  async resumeSession(id: string, opts: ResumeSessionOptions<TContext> = {}): Promise<HarnessSession<TContext>> {
    const existing = this.activeSessions.get(id);
    if (existing) {
      if (hasOwnContext(opts)) existing.setContext(opts.context);
      return existing;
    }
    const handle = await this.repo.open(id);
    if (handle === undefined) throw new SessionRepositoryNotFoundError(id);
    const session = await this.openFromStore(handle.id, handle.workDir, handle.store, opts);
    // Reopening: orphaned background subagents (running from a dead process) → lost.
    await session.reconcileSubagents();
    return session;
  }

  /** Fork an existing session into a new one (copies its log + state) and open it. */
  async forkSession(
    sourceId: string,
    opts: ForkSessionOptions<TContext> = {},
  ): Promise<HarnessSession<TContext>> {
    const handle = await this.repo.fork(sourceId, {
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(opts.ownerKey !== undefined ? { ownerKey: opts.ownerKey } : {}),
      ...(opts.title !== undefined ? { title: opts.title } : {}),
    });
    const session = await this.openFromStore(handle.id, handle.workDir, handle.store, opts);
    // A fork copies the subagent ledger; its background "running" rows have no live task → lost.
    await session.reconcileSubagents();
    return session;
  }

  /** The currently-open session with this id, or undefined (does not reopen — use resumeSession). */
  getSession(id: string): HarnessSession<TContext> | undefined {
    return this.activeSessions.get(id);
  }

  /** Read a session's durable handle without constructing a Session, opening capabilities,
   *  reconciling background tasks, or subscribing Projection. Intended for read-only servers.
   *  Soft-deleted sessions resolve only with `{ includeDeleted: true }` — audit/purge tooling. */
  inspectSession(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined> {
    return this.repo.open(id, options);
  }

  /** Read one catalog row without the O(N) `listSessions()` scan. */
  getSessionSummary(id: string): Promise<SessionSummary | undefined> {
    return this.repo.get(id);
  }

  /** Close one open session by id (no-op if it isn't open). */
  async closeSession(id: string): Promise<void> {
    await this.activeSessions.get(id)?.close();
  }

  /**
   * Delete a session after releasing any open in-process handle. Soft by default — the durable
   * record is retained and `resumeSession` stops resolving it. `{ purge: true }` destroys it.
   */
  async deleteSession(id: string, options?: DeleteSessionOptions): Promise<void> {
    await this.closeSession(id);
    await this.repo.delete(id, options);
  }

  /** Undo a soft delete. No-op when the session is absent or was never deleted. */
  restoreSession(id: string): Promise<void> {
    return this.repo.restore(id);
  }

  async listSessions(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]> {
    return this.repo.list(filter);
  }

  async close(): Promise<void> {
    for (const session of [...this.activeSessions.values()]) await session.close();
    // By-value `create` halves die with the harness that ran them: unregister each service,
    // newest first, which drains it and runs its dispose hook (default: the instance's close()).
    await this.sharedReady.catch(() => undefined);
    for (const name of [...this.createdServices].reverse()) await this.services.unregister(name);
    this.createdServices.length = 0;
  }

  /**
   * Replace by-value extensions with new versions, as one coordinated act — the by-value twin of
   * `harness.extensions.reload()` (docs/architecture.md §5.5). Every session holding
   * one of them rendezvous at its run boundary (in-flight runs finish untouched — nothing is
   * aborted); in that global quiet moment the old halves detach, each `create` half re-runs and
   * its service is swapped, and the new halves attach; then everyone resumes. Sessions born from
   * the quiet moment on are born with the new definitions. On rendezvous timeout NOTHING changes:
   * the barrier lifts, `BarrierTimeout` names the stuck sessions, and the caller retries later
   * (or closes the straggler).
   *
   * Pass EVERY definition a shape change affects in ONE call — the provider and the consumers
   * written against it — so they cross the barrier together; a consumer left out resumes against
   * the new shape running old code, which is the skew this whole mechanism exists to prevent.
   *
   * `services` swaps HOST-registered services (`createHarness({ services })`) in the same quiet
   * moment, for when the shape that changed is the host's rather than an extension's. Those obey
   * their `replaceable` flag; an extension's own `create` service swaps unconditionally, since
   * its owner is being replaced along with it.
   *
   * Implementation-only swaps need none of this — `harness.services.replace` (layer 1) lands on
   * the next call and touches no session at all.
   */
  async replaceExtension(
    next: ExtensionDefinition | readonly ExtensionDefinition[],
    options: {
      /** Host-registered services to swap in the same quiet moment, by name. */
      readonly services?: Readonly<Record<string, unknown>>;
      /** Rendezvous budget; on expiry the replace fails and nothing changed. Default 30s. */
      readonly timeoutMs?: number;
      readonly drainTimeoutMs?: number;
    } = {},
  ): Promise<void> {
    const definitions = Array.isArray(next) ? [...(next as readonly ExtensionDefinition[])] : [next as ExtensionDefinition];
    if (definitions.length === 0) {
      throw new Error("replaceExtension needs at least one definition — to swap a service alone, use harness.services.replace");
    }
    for (const definition of definitions) {
      if (!this.valueDefs.has(definition.id)) {
        throw new Error(
          `cannot replace extension "${definition.id}": it is not registered on this harness by value — pass it in createHarness({ extensions }), or use harness.extensions.reload("${definition.id}") for a file extension`,
        );
      }
    }
    // A `create` half still publishing would race the swap.
    await this.sharedReady;
    // Every new `create` runs BEFORE the barrier: staging COLLECTS, so one that throws leaves the
    // world completely untouched (no session detached, no service swapped) — the same discipline
    // construction and the file manager use. Whatever a failed act staged is disposed below.
    const staged = new Map<string, StagedDefinition>();
    for (const definition of definitions) {
      if (definition.create !== undefined) staged.set(definition.id, await this.stageValue(definition));
    }
    const published = new Set<string>();
    const ids = definitions.map((definition) => definition.id);
    try {
      await this.withBarrier(ids, options.timeoutMs ?? DEFAULT_REPLACE_TIMEOUT_MS, async (held) => {
        // Globally quiet. These two statements are ONE synchronous act: from here on newborn
        // sessions are born with the new definitions, and `targets` is exactly the set still
        // holding an old one — so nobody is swapped twice and nobody is missed.
        const targets = held()
          .map((session) => ({ session, held: ids.filter((id) => session.attachedExtensionIds().includes(id)) }))
          .filter((target) => target.held.length > 0);
        for (const definition of definitions) this.valueDefs.set(definition.id, definition);

        // Old halves out first: their `session.end` runs against the old shape.
        for (const target of targets) {
          for (const id of target.held) await target.session.detachExtension(id);
        }
        for (const [name, instance] of Object.entries(options.services ?? {})) {
          await this.services.replace(name, instance, options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {});
        }
        for (const definition of definitions) {
          await this.publishValueService(definition, staged.get(definition.id), options.drainTimeoutMs);
          published.add(definition.id);
        }
        // New halves in: their `session.start` runs against the new shape. The pending queue
        // applies immediately on idle sessions.
        for (const target of targets) {
          if (!this.activeSessions.has(target.session.id)) continue; // closed while the barrier held
          for (const id of target.held) await target.session.attachExtension(this.valueDefs.get(id)!);
        }
      });
    } catch (error) {
      // Rendezvous timed out, or a step failed: nothing staged was published, so dispose it —
      // a `create` that opened a pool must not leak it because the barrier never converged.
      for (const [id, entry] of staged) {
        if (!published.has(id) && entry.service !== undefined) await this.disposeStaged(id, entry.service.instance);
      }
      throw error;
    }
  }

  /**
   * The service half of one replaced extension: publish what its `create` staged. `replace`
   * rather than unregister + register, so consumers this barrier never gated — other extensions
   * holding a `uses` handle — see no gap; `force` because the owner is being replaced along with
   * it (see `ServiceRegistry.replace`).
   */
  private async publishValueService(
    definition: ExtensionDefinition,
    staged: StagedDefinition | undefined,
    drainTimeoutMs?: number,
  ): Promise<void> {
    const id = definition.id;
    const previous = this.createdServices.indexOf(id);
    const drain = drainTimeoutMs !== undefined ? { drainTimeoutMs } : {};
    if (staged?.service !== undefined) {
      if (previous >= 0) {
        await this.services.replace(id, staged.service.instance, { force: true, ...drain });
      } else {
        this.services.register(id, staged.service.instance, staged.service.options);
        this.createdServices.push(id);
      }
      return;
    }
    // The new version dropped its `create` half: its service goes away with it.
    if (previous >= 0) {
      await this.services.unregister(id, drain);
      this.createdServices.splice(previous, 1);
    }
  }

  /** Dispose a `create` result that was staged but never published (default rule: its `close()`). */
  private async disposeStaged(id: string, instance: unknown): Promise<void> {
    try {
      const close = (instance as { close?: unknown } | null | undefined)?.close;
      if (typeof close === "function") await (close as () => void | Promise<void>).call(instance);
    } catch (error) {
      console.warn(`[extensions] extension "${id}": disposing the unpublished create result failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The barrier itself (docs/architecture.md §5.5), shared by `replaceExtension` and
   * the plugin manager: gate every session holding one of `extensionIds` (synchronously, FIRST
   * — the set of running sessions only shrinks from there), rendezvous bounded by `timeoutMs`
   * (a straggler throws BarrierTimeout and nothing ran), then run `fn` in the globally quiet
   * moment. `held()` reads live, so sessions born gated during the barrier are included.
   * Whatever happens, every gate is released.
   */
  private async withBarrier(
    extensionIds: readonly string[],
    timeoutMs: number,
    fn: (held: () => readonly HarnessSession<TContext>[]) => Promise<void>,
  ): Promise<void> {
    if (this.activeBarrier !== undefined) throw new Error("another barrier operation is already in progress");
    const holds = new Map<string, { readonly quiescent: Promise<void>; release(): void }>();
    this.activeBarrier = { holds };
    try {
      for (const session of this.activeSessions.values()) {
        const ids = session.attachedExtensionIds();
        if (extensionIds.some((id) => ids.includes(id))) holds.set(session.id, session.holdAtBoundary());
      }
      const stuck = await rendezvous(holds, timeoutMs);
      if (stuck.length > 0) throw new BarrierTimeout(stuck);
      const held = () =>
        [...holds.keys()]
          .map((sessionId) => this.activeSessions.get(sessionId))
          .filter((session): session is HarnessSession<TContext> => session !== undefined);
      await fn(held);
    } finally {
      // Whatever happened, nothing stays held — a failed barrier leaves the world running.
      for (const hold of holds.values()) hold.release();
      this.activeBarrier = undefined;
    }
  }

  /** Resolve the capability set for one session — calling the factory fresh when one was given. */
  private async resolveCapabilities(
    ctx: SessionCapabilityContext,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<readonly Capability[]> {
    const configured = this.options.capabilities;
    const base = typeof configured === "function"
      ? await configured(ctx)
      : configured ?? defaultCapabilities({ maxContextTokens: this.options.maxContextTokens });
    // Every definition registered on this harness: by value (`extensions`, create halves
    // included — their per-session `setup` is mounted here like any other), then from files.
    const extensions = [...this.valueDefs.values(), ...(this.extensions?.sessionDefinitions() ?? [])];
    // Put extension transforms first. Shell PreToolUse remains in the staged permission policy,
    // so it evaluates the final rewritten args before normal authorization.
    // Installed even when empty: the runtime must exist for `attachExtension` to have
    // somewhere to land on sessions born without extensions.
    return [extensionsCapability(extensions, { host: this.extensionHost(ctx.sessionId), params }), ...base];
  }

  /**
   * The harness-tier reach handed to a session's extensions: other sessions, and the model
   * provider registry. Bound to `sessionId` so `fork()` forks THAT session, not whichever one
   * happens to be active.
   *
   * `isIdle`/`waitForIdle` resolve the HarnessSession lazily — at capability-build time the
   * session object does not exist yet (this runs while it is being constructed).
   */
  private extensionHost(sessionId: string): ExtensionHost {
    const self = this;
    const runtime = this.options.modelRuntime;
    return {
      sessionId,
      newSession: (options) => self.createSession({ ...(options?.title !== undefined ? { title: options.title } : {}) }),
      fork: (options) => self.forkSession(sessionId, { ...(options?.title !== undefined ? { title: options.title } : {}) }),
      openSession: (id) => self.resumeSession(id),
      listSessions: () => self.listSessions(),
      registerProvider: (provider) => {
        if (!runtime) throw new Error("registerProvider() requires the harness to be built with a `modelRuntime`");
        runtime.models.setProvider(provider);
      },
      unregisterProvider: (id) => {
        if (!runtime) throw new Error("unregisterProvider() requires the harness to be built with a `modelRuntime`");
        runtime.models.deleteProvider(id);
      },
      services: self.services,
      isIdle: () => self.activeSessions.get(sessionId)?.status.state !== "running",
      waitForIdle: async () => {
        const session = self.activeSessions.get(sessionId);
        // Taking and immediately releasing the run lock IS the wait: it can only be acquired
        // once the in-flight run has finished.
        if (session) await session.core.withRunLock(async () => undefined);
      },
    };
  }

  private async openFromStore(
    id: string,
    workDir: string,
    store: SessionStore,
    opts: OpenSessionOptionsBase<TContext>,
  ): Promise<HarnessSession<TContext>> {
    // A session's `setup` reaches a create half through its service, so none opens before the
    // create halves have registered them.
    await this.sharedReady;
    // Per-session extension params: given at create, persisted, and read back on every later
    // open (resume, fork) so a session keeps them without the caller repeating them.
    let params = opts.params;
    if (params !== undefined) await store.putState(EXTENSION_PARAMS_STATE_KEY, params);
    else params = ((await store.getState(EXTENSION_PARAMS_STATE_KEY)) as Record<string, unknown> | null) ?? undefined;
    const events = new ListenerSink();
    const responder = new MutableResponder();
    // ONE open-time log read, shared: the projection seeds from it, and Session.open
    // receives it as `preloadedLog` so its capability restore + context pre-build fold the
    // same records — same IO, and the same `Message` objects (no second parsed copy).
    // Attach still happens BEFORE Session.open: no events flow yet, so the seed cannot
    // race the subscription, and anything capabilities emit during open is already folded.
    let preloadedLog = await readLog(store);
    const projection = await SessionProjection.attach({ id, store, events }, preloadedLog);
    const interrupted = await store.getState(INTERRUPTION_STATE_KEY) !== null;
    if (!interrupted) {
      const recoveryRecords = await closeOrphanedProjectionFrames(id, store, projection);
      if (recoveryRecords.length > 0) preloadedLog = [...preloadedLog, ...recoveryRecords];
    }
    const core = await Session.open({
      sessionId: id,
      store,
      preloadedLog,
      events,
      responder,
      machine: opts.machine ?? this.options.machine ?? new LocalMachine(workDir),
      capabilities: await this.resolveCapabilities(
        {
          sessionId: id,
          workDir,
          ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
        },
        params,
      ),
      permission: opts.permission ?? this.options.permission ?? { mode: "yolo" },
      eventPublication: opts.eventPublication ?? this.options.eventPublication ?? "immediate",
      // undefined → core resolves the `AGENTS_LOG` env fallback in Session.open.
      logger: this.options.logger,
    });
    const agent =
      opts.agent ??
      this.options.agent ??
      (await this.buildDefaultAgent(opts.appendSystemPrompt, opts.maxStepsPerTurn));
    const session = new HarnessSession<TContext>({
      core,
      // The two caps land in different places: maxStepsPerTurn is an Agent property
      // (the Runner reads the agent's value first), maxTurns is a per-run option.
      agent,
      runner: this.runner,
      events,
      responder,
      projection,
      workDir,
      context: this.contextFor(opts),
      ...(opts.maxTurns ?? this.options.maxTurns) !== undefined
        ? { maxTurns: opts.maxTurns ?? this.options.maxTurns }
        : {},
      interrupted,
      onClosed: (sid) => this.activeSessions.delete(sid),
    });
    this.activeSessions.set(id, session);
    // Born gated: a session appearing while a reshape barrier holds (createSession,
    // resumeSession and openSession all land here) must not start runs mid-swap. Its
    // quiescent is trivially settled — it has no run — so it never delays the rendezvous.
    if (this.activeBarrier !== undefined) this.activeBarrier.holds.set(id, session.holdAtBoundary());
    return session;
  }

  private contextFor(options: { readonly context?: TContext }): TContext | undefined {
    return hasOwnContext(options) ? options.context : this.options.context;
  }
}

/**
 * A cold open proves that no in-process run still owns lifecycle frames left open in the
 * previous journal. Close those frames durably so historical event consumers and Projection
 * agree with HarnessSession.status. A durable interruption is excluded by the caller: its
 * open turn is intentional continuation state, not a crash remnant.
 */
/**
 * Close the turns a dead process left open, without opening the session.
 *
 * A worker that dies mid-turn journals no `turn.ended`; to every reader the turn is still
 * running. Opening the session repairs that (the same recovery runs inside `resumeSession`),
 * but opening boots capabilities and a machine just to write two records. This does only the
 * repair: fold the log, and for every frame still inside a turn append `turn.ended` with
 * `reason: "failed"` (and `agent.ended` for a live sub-agent). Returns the events those records
 * project to, so a host that has live subscribers can hand them on — a record appended here
 * reaches the log, not any broadcast channel.
 *
 * A session paused for an answer is left alone: its open turn is waiting, not dead.
 */
export async function closeOrphanedTurns(sessionId: string, store: SessionStore): Promise<readonly AgentEvent[]> {
  if ((await store.getState(INTERRUPTION_STATE_KEY)) !== null) return [];
  const projection = await SessionProjection.attach({ id: sessionId, store, events: new ListenerSink() }, await readLog(store));
  const records = await closeOrphanedProjectionFrames(sessionId, store, projection);
  const events: AgentEvent[] = [];
  for (const record of records) {
    const event = agentEventFromRecord(record, sessionId);
    if (event !== undefined) events.push(event);
  }
  return events;
}

async function closeOrphanedProjectionFrames(
  sessionId: string,
  store: SessionStore,
  projection: SessionProjection,
): Promise<AgentRecord[]> {
  const recovered: AgentRecord[] = [];
  const snapshot = projection.snapshot({ maxMessages: 0 });
  for (const agent of snapshot.agents) {
    if (agent.turn !== undefined) {
      await appendRecoveryLifecycle({
        type: "event.lifecycle",
        eventId: newAgentEventId(),
        time: Date.now(),
        address: agent.address,
        event: { type: "turn.ended", turnId: agent.turn.turnId, reason: "failed" },
      });
    }
    if (agent.live && agent.agent !== undefined) {
      await appendRecoveryLifecycle({
        type: "event.lifecycle",
        eventId: newAgentEventId(),
        time: Date.now(),
        address: agent.address,
        event: { type: "agent.ended", agent: agent.agent },
      });
    }
  }
  return recovered;

  async function appendRecoveryLifecycle(record: AgentRecord): Promise<void> {
    await store.appendRecord(record);
    recovered.push(record);
    const event = agentEventFromRecord(record, sessionId);
    if (event !== undefined) projection.apply(event, record.time ?? Date.now());
  }
}

/** A reshape rendezvous that did not converge in time. Nothing was changed; the sessions that
 *  never reached their run boundary are named so the caller can act on them and retry. */
export class BarrierTimeout extends Error {
  readonly stuckSessionIds: readonly string[];
  constructor(stuckSessionIds: readonly string[]) {
    super(`reshape barrier timed out; still running: ${stuckSessionIds.join(", ")}`);
    this.name = "BarrierTimeout";
    this.stuckSessionIds = stuckSessionIds;
  }
}

/** Await every hold's quiescent within the budget; report who is still running on expiry. */
async function rendezvous(
  holds: ReadonlyMap<string, { readonly quiescent: Promise<void> }>,
  timeoutMs: number,
): Promise<readonly string[]> {
  if (holds.size === 0) return [];
  const remaining = new Set(holds.keys());
  for (const [id, hold] of holds) void hold.quiescent.then(() => remaining.delete(id));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.all([...holds.values()].map((hold) => hold.quiescent)).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return timedOut ? [...remaining] : [];
}

let commandRegistry: CommandRegistry | undefined;
function sharedCommands(): CommandRegistry {
  commandRegistry ??= createExtensionCommandRegistry();
  return commandRegistry;
}

function isServiceDescriptor(value: unknown): value is { instance: unknown } & ServiceOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    "instance" in value
  );
}

export function createHarness<TContext = unknown>(options: HarnessOptions<TContext>): Harness<TContext> {
  return new Harness<TContext>(options);
}

function hasOwnContext<TContext>(value: { readonly context?: TContext }): boolean {
  return Object.prototype.hasOwnProperty.call(value, "context");
}

/** An already-discriminated resume answer. ApprovalResponse has no `kind` field, so the
 *  presence of a valid discriminant is unambiguous. */
function isInterruptAnswer(answer: ApprovalResponse | InterruptAnswer): answer is InterruptAnswer {
  return "kind" in answer && (answer.kind === "approval" || answer.kind === "input");
}
