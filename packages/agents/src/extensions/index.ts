import { readSessionLog, type Capability } from "operon-agents-core";
import type { ExtensionDefinition, ExtensionHost, SessionStartReason } from "./types.ts";
import { ExtensionRuntime } from "./runtime.ts";

export { ExtensionRuntime } from "./runtime.ts";
export { ExtensionLoader, createExtensionLoader } from "./loader.ts";
export { ServiceRegistry, ServiceUnavailableError, deadServiceHandle } from "./services.ts";
export { HarnessExtensionManager, stageDefinition } from "./manager.ts";
export type { ExtensionHostBridge, StagingOptions, HeldSession, StagedDefinition } from "./manager.ts";
export type { ServiceOptions, ServiceUnavailableReason } from "./services.ts";
export type { ExtensionManifest, ExtensionFileState, ExtensionFileStatus, ExtensionAttachTarget } from "./loader.ts";
export type {
  ExtensionActions,
  ExtensionAPI,
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionRecordEntry,
  ExtensionSteerOptions,
  ExtensionDefinition,
  ExtensionHostContext,
  ExtensionEventContext,
  ExtensionEventMap,
  ExtensionEventName,
  ExtensionHandler,
  ExtensionHost,
  ExtensionModelRequestEvent,
  ExtensionModelRequestResult,
  ExtensionModelResponseEvent,
  ExtensionResultMap,
  ExtensionRunSettledEvent,
  ExtensionRunSettledResult,
  ExtensionRunStartEvent,
  ExtensionRunStartResult,
  ExtensionSessionContext,
  ExtensionSessionEventContext,
  ExtensionSessionEndEvent,
  ExtensionSessionStartEvent,
  ExtensionState,
  ExtensionToolSpec,
  ExtensionStepEndEvent,
  ExtensionStepEndResult,
  ExtensionStepStartEvent,
  ExtensionStepStartResult,
  ExtensionToolAuthorizeEvent,
  ExtensionToolAuthorizeResult,
  ExtensionToolCallEvent,
  ExtensionToolCallResult,
  ExtensionToolResultEvent,
  ExtensionCompactionBeforeEvent,
  ExtensionCompactionBeforeResult,
  ExtensionProviderHeadersEvent,
  ExtensionProviderHeadersResult,
  ExtensionProviderPayloadEvent,
  ExtensionProviderPayloadResult,
  ExtensionProviderResponseEvent,
  ProviderHeaders,
  HarnessSessionHandle,
  ModelProvider,
  SessionEndReason,
  SessionStartReason,
} from "./types.ts";

/** The runtime behind each extension capability — how the harness reaches an extension it mounted. */
const runtimes = new WeakMap<Capability, ExtensionRuntime>();

/** The extension runtime behind `capability`, or undefined when it is not an extension. */
export function extensionRuntimeOf(capability: Capability): ExtensionRuntime | undefined {
  return runtimes.get(capability);
}

/**
 * One extension, as one of the session's capabilities — named by its id, `detachable`, and
 * assembled, isolated, attached and detached exactly like any other capability.
 *
 * Every decision point in the extension contract is a `LoopHooks` slot — that is the only
 * channel where a handler's return value can reach the loop. Observation does NOT come through
 * here: observation goes through `api.onEvent`, which passes the session's event stream straight
 * through (with fault isolation and teardown), rather than through this hook table.
 */
export function extensionCapability(
  definition: ExtensionDefinition,
  options: { readonly host?: ExtensionHost; readonly params?: unknown; readonly startReason?: SessionStartReason } = {},
): Capability {
  const runtime = new ExtensionRuntime(definition, options);
  const capability: Capability = {
    name: definition.id,
    contract: "detachable",
    // The runtime already gives every handler its own budget (`timeoutMs`) and isolates its
    // failure; an outer deadline would only cut a chain of individually-healthy handlers short.
    hookTimeoutMs: Number.POSITIVE_INFINITY,
    // Read once the extension has opened: what it published with `api.expose`, so
    // `session.service(id)` is the extension's own control surface.
    get service() {
      return runtime.exposedHandle();
    },
    // An extension can touch the whole session surface, so this list IS the blast radius —
    // written down once, here, instead of discovered by reading the runtime for lookups.
    openSession: async (ctx) => {
      if (ctx.controls === undefined) throw new Error("an extension needs the session's controls");
      await runtime.open(
        {
          environment: ctx.environment,
          events: ctx.events,
          steer: ctx.steer,
          controls: ctx.controls,
          readLog: () => readSessionLog(ctx),
          store: ctx.store,
        },
        ctx,
      );
    },
    closeSession: (reason) => runtime.close(reason),
    toolProviders: [{ id: definition.id, listTools: () => runtime.listTools() }],
    toolFilters: [runtime.filterTools],
    gates: { compaction: runtime.compactionGate },
    // Stable array references — `session` fills them before any run assembles.
    injectors: runtime.listInjectors(),
    commands: runtime.commands,
    // Read at each run's assembly: absent while no provider-tier handler is registered, so such a
    // request is left byte-identical.
    get provider() {
      return runtime.hasProviderHandlers() ? runtime.providerHooks : undefined;
    },
    hooks: {
      beforeRun: async (ctx) => runtime.beforeRun(ctx, ctx.input),
      beforeStep: async (ctx) => runtime.beforeStep(ctx, ctx.context, ctx.system),
      afterStep: async (ctx) => runtime.afterStep(ctx, ctx.context, ctx.usage, ctx.stopReason),
      shouldContinueAfterStop: async (ctx) => runtime.runSettled(ctx, ctx.usage, ctx.stopReason),
      beforeModelRequest: async (ctx) => runtime.beforeModelRequest(ctx, ctx.request, ctx.context),
      afterModelResponse: async (ctx) => runtime.afterModelResponse(ctx, ctx.request, ctx.response, ctx.context),
      prepareToolExecution: async (ctx) =>
        runtime.beforeToolCall(ctx, ctx.toolCall.name, ctx.toolCall.id, ctx.tool, ctx.args),
      authorizeToolExecution: async (ctx) =>
        runtime.authorizeToolCall(ctx, ctx.toolCall.name, ctx.toolCall.id, ctx.tool, ctx.args, ctx.plan),
      finalizeToolResult: async (ctx) =>
        runtime.afterToolResult(ctx, ctx.toolCall.name, ctx.toolCall.id, ctx.tool, ctx.args, ctx.result),
    },
    start: (ctx) => runtime.attachRun(ctx),
    stop: () => runtime.detachRun(),
  };
  runtimes.set(capability, runtime);
  return capability;
}

/**
 * A capability per extension, in order — what a session mounts for a list of definitions. A
 * definition this session opted out of (`params[id] === false`) is left out entirely: never set
 * up, never reported as attached.
 */
export function extensionsCapability(
  definitions: readonly ExtensionDefinition[],
  options: { readonly host?: ExtensionHost; readonly params?: Readonly<Record<string, unknown>> } = {},
): Capability[] {
  const seen = new Set<string>();
  const out: Capability[] = [];
  for (const definition of definitions) {
    if (seen.has(definition.id)) throw new Error(`duplicate extension id "${definition.id}"`);
    seen.add(definition.id);
    const params = options.params?.[definition.id];
    if (params === false) continue;
    out.push(extensionCapability(definition, { ...(options.host !== undefined ? { host: options.host } : {}), params }));
  }
  return out;
}
