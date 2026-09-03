import type { Capability } from "operon-agents-core";
import type { ExtensionDefinition, ExtensionHost } from "./types.ts";
import { ExtensionRuntime } from "./runtime.ts";
import { HT } from "../tokens.ts";

export { ExtensionRuntime } from "./runtime.ts";
export { ExtensionLoader, createExtensionLoader } from "./loader.ts";
export { ServiceRegistry, ServiceUnavailableError, deadServiceHandle } from "./services.ts";
export { HarnessExtensionManager, stageDefinition, assertOneSharedHalf } from "./manager.ts";
export type { ExtensionHostBridge, StagingOptions, HeldSession, StagedDefinition } from "./manager.ts";
export type { ServiceOptions, ServiceTier, ServiceUnavailableReason } from "./services.ts";
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
  ExtensionWorkspaceContext,
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

/**
 * Build one isolated, session-scoped runtime for programmatic extensions.
 *
 * Every decision point in the extension contract is a `LoopHooks` slot — that is the only
 * channel where a handler's return value can reach the loop. Observation does NOT come through
 * here: observation goes through `api.onEvent`, which passes the session's event stream straight
 * through (with fault isolation and teardown), rather than through this hook table.
 */
export function extensionsCapability(
  definitions: readonly ExtensionDefinition[],
  options: { readonly host?: ExtensionHost; readonly params?: Readonly<Record<string, unknown>> } = {},
): Capability {
  const runtime = new ExtensionRuntime(definitions, options.host, options.params);
  return {
    name: "extensions",
    provides: [
      {
        token: HT.Extensions,
        create: async (ctx) => {
          await runtime.open(ctx);
          return runtime;
        },
        dispose: () => runtime.close(),
      },
    ],
    toolProviders: [{ id: "extensions", listTools: () => runtime.listTools() }],
    toolFilters: [runtime.filterTools],
    gates: { compaction: runtime.compactionGate },
    // Stable array reference — `session` (the provision's `harness`) fills it before any run assembles.
    injectors: runtime.listInjectors(),
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
}
