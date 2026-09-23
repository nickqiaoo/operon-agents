import type { Environment, EventSink, SteerBus } from "operon-agents-core";
import { ServiceUnavailableError, isProbeProperty } from "./services.ts";
import type { AgentRecord, HeadlessCommand } from "operon-agents-core";
import type {
  AssistantMessage,
  CapabilityProviderHooks,
  ProviderHookContext,
  RunContext,
  CompactionGate,
  ChatModel,
  ConversationContext,
  Injector,
  LlmRequest,
  Message,
  SessionContext,
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
import { tagToolSource } from "operon-agents-core";
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

/**
 * The session services the extensions capability declares (see `extensionsCapability`). Named
 * here because this is where they are used; the declaration that fills it lives next to the
 * capability, so the two can be checked against each other by eye.
 */
export interface ExtensionServices {
  readonly environment: Environment;
  readonly events: EventSink;
  readonly steer: SteerBus;
  readonly controls: SessionControls;
  readonly readLog: () => Promise<readonly AgentRecord[]>;
  readonly store: SessionStore | undefined;
}

/**
 * One extension, running in one session. `extensionCapability` wraps it as that session's
 * capability, so everything around the extension — assembly, hook isolation, attach and detach
 * at a run boundary, its state and records — is the engine's, the same as for any capability.
 * What is left here is the translation the extension API exists for: `api` registrations into
 * capability parts, and the engine's decision points into the extension's event vocabulary.
 */
export class ExtensionRuntime {
  readonly definition: ExtensionDefinition;
  private readonly handlers = new Map<ExtensionEventName, RegisteredHandler[]>();
  private readonly tools = new Map<string, Tool>();
  /** Stable reference: `extensionCapability` hands this array to the assembler, and `session`
   *  (which runs at openSession, before any run assembles) fills it in place. */
  private readonly injectors: Injector[] = [];
  /** Slash commands, filled in place by `api.registerCommand` — the capability's `commands`. */
  readonly commands: HeadlessCommand[] = [];
  /** The host-facing control surface published via `api.expose`. */
  private exposed: unknown;
  /** `session()`'s cleanup plus every registration, undone in reverse. */
  private teardown: (() => void | Promise<void>) | undefined;
  /** False until `session` has run, and again once the extension is closed: every `actions` /
   *  `api` closure it still holds turns into a warn-and-noop — a detached extension must not
   *  keep steering the session. */
  private live = false;
  /** The session binding: the services the capability DECLARED, plus the session's id/signal. */
  private session: (SessionContext & ExtensionServices) | undefined;
  private run: RunContext | undefined;
  /** The conversation shard the in-flight decision point belongs to — the address a
   *  `compaction.before` handler is told about. */
  private activeContext: ConversationContext | undefined;
  /** Snapshot of the last assembled registry, refreshed once per turn by `filterTools`. */
  private allToolNames: readonly string[] = [];
  /** `null` = unrestricted. Set by `actions.setActiveTools`; applied at the next assembly. */
  private activeToolNames: ReadonlySet<string> | null = null;
  private reportingWarning = false;

  /** Harness reach. Absent when the capability is built standalone (bare Runner / tests). */
  private readonly host: ExtensionHost | undefined;
  /** This session's argument for the extension (`createSession({ params: { [id]: … } })`). */
  private readonly params: unknown;
  /** What `session.start` reports: `attach` for an extension added to a live session. */
  private readonly startReason: SessionStartReason;

  constructor(
    definition: ExtensionDefinition,
    options: { readonly host?: ExtensionHost; readonly params?: unknown; readonly startReason?: SessionStartReason } = {},
  ) {
    if (!definition.id.trim()) throw new Error("extension id must not be empty");
    // Slug only, colons forbidden: records and state scope by the "extension:<id>:" prefix,
    // so an id containing ":" would make one extension's bucket swallow another's.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(definition.id)) {
      throw new Error(`extension id "${definition.id}" must be a slug ([A-Za-z0-9_.-], no colons)`);
    }
    this.definition = definition;
    this.host = options.host;
    this.params = options.params;
    this.startReason = options.startReason ?? "open";
  }

  get id(): string {
    return this.definition.id;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Run `session` and fire `session.start`. Throws when `session` does — the capability is then
   *  absent from the session, with nothing it registered left behind. */
  async open(services: ExtensionServices, ctx: SessionContext): Promise<void> {
    this.session = { ...ctx, ...services };
    if (!(await this.setupExtension(this.definition))) throw new Error(`extension "${this.id}" session() failed`);
    for (const registered of [...this.handlersFor("session.start")]) {
      await this.invoke("session.start", registered, { ...this.sessionContext(this.id), reason: this.startReason });
    }
    if (this.startReason === "attach") await this.logChange("attached");
  }

  attachRun(ctx: RunContext): void {
    this.run = ctx;
  }

  detachRun(): void {
    this.run = undefined;
    this.activeContext = undefined;
  }

  /** Fire `session.end` while the handlers are still registered, then unwind everything. */
  async close(reason: SessionEndReason = "close"): Promise<void> {
    if (this.session && this.live) {
      for (const registered of [...this.handlersFor("session.end")]) {
        await this.invoke("session.end", registered, { ...this.sessionContext(this.id), reason });
      }
    }
    this.live = false;
    const teardown = this.teardown;
    this.teardown = undefined;
    if (teardown) {
      try {
        await teardown();
      } catch (error) {
        await this.warn(this.id, `teardown failed: ${messageOf(error)}`);
      }
    }
    if (reason === "detach") await this.logChange("detached");
    this.commands.length = 0;
    this.exposed = undefined;
    this.injectors.length = 0;
    // The session binding stays: a closure the extension stashed must still be able to say, into
    // the event stream, that it was ignored because the extension is gone.
  }

  /** The control surface published via `api.expose`; undefined when nothing is (or it was
   *  disposed, or the extension is closed). */
  exposedHandle<T = unknown>(): T | undefined {
    return this.exposed as T | undefined;
  }

  /** Runs one extension's `session` and files its scope. Failure ⇒ skipped, contributions undone. */
  private async setupExtension(definition: ExtensionDefinition): Promise<boolean> {
    const params = this.params;
    // A definition with a shared half reaches a session only after that half ran — the harness
    // ran `harness` once and registered the result under the id. Not registered ⇒ it was handed
    // to a session directly instead of being registered — a programming error, so it throws
    // rather than being skipped.
    const sharedHalf = definition.harness !== undefined;
    if (sharedHalf && this.host?.services?.has(definition.id) !== true) {
      throw new Error(
        `extension "${definition.id}" has a shared half but no service "${definition.id}" is reachable from this session — its harness half never ran. Register it in createHarness({ extensions }) or load it from extensionDir; a definition with a shared half cannot be handed to a session directly`,
      );
    }
    const shared = sharedHalf ? this.serviceHandle(definition.id, definition.id) : undefined;
    const registrations: Array<() => void> = [];
    this.live = true;
    try {
      // `uses`: checked at registration, re-checked here (a provider may have unloaded since)
      // and handed in resolved — an extension never looks a service up by name.
      const services: Record<string, unknown> = {};
      for (const name of definition.uses ?? []) {
        if (this.host?.services?.has(name) !== true) throw new Error(`uses "${name}": no such service is registered`);
        services[name] = this.serviceHandle(definition.id, name);
      }
      const teardown = await definition.session(this.apiFor(definition, registrations), { shared, params, services });
      this.teardown = async () => {
        if (teardown) await teardown();
        for (const dispose of [...registrations].reverse()) dispose();
      };
      return true;
    } catch (error) {
      this.live = false;
      for (const dispose of [...registrations].reverse()) dispose();
      await this.warn(definition.id, `session() failed; extension skipped: ${messageOf(error)}`);
      return false;
    }
  }

  /**
   * Durable audit trail: replay needs "tool X only exists after record N" to reconstruct the
   * capability timeline. Rides the `custom` record type — audit-only, ignored by reducers.
   */
  private async logChange(kind: "attached" | "detached"): Promise<void> {
    const extensionId = this.id;
    const store = this.session?.store;
    if (!store) return;
    try {
      await store.appendRecord({ type: "custom", name: `extensions.${kind}`, data: { extensionId } });
    } catch (error) {
      await this.warn(extensionId, `failed to journal extension ${kind}: ${messageOf(error)}`);
    }
  }

  listTools(): readonly Tool[] {
    return [...this.tools.values()];
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
    return changed ? { request: current } : undefined;
  }

  /**
   * The capability's provider hooks — `provider.headers` / `payload` / `response`. The engine
   * composes them into the request with every other capability's, so two extensions rewriting
   * headers both take effect instead of the second replacing the first. They fire once per HTTP
   * ATTEMPT, so a retry re-runs them — the contract tells handlers to be idempotent, and the
   * runtime does not try to dedupe on their behalf.
   */
  readonly providerHooks: CapabilityProviderHooks = {
    headers: async (headers, ctx) => {
      let current = headers;
      for (const registered of this.handlersFor("provider.headers")) {
        const result = await this.invoke("provider.headers", registered, { ...this.providerContext(ctx), headers: current });
        if (result?.headers !== undefined) current = result.headers;
      }
      return current;
    },
    payload: async (payload, ctx) => {
      let current = payload;
      let changed = false;
      for (const registered of this.handlersFor("provider.payload")) {
        const result = await this.invoke("provider.payload", registered, { ...this.providerContext(ctx), payload: current });
        if (result !== undefined && "payload" in result) {
          current = result.payload;
          changed = true;
        }
      }
      return changed ? { payload: current } : undefined;
    },
    response: async (response, ctx) => {
      for (const registered of this.handlersFor("provider.response")) {
        await this.invoke("provider.response", registered, { ...this.providerContext(ctx), status: response.status, headers: response.headers });
      }
    },
  };

  /** Whether any provider-tier handler is registered — the capability omits `provider` otherwise,
   *  so a request with no provider-tier extension is left byte-identical. */
  hasProviderHandlers(): boolean {
    return this.handlersFor("provider.headers").length + this.handlersFor("provider.payload").length + this.handlersFor("provider.response").length > 0;
  }

  private providerContext(ctx: ProviderHookContext): ExtensionEventContext & { readonly turnId: string; readonly stepNumber: number } {
    const session = this.requireSession();
    return {
      ...this.eventContext(this.id, { ...(ctx.address !== undefined ? { address: ctx.address } : {}), signal: session.signal }),
      turnId: ctx.turnId,
      stepNumber: ctx.stepNumber,
    };
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
        if (!this.live) {
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
        if (!this.live) {
          void this.warn(definition.id, "onEvent() ignored: extension is detached.");
          return () => undefined;
        }
        // `session` runs inside `open`, so the session context is already in place.
        const sink = this.session?.events;
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
        if (!this.live) {
          void this.warn(definition.id, `registerTool("${tool.schema.name}") ignored: extension is detached.`);
          return () => undefined;
        }
        const name = tool.schema.name;
        if (this.tools.has(name)) throw new Error(`extension "${definition.id}" registered tool "${name}" twice`);
        this.tools.set(name, tool);
        // Core's toolset assembly reads this tag to fail a collision with ANOTHER capability's
        // tool closed, naming us.
        tagToolSource(tool, definition.id);
        const dispose = () => {
          if (this.tools.get(name) === tool) this.tools.delete(name);
        };
        registrations.push(dispose);
        return dispose;
      },
      registerInjector: (injector) => {
        if (!this.live) {
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
        if (!this.live) {
          void this.warn(definition.id, `registerCommand("/${command.name}") ignored: extension is detached.`);
          return () => undefined;
        }
        const key = command.name.trim().toLowerCase();
        if (this.commands.some((existing) => existing.name.trim().toLowerCase() === key)) {
          throw new Error(`extension "${definition.id}" registered command "/${key}" twice`);
        }
        const headless: HeadlessCommand = {
          name: command.name,
          ...(command.aliases !== undefined ? { aliases: command.aliases } : {}),
          description: command.description,
          run: async (_ctx, args) => command.run(args),
        };
        this.commands.push(headless);
        const dispose = () => {
          const index = this.commands.indexOf(headless);
          if (index >= 0) this.commands.splice(index, 1);
        };
        registrations.push(dispose);
        return dispose;
      },
      emitEvent: (name, data) => {
        if (!this.live) {
          void this.warn(definition.id, `emitEvent("${name}") ignored: extension is detached.`);
          return;
        }
        const session = this.session;
        if (!session) {
          void this.warn(definition.id, `emitEvent("${name}") ignored: no open session.`);
          return;
        }
        void session.events.emit({
          address: "main",
          sessionId: session.sessionId,
          type: "extension",
          extensionId: definition.id,
          name,
          ...(data !== undefined ? { data } : {}),
        });
      },
      expose: (handle) => {
        if (!this.live) {
          void this.warn(definition.id, "expose() ignored: extension is detached.");
          return () => undefined;
        }
        this.exposed = handle;
        const dispose = () => {
          if (this.exposed === handle) this.exposed = undefined;
        };
        registrations.push(dispose);
        return dispose;
      },
      // The engine keeps both, partitioned by this capability's name — the extension's id.
      records: () => this.requireSession().records(),
      state: {
        get: (key) => this.requireSession().state.get(key),
        set: (key, value) => this.requireSession().state.set(key, value),
        delete: (key) => this.requireSession().state.delete(key),
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
        if (!runtime.live) return dead();
        const inner = (services.handle(name) as Record<string, unknown>)[prop as string];
        if (typeof inner !== "function") return inner;
        return (...args: unknown[]) => {
          if (!runtime.live) return dead()();
          return (inner as (...a: unknown[]) => unknown)(...args);
        };
      },
      // Forward `in` so consumers can probe registration ("route" in handle) through the
      // collar; a detached extension's probe reads false like a dead handle's.
      has: (_target, prop) => {
        if (!runtime.live) return false;
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
        if (typeof value !== "function" || runtime.live) return value;
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
      // Journaled by the engine into the main conversation as `extension:<id>:<name>`, and seen
      // by `records()` straight away.
      record: (name, data) => {
        const session = runtime.session;
        if (!session) {
          void runtime.warn(extensionId, `record("${name}") ignored: no open session.`);
          return;
        }
        session.record(name, data);
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
    const bus = this.session?.steer;
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
    return this.run?.controls ?? this.session?.controls;
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
    const store = session.store;
    return {
      extensionId,
      sessionId: session.sessionId,
      signal: session.signal,
      environment: session.environment,
      store,
      state: session.state,
      actions: this.actionsFor(extensionId),
    };
  }

  private eventContext(extensionId: string, origin: Pick<StepOrigin, "address" | "signal">): ExtensionEventContext {
    const session = this.requireSession();
    const store = session.store;
    return {
      extensionId,
      sessionId: session.sessionId,
      address: origin.address ?? "main",
      signal: origin.signal,
      environment: session.environment,
      store,
      state: session.state,
      actions: this.actionsFor(extensionId),
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
      await session.events.emit({
        type: "warning",
        message: `[extension ${extensionId}] ${message}`,
        address: "main",
        sessionId: session.sessionId,
      });
    } finally {
      this.reportingWarning = false;
    }
  }

  private requireSession(): SessionContext & ExtensionServices {
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
