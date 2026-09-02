/**
 * The extension contract.
 *
 * An extension is a programmatic participant in the agent loop: it intervenes at decision points,
 * observes what happens, and acts on the session.
 *
 * Two channels, split by whether a return value can participate:
 *
 * - **`api.on(...)` — decision points.** The loop stops and waits for an answer (change this
 *   request? block this tool? run another turn?). Every one of these carries a result type and is
 *   physically a `LoopHooks` slot, which is the only place a return value can act.
 * - **`api.onEvent(...)` — observation.** Read-only, no return value. A thin pass-through to the
 *   session's `EventSink` with two things added: failures are isolated and reported instead of
 *   disrupting the run, and the subscription is torn down with the extension.
 *
 * The split is not cosmetic — some things exist ONLY on the event stream. Subagent lifecycle is
 * the case that forced this: `agent.started` / `agent.ended` fire for every frame, while
 * `run.start` fires only for the top-level run, so an extension that needs to know a subagent was
 * spawned has no hook to reach for.
 *
 * High-frequency data flow (token deltas, tool progress) is legal on `onEvent` but rarely what an
 * extension wants; it pays a listener call per event.
 *
 * `ExtensionRuntime` is the façade that hides which physical channel a decision point arrives on;
 * extension authors only ever see one `api.on(...)` table.
 */
import type {
  AgentEvent,
  AssistantMessage,
  ChatModel,
  AgentInput,
  ContextBreakdown,
  ConversationContext,
  Injector,
  LlmRequest,
  Machine,
  Message,
  ModelRuntime,
  RunResult,
  SessionSummary,
  PendingApprovalInterrupt,
  SessionStore,
  SteerContent,
  SteerOrigin,
  SteerReceipt,
  StepStopReason,
  TerminalStepStopReason,
  ThinkingLevel,
  Tool,
  ToolPlan,
  ToolResult,
  ToolResultContent,
  ToolRunContext,
  Usage,
} from "operon-agents-core";

// ============================================================================
// State
// ============================================================================

/** Per-extension key/value state, namespaced into the session store (memory without one). */
/** A slash command an extension carries (see `ExtensionAPI.registerCommand`). The run
 *  receives only the raw argument string — an extension command closes over what it needs. */
export interface ExtensionCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  run(args: string): Promise<ExtensionCommandResult> | ExtensionCommandResult;
}

export interface ExtensionCommandResult {
  readonly ok: boolean;
  readonly message: string;
  readonly data?: unknown;
}

/** One journal record this extension wrote via `actions.record`, as `records()` returns it. */
export interface ExtensionRecordEntry {
  readonly name: string;
  readonly data?: unknown;
}

export interface ExtensionState {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

// ============================================================================
// Host — the reach only the harness layer has
// ============================================================================

/**
 * A model provider runtime object, as the registry accepts it. Derived from `ModelRuntime`
 * rather than imported by name: core's public `Provider` is the provider-ID STRING (a historical
 * name), while the registry wants pi's provider object.
 */
export type ModelProvider = Parameters<ModelRuntime["models"]["setProvider"]>[0];

/**
 * Operations that exist above the agent loop: other sessions, and the model provider registry.
 * Supplied by `Harness` when it builds the extensions capability. This is exactly why the
 * extension runtime lives in `operon-agents` and not in core — core has no concept of "another
 * session", so an interface defined down there would have been half stubs.
 *
 * Absent when `extensionsCapability` is used standalone (e.g. a bare `Runner` in a test); the
 * matching actions then warn and no-op rather than throwing.
 */
export interface ExtensionHost {
  /** The session this extension instance is bound to. */
  readonly sessionId: string;
  /** Open a brand-new session on the same harness. */
  newSession(options?: { readonly title?: string }): Promise<HarnessSessionHandle>;
  /** Fork THIS session (log + state copied) into a new one and open it. */
  fork(options?: { readonly title?: string }): Promise<HarnessSessionHandle>;
  /** Reopen an existing session by id. Trusted code: any session in the repository. */
  openSession(id: string): Promise<HarnessSessionHandle>;
  listSessions(): Promise<readonly SessionSummary[]>;
  /**
   * Register (or replace) a model provider. HARNESS-GLOBAL: the model runtime is shared by
   * every session on this harness, so this affects them all. No-op + warning when the host
   * was built without a `modelRuntime`.
   */
  registerProvider(provider: ModelProvider): void;
  unregisterProvider(id: string): void;
  /** False while a run is in flight on this session. */
  isIdle(): boolean;
  /** Resolve once no run holds this session's run lock. */
  waitForIdle(): Promise<void>;
  /**
   * The harness's service registry, read-only: `has` for a registration check, `handle` for
   * a stable handle (`ServiceRegistry.handle`). The session tier consumes services, never
   * provides or replaces them. Absent on hosts built without a service registry.
   */
  readonly services?: { has(name: string): boolean; handle<T = unknown>(name: string): T };
}

/**
 * What `newSession`/`fork`/`openSession` hand back. Structurally a `HarnessSession`; typed
 * as the operations an extension realistically needs so the extension contract does not
 * re-export the harness's entire session surface.
 */
export interface HarnessSessionHandle {
  readonly id: string;
  prompt(input: AgentInput): Promise<RunResult>;
  steer(input: string): string;
  followUp(input: string): string | null;
  /**
   * Hand a message to a specific frame in that session — `main` for its root agent,
   * `main/<agentId>` for one of its subagents — carrying your own provenance. `false` when no
   * frame is running there.
   *
   * `steer`/`followUp` above can only ever reach the root; this is what lets an extension address
   * an individual subagent, which is what coordination between agents requires.
   */
  steerTo(address: string, content: string, origin: SteerOrigin): boolean;
  cancel(): void;
  close(): Promise<void>;
}

// ============================================================================
// Actions — what an extension can DO, as opposed to observe
// ============================================================================

/**
 * The imperative surface. Every call here maps onto an operation the host itself could perform;
 * this is the collar where per-extension restrictions would go if we ever need them.
 *
 * Availability differs by phase, and the runtime degrades instead of throwing: an action whose
 * backing service is absent (no compaction capability, no live conversation during a session-tier
 * event) emits a `warning` and no-ops. Guard with the `can*` probes when it matters.
 */
/** Flat attributes rendered onto the `<extension-message>` framing tag — what the model
 *  should know about WHY this message arrived (a cron fire's schedule, a quota's numbers). */
export interface ExtensionSteerOptions {
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ExtensionActions {
  /**
   * Queue a message into the CURRENT turn — drained at the next step boundary, and again after
   * the terminal step, so it is always answered within the turn in flight.
   */
  steer(content: SteerContent, options?: ExtensionSteerOptions): SteerReceipt | undefined;
  /** Queue a message consumed AFTER the current turn settles; forces one more turn. */
  followUp(content: SteerContent, options?: ExtensionSteerOptions): SteerReceipt | undefined;
  /**
   * Append a custom record to the active conversation's journal. Not model-visible — this is
   * durable extension bookkeeping that replays with the session, not context.
   */
  record(name: string, data?: unknown): void;
  /**
   * Stop the run this handler is firing inside; it settles as `status: "aborted"` and the
   * session stays usable for the next prompt. From a session-tier event (`session.start` /
   * `session.end`) there is no run to scope to, so this aborts the session instead.
   */
  abort(reason?: string): void;
  /** Request a compaction pass. No-op + warning when no compaction capability is open. */
  compact(options?: { readonly instruction?: string }): void;
  /** Token breakdown for the most recently assembled request, when one has been stamped. */
  getContextUsage(): ContextBreakdown | undefined;
  setModel(model: string | ChatModel): void;
  setThinkingLevel(level: ThinkingLevel): void;
  /** Every tool name in the last assembled registry (agent ∪ capability ∪ handoff ∪ subagent). */
  getAllTools(): readonly string[];
  /** The names currently allowed through — the full set unless `setActiveTools` narrowed it. */
  getActiveTools(): readonly string[];
  /**
   * Restrict the toolset to these names, or pass `null` to lift the restriction. Takes effect
   * at the NEXT turn's assembly, not mid-turn: the running turn already fixed its registry.
   */
  setActiveTools(names: readonly string[] | null): void;
  /** True once a run is in flight — `record` and the model/thinking setters need one. */
  readonly hasActiveRun: boolean;

  // ── Harness reach. Without a host these warn and no-op (promises reject). ──

  /** Open a new session on the same harness and return a handle to drive it. */
  newSession(options?: { readonly title?: string }): Promise<HarnessSessionHandle>;
  /** Fork this session into a new one and open it. */
  fork(options?: { readonly title?: string }): Promise<HarnessSessionHandle>;
  /** Reopen an existing session by id. */
  openSession(id: string): Promise<HarnessSessionHandle>;
  listSessions(): Promise<readonly SessionSummary[]>;
  /** Register/replace a model provider. Harness-global — every session on it sees the change. */
  registerProvider(provider: ModelProvider): void;
  unregisterProvider(id: string): void;
  /** Whether this session currently has no run in flight. */
  isIdle(): boolean;
  /** Resolve once no run holds this session's run lock. */
  waitForIdle(): Promise<void>;
}

// ============================================================================
// Contexts
// ============================================================================

interface ExtensionContextBase {
  readonly extensionId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly machine: Machine;
  readonly store?: SessionStore;
  readonly state: ExtensionState;
  readonly actions: ExtensionActions;
}

/** Context for events fired inside a run — carries the active conversation shard's address. */
export interface ExtensionEventContext extends ExtensionContextBase {
  readonly address: string;
}

/** Context for session-tier events, which have no active shard. */
export interface ExtensionSessionContext extends ExtensionContextBase {
  readonly address?: never;
}

// ============================================================================
// Lifecycle events (observe — result `void`)
// ============================================================================

/** `attach` = added to a live session via `attachExtension`, after its `setup` succeeded. */
export type SessionStartReason = "open" | "resume" | "fork" | "attach";
/** `detach` = removed from a live session via `detachExtension`; fires before teardown. */
export type SessionEndReason = "close" | "shutdown" | "detach";

export interface ExtensionSessionStartEvent extends ExtensionSessionContext {
  readonly reason: SessionStartReason;
}

export interface ExtensionSessionEndEvent extends ExtensionSessionContext {
  readonly reason: SessionEndReason;
}

// ============================================================================
// Decision points
// ============================================================================

export interface ExtensionStepStartEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly model: ChatModel;
  readonly context: ConversationContext;
  readonly system?: string;
}

export interface ExtensionStepStartResult {
  readonly block?: boolean;
  readonly reason?: string;
  /** Replace the system prompt for THIS step only; the next step re-resolves from the agent. */
  readonly system?: string;
}

/** Fired once per run, before the caller's input is guardrailed or journaled. */
export interface ExtensionRunStartEvent extends ExtensionEventContext {
  readonly agent: string;
  readonly input: readonly Message[];
}

export interface ExtensionRunStartResult {
  /** Replace the input the run will actually see and journal. */
  readonly input?: readonly Message[];
  /**
   * Answer the prompt yourself: no turn runs, no model is called, and nothing is journaled —
   * the session is left exactly as it was. `prompt()` resolves with `status: "skipped"` and
   * this `output`. Use it to short-circuit inputs that have a known answer (a local cache, a
   * canned reply); the first extension to claim it wins.
   */
  readonly handled?: { readonly output?: string };
}

export interface ExtensionStepEndEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly model: ChatModel;
  readonly usage: Usage;
  readonly stopReason: StepStopReason;
  readonly context: ConversationContext;
}

export interface ExtensionStepEndResult {
  /** End the turn after this step instead of continuing the tool-use loop. */
  readonly stopTurn?: boolean;
}

export interface ExtensionRunSettledEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly model: ChatModel;
  readonly usage: Usage;
  readonly stopReason: TerminalStepStopReason;
}

export interface ExtensionRunSettledResult {
  /** Force one more turn instead of finishing the run. */
  readonly continue?: boolean;
}

export interface ExtensionModelRequestEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly model: ChatModel;
  readonly request: LlmRequest;
  /** The live conversation — journaled mutators live here; `request.messages` is a snapshot. */
  readonly context: ConversationContext;
}

export interface ExtensionModelRequestResult {
  readonly request?: LlmRequest;
  readonly block?: boolean;
  readonly reason?: string;
}

export interface ExtensionModelResponseEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly model: ChatModel;
  readonly request: LlmRequest;
  readonly response: AssistantMessage;
  readonly context: ConversationContext;
}

export interface ExtensionToolCallEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly tool?: Tool;
  readonly args: unknown;
}

export interface ExtensionToolCallResult {
  readonly updatedArgs?: unknown;
  readonly block?: boolean;
  readonly reason?: string;
  readonly syntheticResult?: ToolResult;
  /** With `block`: end the turn after this batch rather than letting the model react to the
   *  denial. Ignored without `block` — a `syntheticResult` carries its own `stopTurn`. */
  readonly terminate?: boolean;
}

/** Fired after the call resolves to a plan, alongside permission evaluation. */
export interface ExtensionToolAuthorizeEvent extends ExtensionToolCallEvent {
  readonly plan: ToolPlan;
}

export interface ExtensionToolAuthorizeResult {
  readonly block?: boolean;
  readonly reason?: string;
  readonly syntheticResult?: ToolResult;
  /** Suspend the batch for a human decision instead of deciding here. */
  readonly interrupt?: PendingApprovalInterrupt;
}

export interface ExtensionToolResultEvent extends ExtensionToolCallEvent {
  readonly result: ToolResult;
}

// ============================================================================
// Compaction
// ============================================================================

/**
 * Fired before a compaction pass, whether triggered manually or by the context threshold.
 * Unlike every other decision point this one is NOT engine-driven: the compaction capability
 * asks, via the core `CapabilityGates` mechanism.
 */
export interface ExtensionCompactionBeforeEvent extends ExtensionEventContext {
  readonly reason: "manual" | "auto";
  /** Model-visible history at the moment compaction triggered. */
  readonly messages: readonly Message[];
  /** How many leading messages the default strategy intends to fold into one summary. */
  readonly compactCount: number;
}

export interface ExtensionCompactionBeforeResult {
  /** Skip this pass; the context is left untouched. First cancel wins. */
  readonly cancel?: boolean;
  /**
   * Provide the summary instead of letting compaction call the model — a rule-based digest, a
   * cheaper model, whatever. `count` defaults to `compactCount` and is clamped to history length.
   *
   * This lands in durable history and shapes every later turn. A summary that drops load-bearing
   * context fails silently: the agent just forgets. First replacement wins.
   */
  readonly replacement?: { readonly summary: string; readonly count?: number };
}

// ============================================================================
// Provider (HTTP) decision points
// ============================================================================

/**
 * Headers a provider request carries. `null` deletes a header pi would otherwise send.
 * Mirrors pi-ai's `ProviderHeaders`, spelled out here so the extension contract does not
 * depend on a type core has no reason to re-export.
 */
export type ProviderHeaders = Record<string, string | null>;

/**
 * These three fire BELOW the loop: the runtime folds them into the request's
 * `providerOptions`, and pi-ai calls back from inside its HTTP path. Two consequences the
 * loop-level events do not have:
 *
 * - **They repeat on retry.** `streamWithRetry` re-sends on a retryable failure and pi-ai
 *   re-runs these callbacks each attempt. A payload rewrite MUST be idempotent.
 * - **`payload` is the wire body, typed `unknown`.** Its shape follows the provider/api and can
 *   change under you. This is the division of labour with `model.request`: semantic edits
 *   (system / messages / tools / params) belong there and are typed; wire-level edits belong
 *   here and are not.
 */
export interface ExtensionProviderHeadersEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly headers: ProviderHeaders;
}

export interface ExtensionProviderHeadersResult {
  /** Provide to replace; omit to leave unchanged. */
  readonly headers?: ProviderHeaders;
}

export interface ExtensionProviderPayloadEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  /** The serialized request body, in whatever shape this provider/api uses. */
  readonly payload: unknown;
}

export interface ExtensionProviderPayloadResult {
  /** Provide to replace; omit to leave unchanged. */
  readonly payload?: unknown;
}

/**
 * Observed after the HTTP response arrives and BEFORE its body stream is consumed — so a slow
 * handler delays streaming output. Runs on the observer timeout for that reason.
 */
export interface ExtensionProviderResponseEvent extends ExtensionEventContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly status: number;
  readonly headers: Record<string, string>;
}

// ============================================================================
// Event table
// ============================================================================

export interface ExtensionEventMap {
  "session.start": ExtensionSessionStartEvent;
  "session.end": ExtensionSessionEndEvent;
  "run.start": ExtensionRunStartEvent;
  "step.start": ExtensionStepStartEvent;
  "step.end": ExtensionStepEndEvent;
  "run.settled": ExtensionRunSettledEvent;
  "model.request": ExtensionModelRequestEvent;
  "model.response": ExtensionModelResponseEvent;
  "tool.call": ExtensionToolCallEvent;
  "tool.authorize": ExtensionToolAuthorizeEvent;
  "tool.result": ExtensionToolResultEvent;
  "compaction.before": ExtensionCompactionBeforeEvent;
  "provider.headers": ExtensionProviderHeadersEvent;
  "provider.payload": ExtensionProviderPayloadEvent;
  "provider.response": ExtensionProviderResponseEvent;
}

export interface ExtensionResultMap {
  "session.start": void;
  "session.end": void;
  "run.start": ExtensionRunStartResult | void;
  "step.start": ExtensionStepStartResult | void;
  "step.end": ExtensionStepEndResult | void;
  "run.settled": ExtensionRunSettledResult | void;
  "model.request": ExtensionModelRequestResult | void;
  "model.response": AssistantMessage | void;
  "tool.call": ExtensionToolCallResult | void;
  "tool.authorize": ExtensionToolAuthorizeResult | void;
  "tool.result": ToolResult | void;
  "compaction.before": ExtensionCompactionBeforeResult | void;
  "provider.headers": ExtensionProviderHeadersResult | void;
  "provider.payload": ExtensionProviderPayloadResult | void;
  "provider.response": void;
}

export type ExtensionEventName = keyof ExtensionEventMap;

export type ExtensionHandler<K extends ExtensionEventName> = (
  event: ExtensionEventMap[K],
) => ExtensionResultMap[K] | Promise<ExtensionResultMap[K]>;

// ============================================================================
// Registration API
// ============================================================================

/**
 * Dependency-free tool description for `registerTool` — the form FILE extensions use, since they
 * import nothing from the framework (no `tool()` helper, no zod). Parameters are plain JSON
 * Schema, and arguments reach `execute` UNVALIDATED — the model usually honors the schema, but
 * an extension must treat `args` as untrusted input and check what it relies on.
 */
export interface ExtensionToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. Defaults to an empty object schema. */
  readonly parameters?: Record<string, unknown>;
  /** Permission subject for approval rules; defaults to the tool name. */
  readonly approvalRule?: string;
  execute(args: unknown, ctx: ToolRunContext): string | ToolResultContent | ToolResult | Promise<string | ToolResultContent | ToolResult>;
}

export interface ExtensionAPI {
  /**
   * Subscribe to an event. Ordering within one event is registration order.
   *
   * - transform events chain: each handler sees the previous one's output; `undefined` = no change
   * - decide events short-circuit: the first `block`/`cancel` wins and the rest are skipped
   * - observe events all run, with per-handler fault isolation
   */
  on<K extends ExtensionEventName>(event: K, handler: ExtensionHandler<K>): () => void;
  /**
   * Observe this session's raw event stream.
   *
   * `on(...)` covers DECISION points — every one of those can change what happens (rewrite the
   * request, authorize a call, end the run). This is the other half: read-only observation, and
   * the only place some things are visible at all. Subagent lifecycle is the motivating case —
   * `agent.started` / `agent.ended` are emitted for every frame, while `run.start` only fires for
   * the top-level run, so an extension watching for spawned agents has nothing to hook.
   *
   * A listener that throws is isolated and reported; it never disrupts the run. Scope is this
   * session — an extension coordinating across sessions keeps its own shared state.
   */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** Register a tool. Collides fail closed against agent-owned and other extensions' tools.
   *  Accepts a full `Tool` (host-authored extensions) or a plain {@link ExtensionToolSpec}
   *  (file extensions, which import nothing and so cannot build a `Tool` themselves). */
  registerTool(tool: Tool | ExtensionToolSpec): () => void;
  /**
   * Register a turn-boundary injector. Preferred over hand-rolling injection in an event
   * handler: the manager repairs the injector's watermark across compaction and message
   * removal, which a handler cannot do for itself.
   */
  registerInjector(injector: Injector): () => void;
  /**
   * Register a slash command carried by this extension. It surfaces through the session's
   * command registry (capability duck protocol `sessionCommands()`), so `/name` works the
   * moment the extension is attached — no host wiring. Static registry names win collisions
   * with dynamic ones; two extensions claiming one name fail closed at registration.
   * Removed on detach.
   */
  registerCommand(command: ExtensionCommand): () => void;
  /**
   * Emit an ephemeral stream event `{ type: "extension", extensionId, name, data }`. Stream
   * events are broadcast, never persisted or replayed — an extension's durable facts go
   * through `state` (snapshot) or `actions.record` (journal, read back via `records()`).
   */
  emitEvent(name: string, data?: unknown): void;
  /**
   * Publish this extension's host-facing control surface, retrievable via
   * `HarnessSession.extensionHandle(id)`. Replaces any previous handle; dies on detach.
   */
  expose(handle: object): () => void;
  /**
   * This extension's own journal records, oldest first — the event-sourcing read path.
   * The open-time snapshot rides the session's single shared memoized log read (no extra
   * traversal); records appended this session are included. Fold these in `setup` to rebuild
   * sourced state; prefer `state` when a snapshot is all you need.
   */
  records(): Promise<readonly ExtensionRecordEntry[]>;
  /** Durable per-extension KV (SessionStore-backed) — the same facade handlers get via
   *  `ctx.state`, available from `setup` so state can be loaded before the first run. */
  readonly state: ExtensionState;
  /** The same imperative surface handlers get via `ctx.actions`, usable from `setup`. */
  readonly actions: ExtensionActions;
}

/**
 * What an extension's `create` half is handed — the harness reach it needs to build a
 * process-shared instance. Deliberately narrow: session creation (a spawn factory's one
 * requirement), a data directory (the file form's own folder; absent by value) and the handles
 * of the services it declared in `uses`. No service-registration call: the instance IS the
 * return value, registered under the extension's `id`.
 */
export interface ExtensionHostContext<
  TServices extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  /** Open a brand-new session on this harness — what a spawn factory calls. */
  createSession(
    options?: { readonly title?: string; readonly extensions?: readonly ExtensionDefinition[]; readonly params?: Record<string, unknown> } & Record<string, unknown>,
  ): Promise<{ readonly id: string }>;
  /**
   * Handles to the services named in `uses`, by name — the same handles `setup` gets as
   * `ctx.services`, available to the process half too. What lets a file-loaded bundle take its
   * configuration from a host-registered service (`createHarness({ services })`) instead of
   * baking it in: a reload re-runs `create`, so re-reading the service IS the config update.
   * Method calls resolve the CURRENT provider; the handles expose methods only.
   */
  readonly services: TServices;
  /** The extension's own folder when it was file-loaded; `undefined` when passed by value.
   *  Code only — an update replaces it wholesale. Keep files in `dataDir`. */
  readonly dir?: string;
  /**
   * Where this extension keeps its files: a folder of its own, by id, OUTSIDE the code folder,
   * so replacing the bundle (update) leaves it untouched. Created before `create` runs. Present
   * whenever the harness has a data root — `extensionDir` implies one (`<extensionDir>/.data`);
   * by value it is opt-in (`createHarness({ extensionDataDir })`).
   */
  readonly dataDir?: string;
  warn(message: string): void;
}

/**
 * What `setup` receives besides the API: the handles the framework resolved for this extension
 * in this session. Nothing here is looked up by name from inside the extension — every service
 * it may touch was declared on the definition (`create` for its own, `uses` for others') and
 * arrives resolved.
 */
export interface ExtensionSetupContext<
  TShared = unknown,
  TParams = unknown,
  TServices extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  /** Handle to this extension's own `create` result — `undefined` when it has no `create`. */
  readonly shared: TShared;
  /** This session's per-session argument (`createSession({ params: { [id]: … } })`); `undefined` when none. */
  readonly params: TParams | undefined;
  /**
   * Handles to the services named in `uses`, by name. Every method call resolves the CURRENT
   * provider (a host-side replace lands on the next call); the handles expose METHODS ONLY and
   * die with the extension (after detach every call throws `ServiceUnavailableError`).
   */
  readonly services: TServices;
}

/**
 * An extension: a programmatic participant assembled into a session. One definition, handed to
 * the framework once — by value in `createHarness({ extensions })` or from a file in
 * `extensionDir` — and mounted into every session from then on. Three parts, the first two
 * optional:
 *
 * - **`create` — the process-shared half.** Runs ONCE per harness, not per session. Its return
 *   value is registered as a service under this extension's `id`; every session's `setup` then
 *   receives a stable handle to it as `ctx.shared`. There is no separate type and no separate
 *   option for an extension with a `create` — only this field.
 * - **`uses` — the services of others it consumes.** Names only; checked when the definition is
 *   registered (a consumer must come after its provider) and handed to `setup` resolved as
 *   `ctx.services[name]`. There is no lookup by name from inside an extension.
 * - **`setup` — the per-session half.** Runs once per session with the resolved context. A
 *   session varies it with `createSession({ params: { [id]: … } })` — `ctx.params` — and opts
 *   out of it entirely with `false`.
 *
 * `TShared`/`TParams`/`TServices` are for the author's own typing (use an object type alias for
 * `TServices`, not an interface); the framework holds definitions as `ExtensionDefinition` and
 * every concrete definition is assignable to it.
 */
export interface ExtensionDefinition<
  TShared = unknown,
  TParams = unknown,
  TServices extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly id: string;
  /** Per-handler invocation budget. Defaults to 30s for decision points, 1s for observers. */
  readonly timeoutMs?: number;
  /** The process-shared half. Absent ⇒ an ordinary per-session extension. See above. */
  create?(host: ExtensionHostContext<TServices>): TShared | Promise<TShared>;
  /** Services this extension consumes, by name — other extensions' `create` results (their
   *  `id`s) or host-registered `services`. Resolved into `ctx.services` for `setup`. */
  readonly uses?: readonly (keyof TServices & string)[];
  setup(
    api: ExtensionAPI,
    ctx: ExtensionSetupContext<TShared, TParams, TServices>,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
