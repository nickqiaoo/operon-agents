import { randomBytes } from "node:crypto";
import { ServiceUnavailableError, isProbeProperty } from "./services.ts";
import type { AgentRecord, HeadlessCommand } from "operon-agents-core";
import type {
  AssistantMessage,
  RunContext,
  CompactionGate,
  ChatModel,
  ConversationContext,
  Injector,
  LlmRequest,
  Message,
  ProvisionContext,
  SessionControls,
  SessionStore,
  SteerChannel,
  SteerContent,
  SteerReceipt,
  StepStopReason,
  TerminalStepStopReason,
  Tool,
  ToolPlan,
  ToolResult,
  ToolResultContent,
  Usage,
} from "operon-agents-core";
import { tagToolSource, T } from "operon-agents-core";
import type {
  ExtensionAPI,
  ExtensionActions,
  ExtensionDefinition,
  ExtensionEventContext,
  ExtensionEventMap,
  ExtensionEventName,
  ExtensionHost,
  ExtensionHandler,
  ExtensionModelRequestResult,
  ProviderHeaders,
  ExtensionResultMap,
  ExtensionSessionEventContext,
  ExtensionState,
  ExtensionStepEndResult,
  ExtensionStepStartResult,
  ExtensionToolAuthorizeResult,
  ExtensionToolCallResult,
  ExtensionToolSpec,
  SessionEndReason,
  SessionStartReason,
  ExtensionCommand,
  ExtensionRecordEntry,
} from "./types.ts";

/** Decision points block the loop, so they get room to do real work (network, subprocess). */
const DECISION_TIMEOUT_MS = 30_000;
/** Observers must not become latency: a slow one is dropped, not waited on. */
const OBSERVE_TIMEOUT_MS = 1_000;

const OBSERVE_EVENTS: ReadonlySet<ExtensionEventName> = new Set<ExtensionEventName>([
  "session.start",
  "session.end",
  // Runs after the HTTP response arrives but BEFORE its body is consumed — a slow handler
  // here is latency on every streamed token, so it gets the short budget.
  "provider.response",
]);


interface RegisteredHandler<K extends ExtensionEventName = ExtensionEventName> {
  readonly extensionId: string;
  readonly timeoutMs: number | undefined;
  readonly handler: ExtensionHandler<K>;
}

/** Shared shape of the loop-hook contexts the dispatch methods are fed from. */
interface StepOrigin {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly address?: string;
  readonly signal: AbortSignal;
  readonly model: ChatModel;
}

/** A queued attach/detach, applied at the next quiet point (idle, or the run's stop). */
type PendingChange =
  | { readonly kind: "attach"; readonly definition: ExtensionDefinition; readonly resolve: () => void; readonly reject: (error: unknown) => void }
  | { readonly kind: "detach"; readonly id: string; readonly resolve: () => void; readonly reject: (error: unknown) => void };

export class ExtensionRuntime {
  private readonly definitions: ExtensionDefinition[];
  private readonly handlers = new Map<ExtensionEventName, RegisteredHandler[]>();
  private readonly tools = new Map<string, { readonly extensionId: string; readonly tool: Tool }>();
  /** Stable reference: `extensionsCapability` hands this array to the assembler, and `session`
   *  (which runs at openSession, before any run assembles) fills it in place. */
  private readonly injectors: Injector[] = [];
  /** Slash commands by normalized name — surfaced to the session's registry via the
   *  `sessionCommands()` duck protocol. Two extensions claiming one name fail closed. */
  private readonly extCommands = new Map<string, { extensionId: string; command: HeadlessCommand }>();
  /** Host-facing control surfaces published via `api.expose`, by extension id. */
  private readonly exposedHandles = new Map<string, unknown>();
  /** Records read path: open-time snapshot buckets (built lazily off the session's shared
   *  memoized log read — zero extra traversal) + everything recorded this session. */
  private recordSnapshot: Map<string, ExtensionRecordEntry[]> | undefined;
  private readonly recordWrites = new Map<string, ExtensionRecordEntry[]>();
  /** Per-extension teardown: session()'s cleanup + every registration, undone in reverse. */
  private readonly scopes = new Map<string, () => void | Promise<void>>();
  /** Extensions whose contributions are currently honored. An id leaves on detach (and on
   *  session() failure), which turns every `actions`/`api` closure the extension still holds
   *  into a warn-and-noop — a detached extension must not keep steering the session. */
  private readonly live = new Set<string>();
  /** Changes wait here until a quiet point: mid-run requests apply at the run's stop
   *  boundary, so a turn never sees its toolset change underneath it. */
  private pending: PendingChange[] = [];
  /** Serializes flushes so concurrent attach/detach apply strictly in submission order. */
  private flushChain: Promise<void> = Promise.resolve();
  private readonly memoryState = new Map<string, unknown>();
  /** The session binding: its scope (machine, store, events, steer, log reader, controls) + id + signal. */
  private session: ProvisionContext | undefined;
  private run: RunContext | undefined;
  /** The conversation shard the in-flight decision point belongs to; backs `actions.record`. */
  private activeContext: ConversationContext | undefined;
  /** Snapshot of the last assembled registry, refreshed once per turn by `filterTools`. */
  private allToolNames: readonly string[] = [];
  /** `null` = unrestricted. Set by `actions.setActiveTools`; applied at the next assembly. */
  private activeToolNames: ReadonlySet<string> | null = null;
  private reportingWarning = false;

  /** Harness reach. Absent when the capability is built standalone (bare Runner / tests). */
  private readonly host: ExtensionHost | undefined;
  /** This session's per-session extension arguments, by extension id. A value of `false` means
   *  "skip this extension for this session"; any other value is passed to `session` as `params`. */
  private readonly params: Readonly<Record<string, unknown>>;

  constructor(definitions: readonly ExtensionDefinition[], host?: ExtensionHost, params: Readonly<Record<string, unknown>> = {}) {
    this.host = host;
    this.params = params;
    const seen = new Set<string>();
    for (const definition of definitions) {
      if (!definition.id.trim()) throw new Error("extension id must not be empty");
    // Slug only, colons forbidden: records and state scope by the "extension:<id>:" prefix,
    // so an id containing ":" would make one extension's bucket swallow another's.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(definition.id)) {
      throw new Error(`extension id "${definition.id}" must be a slug ([A-Za-z0-9_.-], no colons)`);
    }
      if (seen.has(definition.id)) throw new Error(`duplicate extension id "${definition.id}"`);
      seen.add(definition.id);
    }
    // A session that opted an extension out (`params[id] === false`) never carries it: not in
    // the definition list, never set up, never reported as attached.
    this.definitions = definitions.filter((definition) => params[definition.id] !== false);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async open(ctx: ProvisionContext, reason: SessionStartReason = "open"): Promise<void> {
    this.session = ctx;
    for (const definition of this.definitions) {
      await this.setupExtension(definition);
    }
    for (const registered of [...this.handlersFor("session.start")]) {
      await this.invoke("session.start", registered, { ...this.sessionContext(registered.extensionId), reason });
    }
  }

  attachRun(ctx: RunContext): void {
    this.run = ctx;
  }

  async detachRun(): Promise<void> {
    this.run = undefined;
    this.activeContext = undefined;
    // The run just ended — this is the quiet point mid-run attach/detach requests wait for.
    await this.flushPending();
  }

  async close(reason: SessionEndReason = "close"): Promise<void> {
    if (this.session) {
      for (const registered of [...this.handlersFor("session.end")]) {
        await this.invoke("session.end", registered, { ...this.sessionContext(registered.extensionId), reason });
      }
    }
    for (const [id, scope] of [...this.scopes].reverse()) {
      try {
        await scope();
      } catch (error) {
        await this.warn(id, `teardown failed: ${messageOf(error)}`);
      }
    }
    this.scopes.clear();
    this.live.clear();
    this.extCommands.clear();
    this.exposedHandles.clear();
    this.recordSnapshot = undefined;
    this.recordWrites.clear();
    for (const entry of this.pending.splice(0)) entry.reject(new Error("session closed"));
    this.injectors.length = 0;
    this.session = undefined;
  }

  // ==========================================================================
  // Hot attach / detach — host API, applied at the next quiet point
  // ==========================================================================

  /**
   * Add an extension to the live session. Resolves once its `session` has run and its
   * contributions are in place — with no run in flight that is immediately; mid-run it is
   * the current run's stop boundary, so an in-flight turn never sees its registry change.
   * Rejects on duplicate/empty id or when `session` throws.
   */
  attach(definition: ExtensionDefinition): Promise<void> {
    return this.submit({ kind: "attach", definition });
  }

  /** Ids of currently attached extensions — the reshape coordinator's affected-set probe. */
  attachedIds(): readonly string[] {
    return [...this.live];
  }

  /** Currently attached extensions with what each declared it `uses` — the unload consumer scan. */
  attachedExtensions(): readonly { readonly id: string; readonly uses: readonly string[] }[] {
    return this.definitions.filter((definition) => this.live.has(definition.id)).map((definition) => ({ id: definition.id, uses: definition.uses ?? [] }));
  }

  /** The duck protocol the session's command registry consumes: dynamic commands contributed
   *  by attached extensions (`api.registerCommand`). */
  sessionCommands(): readonly HeadlessCommand[] {
    return [...this.extCommands.values()].map((entry) => entry.command);
  }

  /** The control surface `extensionId` published via `api.expose`; undefined when absent
   *  (never attached, detached, or nothing exposed). */
  exposedHandle<T = unknown>(extensionId: string): T | undefined {
    return this.exposedHandles.get(extensionId) as T | undefined;
  }

  /** Remove an extension: its `session.end` fires, then its whole scope is torn down. */
  detach(id: string): Promise<void> {
    return this.submit({ kind: "detach", id });
  }

  private submit(change: { kind: "attach"; definition: ExtensionDefinition } | { kind: "detach"; id: string }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ ...change, resolve, reject } as PendingChange);
      if (this.run === undefined) void this.flushPending();
    });
  }

  private flushPending(): Promise<void> {
    const next = this.flushChain.then(() => this.drainPending());
    this.flushChain = next.catch(() => undefined);
    return next;
  }

  private async drainPending(): Promise<void> {
    while (this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) break;
      try {
        if (entry.kind === "attach") await this.attachNow(entry.definition);
        else await this.detachNow(entry.id);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      }
    }
  }

  private async attachNow(definition: ExtensionDefinition): Promise<void> {
    if (!definition.id.trim()) throw new Error("extension id must not be empty");
    // Slug only, colons forbidden: records and state scope by the "extension:<id>:" prefix,
    // so an id containing ":" would make one extension's bucket swallow another's.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(definition.id)) {
      throw new Error(`extension id "${definition.id}" must be a slug ([A-Za-z0-9_.-], no colons)`);
    }
    if (this.params[definition.id] === false) {
      throw new Error(`extension "${definition.id}" is opted out for this session (params["${definition.id}"] is false)`);
    }
    if (this.definitions.some((existing) => existing.id === definition.id)) {
      throw new Error(`duplicate extension id "${definition.id}"`);
    }
    this.definitions.push(definition);
    // Not open yet: `open()` will run session() with everything else.
    if (!this.session) return;
    const ok = await this.setupExtension(definition);
    if (!ok) {
      const index = this.definitions.findIndex((existing) => existing.id === definition.id);
      if (index >= 0) this.definitions.splice(index, 1);
      throw new Error(`extension "${definition.id}" session() failed`);
    }
    for (const registered of [...this.handlersFor("session.start")]) {
      if (registered.extensionId !== definition.id) continue;
      await this.invoke("session.start", registered, { ...this.sessionContext(definition.id), reason: "attach" });
    }
    await this.logChange("attached", definition.id);
  }

  private async detachNow(id: string): Promise<void> {
    const index = this.definitions.findIndex((existing) => existing.id === id);
    if (index < 0) throw new Error(`unknown extension "${id}"`);
    // Notify while its handlers are still registered.
    if (this.session && this.live.has(id)) {
      for (const registered of [...this.handlersFor("session.end")]) {
        if (registered.extensionId !== id) continue;
        await this.invoke("session.end", registered, { ...this.sessionContext(id), reason: "detach" });
      }
    }
    this.definitions.splice(index, 1);
    this.live.delete(id);
    const scope = this.scopes.get(id);
    this.scopes.delete(id);
    if (scope) {
      try {
        await scope();
      } catch (error) {
        await this.warn(id, `teardown failed: ${messageOf(error)}`);
      }
    }
    if (this.session) await this.logChange("detached", id);
  }

  /** Runs one extension's `session` and files its scope. Failure ⇒ skipped, contributions undone. */
  private async setupExtension(definition: ExtensionDefinition): Promise<boolean> {
    const params = this.params[definition.id];
    // A definition with a shared half reaches a session only after that half ran — the harness
    // ran `harness` once, or this session's workspace ran `workspace` — and registered the result
    // under the id where the session's scope chain finds it. Not registered ⇒ it was handed to a
    // session directly instead of being registered — a programming error, so it throws rather
    // than being skipped.
    const sharedHalf = definition.harness !== undefined || definition.workspace !== undefined;
    if (sharedHalf && this.host?.services?.has(definition.id) !== true) {
      throw new Error(
        `extension "${definition.id}" has a shared half but no service "${definition.id}" is reachable from this session — its harness/workspace half never ran. Register it in createHarness({ extensions }) or load it from extensionDir; a definition with a shared half cannot be handed to a session directly`,
      );
    }
    const shared = sharedHalf ? this.serviceHandle(definition.id, definition.id) : undefined;
    const registrations: Array<() => void> = [];
    this.live.add(definition.id);
    try {
      // `uses`: checked at registration, re-checked here (a provider may have unloaded since)
      // and handed in resolved — an extension never looks a service up by name.
      const services: Record<string, unknown> = {};
      for (const name of definition.uses ?? []) {
        if (this.host?.services?.has(name) !== true) throw new Error(`uses "${name}": no such service is registered`);
        services[name] = this.serviceHandle(definition.id, name);
      }
      const teardown = await definition.session(this.apiFor(definition, registrations), { shared, params, services });
      this.scopes.set(definition.id, async () => {
        if (teardown) await teardown();
        for (const dispose of [...registrations].reverse()) dispose();
      });
      return true;
    } catch (error) {
      this.live.delete(definition.id);
      for (const dispose of [...registrations].reverse()) dispose();
      await this.warn(definition.id, `session() failed; extension skipped: ${messageOf(error)}`);
      return false;
    }
  }

  /**
   * Durable audit trail: replay needs "tool X only exists after record N" to reconstruct the
   * capability timeline. Rides the `custom` record type — audit-only, ignored by reducers.
   */
  private async logChange(kind: "attached" | "detached", extensionId: string): Promise<void> {
    const store = this.session?.scope.get(T.Store);
    if (!store) return;
    try {
      await store.appendRecord({ type: "custom", name: `extensions.${kind}`, data: { extensionId } });
    } catch (error) {
      await this.warn(extensionId, `failed to journal extension ${kind}: ${messageOf(error)}`);
    }
  }

  listTools(): readonly Tool[] {
    return [...this.tools.values()].map((entry) => entry.tool);
  }

  listInjectors(): readonly Injector[] {
    return this.injectors;
  }

  /**
   * The capability's `ToolFilter`. Snapshots the full registry (so `getAllTools` has something
   * to report) and applies the active-tool restriction, if any. Identity-returns when nothing
   * is restricted, which lets the caller skip rebuilding the deferred-name set.
   */
  filterTools = (tools: readonly Tool[]): readonly Tool[] => {
    this.allToolNames = tools.map((tool) => tool.schema.name);
    const allow = this.activeToolNames;
    if (allow === null) return tools;
    return tools.filter((tool) => allow.has(tool.schema.name));
  };

  // ==========================================================================
  // Dispatch — one method per loop-hook decision point
  // ==========================================================================

  /**
   * Run-tier: the caller's input, before guardrails and before anything is journaled.
   * There is no active conversation yet, so this borrows the session context's shape.
   */
  async beforeRun(
    origin: { readonly address: string; readonly agent: string; readonly signal: AbortSignal },
    input: readonly Message[],
  ): Promise<{ input?: readonly Message[]; handled?: { output?: string } } | undefined> {
    let current = input;
    let changed = false;
    for (const registered of this.handlersFor("run.start")) {
      const result = await this.invoke("run.start", registered, {
        ...this.sessionContext(registered.extensionId),
        address: origin.address,
        signal: origin.signal,
        agent: origin.agent,
        input: current,
      });
      // First claim wins; the runner stops consulting hooks once a run is answered.
      if (result?.handled !== undefined) return { handled: result.handled };
      if (result?.input !== undefined) {
        current = result.input;
        changed = true;
      }
    }
    return changed ? { input: current } : undefined;
  }

  /**
   * The capability's compaction gate. Not engine-driven: the compaction capability calls this
   * through core's `CapabilityGates`, which is why there is no matching `LoopHooks` slot.
   *
   * There is no run-scoped address here (compaction is a session-level operation on one shard),
   * so handlers get the session context shape plus the shard being compacted.
   */
  compactionGate: CompactionGate = async (ctx) => {
    const handlers = this.handlersFor("compaction.before");
    if (handlers.length === 0) return undefined;
    let replacement: { summary: string; count?: number } | undefined;
    for (const registered of handlers) {
      const result = await this.invoke("compaction.before", registered, {
        ...this.sessionContext(registered.extensionId),
        address: this.activeContext?.address ?? "main",
        signal: ctx.signal,
        reason: ctx.reason,
        messages: ctx.messages,
        compactCount: ctx.compactCount,
      });
      if (result?.cancel === true) return { cancel: true };
      if (result?.replacement !== undefined && replacement === undefined) replacement = result.replacement;
    }
    return replacement ? { replacement } : undefined;
  };

  async beforeStep(
    origin: StepOrigin,
    context: ConversationContext,
    system: string | undefined,
  ): Promise<ExtensionStepStartResult | undefined> {
    this.activeContext = context;
    let currentSystem = system;
    let changed = false;
    for (const registered of this.handlersFor("step.start")) {
      const result = await this.invoke("step.start", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        model: origin.model,
        context,
        system: currentSystem,
      });
      if (result?.block === true) return result;
      if (result?.system !== undefined) {
        currentSystem = result.system;
        changed = true;
      }
    }
    return changed ? { system: currentSystem } : undefined;
  }

  async afterStep(
    origin: StepOrigin,
    context: ConversationContext,
    usage: Usage,
    stopReason: StepStopReason,
  ): Promise<ExtensionStepEndResult | undefined> {
    this.activeContext = context;
    let stopTurn = false;
    for (const registered of this.handlersFor("step.end")) {
      const result = await this.invoke("step.end", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        model: origin.model,
        usage,
        stopReason,
        context,
      });
      if (result?.stopTurn === true) stopTurn = true;
    }
    return stopTurn ? { stopTurn: true } : undefined;
  }

  async runSettled(
    origin: StepOrigin,
    usage: Usage,
    stopReason: TerminalStepStopReason,
  ): Promise<{ continue: boolean } | undefined> {
    for (const registered of this.handlersFor("run.settled")) {
      const result = await this.invoke("run.settled", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        model: origin.model,
        usage,
        stopReason,
      });
      if (result?.continue === true) return { continue: true };
    }
    return undefined;
  }

  async beforeModelRequest(
    origin: StepOrigin,
    request: LlmRequest,
    context: ConversationContext,
  ): Promise<ExtensionModelRequestResult | undefined> {
    this.activeContext = context;
    let current = request;
    let changed = false;
    for (const registered of this.handlersFor("model.request")) {
      const result = await this.invoke("model.request", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        model: origin.model,
        request: current,
        context,
      });
      if (!result) continue;
      if (result.block === true) return result;
      if (result.request !== undefined) {
        current = result.request;
        changed = true;
      }
    }
    // Fold the provider-tier callbacks into the request pi-ai will actually send. They cannot be
    // driven from here — pi-ai invokes them from inside its HTTP path — so the only way to reach
    // them is to ride along on `providerOptions`.
    const withProvider = this.withProviderHooks(current, origin);
    if (withProvider !== undefined) {
      current = withProvider;
      changed = true;
    }
    return changed ? { request: current } : undefined;
  }

  /**
   * Attach `transformHeaders` / `onPayload` / `onResponse` when anything is listening. Returns
   * `undefined` when nothing is, so a request with no provider-tier extensions is left byte-identical.
   *
   * These fire once per HTTP ATTEMPT, so a retry re-runs them — the contract tells handlers to be
   * idempotent, and the runtime does not try to dedupe on their behalf.
   */
  private withProviderHooks(request: LlmRequest, origin: StepOrigin): LlmRequest | undefined {
    const headerHandlers = this.handlersFor("provider.headers");
    const payloadHandlers = this.handlersFor("provider.payload");
    const responseHandlers = this.handlersFor("provider.response");
    if (headerHandlers.length === 0 && payloadHandlers.length === 0 && responseHandlers.length === 0) {
      return undefined;
    }
    const base = { turnId: origin.turnId, stepNumber: origin.stepNumber };
    const providerOptions: Record<string, unknown> = { ...request.providerOptions };

    if (headerHandlers.length > 0) {
      providerOptions.transformHeaders = async (headers: ProviderHeaders): Promise<ProviderHeaders> => {
        let current = headers;
        for (const registered of headerHandlers) {
          const result = await this.invoke("provider.headers", registered, {
            ...this.eventContext(registered.extensionId, origin),
            ...base,
            headers: current,
          });
          if (result?.headers !== undefined) current = result.headers;
        }
        return current;
      };
    }

    if (payloadHandlers.length > 0) {
      providerOptions.onPayload = async (payload: unknown): Promise<unknown> => {
        let current = payload;
        for (const registered of payloadHandlers) {
          const result = await this.invoke("provider.payload", registered, {
            ...this.eventContext(registered.extensionId, origin),
            ...base,
            payload: current,
          });
          if (result !== undefined && "payload" in result) current = result.payload;
        }
        return current;
      };
    }

    if (responseHandlers.length > 0) {
      providerOptions.onResponse = async (response: { status: number; headers: Record<string, string> }): Promise<void> => {
        for (const registered of responseHandlers) {
          await this.invoke("provider.response", registered, {
            ...this.eventContext(registered.extensionId, origin),
            ...base,
            status: response.status,
            headers: response.headers,
          });
        }
      };
    }

    return { ...request, providerOptions };
  }

  async afterModelResponse(
    origin: StepOrigin,
    request: LlmRequest,
    response: AssistantMessage,
    context: ConversationContext,
  ): Promise<AssistantMessage | undefined> {
    this.activeContext = context;
    let current = response;
    let changed = false;
    for (const registered of this.handlersFor("model.response")) {
      const result = await this.invoke("model.response", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        model: origin.model,
        request,
        response: current,
        context,
      });
      if (result !== undefined) {
        current = result;
        changed = true;
      }
    }
    return changed ? current : undefined;
  }

  async beforeToolCall(
    origin: StepOrigin,
    toolName: string,
    toolCallId: string,
    tool: Tool | undefined,
    args: unknown,
  ): Promise<ExtensionToolCallResult | undefined> {
    let currentArgs = args;
    let changed = false;
    for (const registered of this.handlersFor("tool.call")) {
      const result = await this.invoke("tool.call", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        toolName,
        toolCallId,
        tool,
        args: currentArgs,
      });
      if (!result) continue;
      if (result.block === true || result.syntheticResult !== undefined) return result;
      // `terminate` without `block` is meaningless — the call runs, and a running tool
      // signals turn termination through its own result.
      if (result.updatedArgs !== undefined) {
        currentArgs = result.updatedArgs;
        changed = true;
      }
    }
    return changed ? { updatedArgs: currentArgs } : undefined;
  }

  async authorizeToolCall(
    origin: StepOrigin,
    toolName: string,
    toolCallId: string,
    tool: Tool | undefined,
    args: unknown,
    plan: ToolPlan,
  ): Promise<ExtensionToolAuthorizeResult | undefined> {
    for (const registered of this.handlersFor("tool.authorize")) {
      const result = await this.invoke("tool.authorize", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        toolName,
        toolCallId,
        tool,
        args,
        plan,
      });
      if (result?.block === true || result?.interrupt !== undefined || result?.syntheticResult !== undefined) {
        return result;
      }
    }
    return undefined;
  }

  async afterToolResult(
    origin: StepOrigin,
    toolName: string,
    toolCallId: string,
    tool: Tool | undefined,
    args: unknown,
    result: ToolResult,
  ): Promise<ToolResult | undefined> {
    let current = result;
    let changed = false;
    for (const registered of this.handlersFor("tool.result")) {
      const next = await this.invoke("tool.result", registered, {
        ...this.eventContext(registered.extensionId, origin),
        turnId: origin.turnId,
        stepNumber: origin.stepNumber,
        toolName,
        toolCallId,
        tool,
        args,
        result: current,
      });
      if (next !== undefined) {
        current = next;
        changed = true;
      }
    }
    return changed ? current : undefined;
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  private apiFor(definition: ExtensionDefinition, registrations: Array<() => void>): ExtensionAPI {
    return {
      on: (event, handler) => {
        if (!this.live.has(definition.id)) {
          void this.warn(definition.id, `on("${event}") ignored: extension is detached.`);
          return () => undefined;
        }
        const entry: RegisteredHandler = {
          extensionId: definition.id,
          timeoutMs: definition.timeoutMs,
          handler: handler as unknown as ExtensionHandler<ExtensionEventName>,
        };
        const list = this.handlers.get(event) ?? [];
        list.push(entry);
        this.handlers.set(event, list);
        const dispose = () => {
          const index = list.indexOf(entry);
          if (index >= 0) list.splice(index, 1);
        };
        registrations.push(dispose);
        return dispose;
      },
      onEvent: (listener) => {
        if (!this.live.has(definition.id)) {
          void this.warn(definition.id, "onEvent() ignored: extension is detached.");
          return () => undefined;
        }
        // `session` runs inside `open`, so the session context is already in place.
        const sink = this.session?.scope.get(T.Events);
        if (sink === undefined) return () => undefined;
        const dispose = sink.subscribe((event) => {
          try {
            listener(event);
          } catch (error) {
            // Observation must never disrupt the run that produced the event.
            void this.warn(definition.id, `onEvent listener failed: ${messageOf(error)}`);
          }
        });
        registrations.push(dispose);
        return dispose;
      },
      registerTool: (toolOrSpec) => {
        // A plain spec (file extensions — no framework imports, so no `tool()` helper) is
        // expanded here; a real Tool passes through untouched.
        const tool = "schema" in toolOrSpec ? toolOrSpec : toolFromSpec(toolOrSpec);
        if (!this.live.has(definition.id)) {
          void this.warn(definition.id, `registerTool("${tool.schema.name}") ignored: extension is detached.`);
          return () => undefined;
        }
        const name = tool.schema.name;
        const existing = this.tools.get(name);
        if (existing) {
          throw new Error(`extension tool "${name}" from "${definition.id}" collides with "${existing.extensionId}"`);
        }
        this.tools.set(name, { extensionId: definition.id, tool });
        // Core's toolset assembly reads this tag to fail a name collision closed, naming us.
        tagToolSource(tool, definition.id);
        const dispose = () => {
          if (this.tools.get(name)?.tool === tool) this.tools.delete(name);
        };
        registrations.push(dispose);
        return dispose;
      },
      registerInjector: (injector) => {
        if (!this.live.has(definition.id)) {
          void this.warn(definition.id, `registerInjector("${injector.id}") ignored: extension is detached.`);
          return () => undefined;
        }
        this.injectors.push(injector);
        const dispose = () => {
          const index = this.injectors.indexOf(injector);
          if (index >= 0) this.injectors.splice(index, 1);
        };
        registrations.push(dispose);
        return dispose;
      },
      registerCommand: (command) => {
        if (!this.live.has(definition.id)) {
          void this.warn(definition.id, `registerCommand("/${command.name}") ignored: extension is detached.`);
          return () => undefined;
        }
        const key = command.name.trim().toLowerCase();
        const existing = this.extCommands.get(key);
        if (existing) {
          throw new Error(`extension command "/${key}" from "${definition.id}" collides with "${existing.extensionId}"`);
        }
        const headless: HeadlessCommand = {
          name: command.name,
          ...(command.aliases !== undefined ? { aliases: command.aliases } : {}),
          description: command.description,
          run: async (_ctx, args) => command.run(args),
        };
        this.extCommands.set(key, { extensionId: definition.id, command: headless });
        const dispose = () => {
          if (this.extCommands.get(key)?.command === headless) this.extCommands.delete(key);
        };
        registrations.push(dispose);
        return dispose;
      },
      emitEvent: (name, data) => {
        if (!this.live.has(definition.id)) {
          void this.warn(definition.id, `emitEvent("${name}") ignored: extension is detached.`);
          return;
        }
        const session = this.session;
        if (!session) {
          void this.warn(definition.id, `emitEvent("${name}") ignored: no open session.`);
          return;
        }
        void session.scope.get(T.Events)?.emit({
          address: "main",
          sessionId: session.sessionId,
          type: "extension",
          extensionId: definition.id,
          name,
          ...(data !== undefined ? { data } : {}),
        });
      },
      expose: (handle) => {
        if (!this.live.has(definition.id)) {
          void this.warn(definition.id, "expose() ignored: extension is detached.");
          return () => undefined;
        }
        this.exposedHandles.set(definition.id, handle);
        const dispose = () => {
          if (this.exposedHandles.get(definition.id) === handle) this.exposedHandles.delete(definition.id);
        };
        registrations.push(dispose);
        return dispose;
      },
      records: async () => {
        const snapshot = (await this.ensureRecordSnapshot()).get(definition.id) ?? [];
        const writes = this.recordWrites.get(definition.id) ?? [];
        return [...snapshot, ...writes];
      },
      state: {
        get: (key) => this.stateFor(definition.id, this.session?.scope.get(T.Store)).get(key),
        set: (key, value) => this.stateFor(definition.id, this.session?.scope.get(T.Store)).set(key, value),
        delete: (key) => this.stateFor(definition.id, this.session?.scope.get(T.Store)).delete(key),
      },
      actions: this.actionsFor(definition.id),
    };
  }

  /**
   * A handle to service `name` collared to `extensionId`'s liveness — the `actions` revocation
   * collar mirrored: liveness is checked at CALL time, including for METHODS stashed off the
   * handle before detach (the returned function re-checks on every invocation), so nothing
   * handed out while live keeps operating afterwards. The inner registry handle decides the
   * probe/shape questions (probes read undefined, field access throws); only functions get
   * the wrapper.
   */
  private serviceHandle<T = unknown>(extensionId: string, name: string): T {
    const services = this.host?.services;
    if (services === undefined) throw new Error(`service "${name}": this host exposes no services`);
    const runtime = this;
    const dead = () => (..._args: unknown[]) => {
      void runtime.warn(extensionId, `service "${name}" call ignored: extension is detached.`);
      throw new ServiceUnavailableError(name, "missing");
    };
    return new Proxy(Object.create(null) as object, {
      get(_target, prop) {
        if (isProbeProperty(prop)) return undefined;
        if (!runtime.live.has(extensionId)) return dead();
        const inner = (services.handle(name) as Record<string, unknown>)[prop as string];
        if (typeof inner !== "function") return inner;
        return (...args: unknown[]) => {
          if (!runtime.live.has(extensionId)) return dead()();
          return (inner as (...a: unknown[]) => unknown)(...args);
        };
      },
      // Forward `in` so consumers can probe registration ("route" in handle) through the
      // collar; a detached extension's probe reads false like a dead handle's.
      has: (_target, prop) => {
        if (!runtime.live.has(extensionId)) return false;
        return Reflect.has(services.handle(name) as object, prop);
      },
    }) as T;
  }

  // ==========================================================================
  // Actions
  // ==========================================================================

  /** viaHost-backed actions promise session handles; when revoked they must reject, not fake. */
  private static readonly PROMISE_ACTIONS: ReadonlySet<string> = new Set([
    "newSession",
    "fork",
    "openSession",
    "listSessions",
    "waitForIdle",
  ]);

  /**
   * Revocation collar: a detached extension's stashed `actions` must not keep operating the
   * session. Liveness is checked at CALL time (not build time), so closures handed out before
   * the detach die with it. Reads (`hasActiveRun`) pass through — a stale read is harmless,
   * a stale steer/abort is not.
   */
  private revocable(extensionId: string, actions: ExtensionActions): ExtensionActions {
    const runtime = this;
    return new Proxy(actions, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || runtime.live.has(extensionId)) return value;
        return (..._args: unknown[]) => {
          void runtime.warn(extensionId, `${String(prop)}() ignored: extension is detached.`);
          if (ExtensionRuntime.PROMISE_ACTIONS.has(String(prop))) {
            return Promise.reject(new Error(`${String(prop)}() unavailable: extension "${extensionId}" is detached`));
          }
          if (prop === "isIdle") return true;
          if (prop === "getAllTools" || prop === "getActiveTools") return [];
          return undefined;
        };
      },
    });
  }

  private actionsFor(extensionId: string): ExtensionActions {
    const runtime = this;
    return this.revocable(extensionId, {
      steer: (content, options) => runtime.enqueue(extensionId, content, "steering", options?.metadata),
      followUp: (content, options) => runtime.enqueue(extensionId, content, "follow_up", options?.metadata),
      record: (name, data) => {
        const context = runtime.activeContext;
        if (!context) {
          void runtime.warn(extensionId, `record("${name}") ignored: no active conversation.`);
          return;
        }
        context.record({ type: "custom", name: `extension:${extensionId}:${name}`, data });
        // Mirror into the in-memory bucket so `records()` sees this session's writes without
        // re-reading the log (the open-time memoized read predates them).
        const bucket = runtime.recordWrites.get(extensionId) ?? [];
        if (!runtime.recordWrites.has(extensionId)) runtime.recordWrites.set(extensionId, bucket);
        bucket.push({ name, ...(data !== undefined ? { data } : {}) });
      },
      abort: (reason) => {
        const controls = runtime.controls();
        if (!controls) {
          void runtime.warn(extensionId, "abort() ignored: session controls unavailable.");
          return;
        }
        controls.abort(reason ?? `aborted by extension "${extensionId}"`);
      },
      compact: (options) => {
        const controls = runtime.controls();
        if (!controls) {
          void runtime.warn(extensionId, "compact() ignored: session controls unavailable.");
          return;
        }
        void controls
          .compact(options?.instruction !== undefined ? { instruction: options.instruction } : {})
          .catch((error: unknown) => runtime.warn(extensionId, `compact() failed: ${messageOf(error)}`));
      },
      getContextUsage: () => runtime.controls()?.getContextBreakdown(),
      setModel: (model) => {
        const controls = runtime.controls();
        if (!controls) {
          void runtime.warn(extensionId, "setModel() ignored: session controls unavailable.");
          return;
        }
        try {
          controls.setModel(model);
        } catch (error) {
          void runtime.warn(extensionId, `setModel() failed: ${messageOf(error)}`);
        }
      },
      setThinkingLevel: (level) => {
        const controls = runtime.controls();
        if (!controls) {
          void runtime.warn(extensionId, "setThinkingLevel() ignored: session controls unavailable.");
          return;
        }
        try {
          controls.setThinking(level);
        } catch (error) {
          void runtime.warn(extensionId, `setThinkingLevel() failed: ${messageOf(error)}`);
        }
      },
      getAllTools: () => runtime.allToolNames,
      getActiveTools: () => {
        const allow = runtime.activeToolNames;
        return allow === null ? runtime.allToolNames : runtime.allToolNames.filter((name) => allow.has(name));
      },
      setActiveTools: (names) => {
        runtime.activeToolNames = names === null ? null : new Set(names);
      },
      get hasActiveRun(): boolean {
        return runtime.run !== undefined;
      },

      // ── Harness reach ──
      newSession: (options) => runtime.viaHost(extensionId, "newSession", (host) => host.newSession(options)),
      fork: (options) => runtime.viaHost(extensionId, "fork", (host) => host.fork(options)),
      openSession: (id) => runtime.viaHost(extensionId, "openSession", (host) => host.openSession(id)),
      listSessions: () => runtime.viaHost(extensionId, "listSessions", (host) => host.listSessions()),
      registerProvider: (provider) => {
        const host = runtime.host;
        if (!host) {
          void runtime.warn(extensionId, "registerProvider() ignored: no harness host.");
          return;
        }
        host.registerProvider(provider);
      },
      unregisterProvider: (id) => {
        const host = runtime.host;
        if (!host) {
          void runtime.warn(extensionId, "unregisterProvider() ignored: no harness host.");
          return;
        }
        host.unregisterProvider(id);
      },
      // No host ⇒ report the session as idle rather than claiming a run we cannot see.
      isIdle: () => runtime.host?.isIdle() ?? runtime.run === undefined,
      waitForIdle: () => runtime.host?.waitForIdle() ?? Promise.resolve(),
    });
  }

  /**
   * Extension-originated prompts ride the `external` steer origin — they ARE an outside source
   * as far as the transcript is concerned, and reusing it keeps the persisted `PromptOrigin`
   * schema untouched. `source` names the extension so a fold can attribute the message.
   */
  private enqueue(extensionId: string, content: SteerContent, channel: SteerChannel, metadata?: Readonly<Record<string, string | number | boolean>>): SteerReceipt | undefined {
    const bus = this.session?.scope.get(T.Steer);
    if (!bus) {
      void this.warn(extensionId, `${channel === "steering" ? "steer" : "followUp"}() ignored: no steer bus.`);
      return undefined;
    }
    return bus.steer(content, {
      kind: "extension",
      extensionId,
      ...(metadata !== undefined ? { metadata } : {}),
      channel,
    });
  }

  private controls(): SessionControls | undefined {
    return this.run?.controls ?? this.session?.scope.get(T.SessionControls);
  }

  /**
   * Host-backed action wrapper. Rejects (rather than silently resolving to something fake) when
   * no host is present — these return values are session handles a caller would go on to use, so
   * a no-op would just move the failure somewhere less obvious.
   */
  private async viaHost<T>(
    extensionId: string,
    action: string,
    body: (host: ExtensionHost) => Promise<T>,
  ): Promise<T> {
    const host = this.host;
    if (!host) {
      await this.warn(extensionId, `${action}() unavailable: this extension runtime has no harness host.`);
      throw new Error(`${action}() requires a harness host`);
    }
    return body(host);
  }

  // ==========================================================================
  // Context assembly + invocation
  // ==========================================================================

  private sessionContext(extensionId: string): ExtensionSessionEventContext {
    const session = this.requireSession();
    const store = session.scope.get(T.Store);
    return {
      extensionId,
      sessionId: session.sessionId,
      signal: session.signal,
      machine: session.scope.require(T.Machine),
      store,
      state: this.stateFor(extensionId, store),
      actions: this.actionsFor(extensionId),
    };
  }

  private eventContext(extensionId: string, origin: StepOrigin): ExtensionEventContext {
    const session = this.requireSession();
    const store = session.scope.get(T.Store);
    return {
      extensionId,
      sessionId: session.sessionId,
      address: origin.address ?? "main",
      signal: origin.signal,
      machine: session.scope.require(T.Machine),
      store,
      state: this.stateFor(extensionId, store),
      actions: this.actionsFor(extensionId),
    };
  }

  /** Open-time record buckets, built ONCE off the session's shared memoized log read — the
   *  same single read goal/plan/todo fold from, so `records()` adds zero log traversals. One
   *  filter pass buckets every extension's records; ids are colon-free slugs so the
   *  "extension:<id>:" prefix parse is unambiguous. */
  private async ensureRecordSnapshot(): Promise<Map<string, ExtensionRecordEntry[]>> {
    if (this.recordSnapshot !== undefined) return this.recordSnapshot;
    const buckets = new Map<string, ExtensionRecordEntry[]>();
    const reader = this.session?.scope.get(T.SessionLog);
    const log: readonly AgentRecord[] = reader !== undefined ? await reader() : [];
    for (const record of log) {
      if (record.type !== "custom") continue;
      const full = (record as { readonly name?: unknown }).name;
      if (typeof full !== "string" || !full.startsWith("extension:")) continue;
      const rest = full.slice("extension:".length);
      const sep = rest.indexOf(":");
      if (sep <= 0) continue;
      const id = rest.slice(0, sep);
      const data = (record as { readonly data?: unknown }).data;
      const bucket = buckets.get(id) ?? [];
      if (!buckets.has(id)) buckets.set(id, bucket);
      bucket.push({ name: rest.slice(sep + 1), ...(data !== undefined ? { data } : {}) });
    }
    this.recordSnapshot = buckets;
    return buckets;
  }

  private stateFor(extensionId: string, store: SessionStore | undefined): ExtensionState {
    const prefix = `extension:${extensionId}:`;
    return {
      get: async <T>(key: string) => {
        const full = prefix + key;
        const value = store ? await store.getState(full) : this.memoryState.get(full) ?? null;
        return value as T | null;
      },
      set: async (key, value) => {
        const full = prefix + key;
        if (store) await store.putState(full, value);
        else this.memoryState.set(full, value);
      },
      delete: async (key) => {
        const full = prefix + key;
        if (store) await store.deleteState(full);
        else this.memoryState.delete(full);
      },
    };
  }

  private handlersFor<K extends ExtensionEventName>(name: K): RegisteredHandler<K>[] {
    return (this.handlers.get(name) ?? []) as unknown as RegisteredHandler<K>[];
  }

  private async invoke<K extends ExtensionEventName>(
    name: K,
    registered: RegisteredHandler<K>,
    event: ExtensionEventMap[K],
  ): Promise<ExtensionResultMap[K] | undefined> {
    const timeoutMs = registered.timeoutMs
      ?? (OBSERVE_EVENTS.has(name) ? OBSERVE_TIMEOUT_MS : DECISION_TIMEOUT_MS);
    try {
      return (await withTimeout(Promise.resolve(registered.handler(event)), timeoutMs)) as ExtensionResultMap[K];
    } catch (error) {
      await this.warn(registered.extensionId, `${name} handler failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  private async warn(extensionId: string, message: string): Promise<void> {
    const session = this.session;
    if (!session || this.reportingWarning) return;
    this.reportingWarning = true;
    try {
      await session.scope.get(T.Events)?.emit({
        type: "warning",
        message: `[extension ${extensionId}] ${message}`,
        address: "main",
        sessionId: session.sessionId,
      });
    } finally {
      this.reportingWarning = false;
    }
  }

  private requireSession(): ProvisionContext {
    if (!this.session) throw new Error("extension runtime is not attached to a session");
    return this.session;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Expand a dependency-free {@link ExtensionToolSpec} into a Tool. Args are NOT validated —
 *  the spec form has no validator by design; `execute` owns its own input checking. */
function toolFromSpec(spec: ExtensionToolSpec): Tool {
  const parameters = spec.parameters ?? { type: "object", properties: {} };
  return {
    schema: { name: spec.name, description: spec.description, parameters },
    resolve(rawArgs) {
      return {
        approvalRule: spec.approvalRule ?? spec.name,
        run: async (ctx) => normalizeSpecReturn(await spec.execute(rawArgs, ctx)),
      };
    },
  };
}

function normalizeSpecReturn(value: string | ToolResultContent | ToolResult): ToolResult {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (Array.isArray(value)) return { content: value };
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
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
