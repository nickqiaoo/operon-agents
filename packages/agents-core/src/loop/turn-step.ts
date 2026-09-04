import type { ChatModel } from "../llm/define-model.ts";
import type { CallOptions, LlmRequest } from "../llm/model.ts";
import type { AssistantMessage, AssistantMessageEvent, Usage } from "../protocol/index.ts";
import type { ConversationContext } from "./context.ts";
import type { Tool } from "../tool/types.ts";
import type { Machine } from "../tool/machine.ts";
import type { FileFreshnessLedger } from "../tool/file-freshness.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import type { QuestionResponder } from "../tool/questions.ts";
import type { Logger } from "../logging/index.ts";
import { runToolCallBatch } from "./tool-call.ts";
import { streamWithRetry } from "../llm/retry.ts";
import { APIContextOverflowError, isContextOverflowMessage } from "../llm/errors.ts";
import type { LoopEventDispatcher } from "./events.ts";
import type { HandoffSignal, LoopHooks, OutputGuardrailMonitorFactory, PendingInterrupt, StepStopReason } from "./types.ts";
import type { ToolCallSuspension } from "./interruption.ts";
import { activeDeferredTools } from "../tool/search/activation.ts";

export interface RecordUsageResult {
  readonly stopTurn?: boolean;
}

export interface ExecuteStepDeps {
  readonly turnId: string;
  readonly address?: string;
  /**
   * Identifies this conversation line to the provider, for prompt-cache affinity. Not a
   * user-facing knob — the loop stamps it so repeat requests with the same prefix land on the
   * same backend (Anthropic `x-session-affinity`, OpenAI `prompt_cache_key`).
   */
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  readonly model: ChatModel;
  readonly machine: Machine;
  readonly background?: BackgroundSpawner;
  /** Client interactive-question channel; forwarded to tool contexts (AskUserQuestion). */
  readonly responder?: QuestionResponder;
  /** Session-scoped file freshness ledger for this agent line; forwarded to tool contexts. */
  readonly fileLedger?: FileFreshnessLedger;
  readonly system?: string;
  readonly params?: LlmRequest["params"];
  readonly context: ConversationContext;
  /** Complete execution registry; projected after beforeStep (which may compact). */
  readonly tools: readonly Tool[];
  readonly deferredToolNames: ReadonlySet<string>;
  readonly hooks?: LoopHooks;
  readonly createOutputGuardrailMonitor?: OutputGuardrailMonitorFactory;
  readonly currentStep: number;
  readonly maxRetriesPerStep?: number;
  readonly recordUsage: (usage: Usage) => RecordUsageResult | void | Promise<RecordUsageResult | void>;
  /** Unified loop event sink — model stream, tool results, retries, dropped partials. */
  readonly dispatchEvent?: LoopEventDispatcher;
  readonly logger?: Logger;
}

export interface StepResult {
  readonly usage: Usage;
  readonly stopReason: StepStopReason;
  readonly pending?: readonly PendingInterrupt[];
  readonly suspensions?: readonly ToolCallSuspension[];
  readonly handoff?: HandoffSignal;
}

export async function executeStep(deps: ExecuteStepDeps): Promise<StepResult> {
  const { turnId, signal, model, currentStep, hooks } = deps;
  const messages = deps.context.messages; // backing array (reads/slices share this ref)

  // Step-local system prompt: a hook may replace it for THIS request only. `deps.system` stays
  // the agent-resolved value, so the next step starts from the agent again rather than
  // accumulating rewrites.
  let system = deps.system;
  if (hooks?.beforeStep) {
    const before = await hooks.beforeStep({
      turnId,
      stepNumber: currentStep,
      address: deps.address,
      signal,
      model,
      messages,
      context: deps.context,
      system,
    });
    if (before?.block === true) {
      throw new Error(before.reason ?? `step ${currentStep} was blocked`);
    }
    if (before?.system !== undefined) system = before.system;
  }
  signal.throwIfAborted();

  // Compaction runs in beforeStep. Recompute afterwards so full compaction
  // unloads removed load points immediately, while a SearchTool result from the
  // preceding step activates its schemas for this request.
  const activeTools = activeDeferredTools(
    deps.tools,
    deps.deferredToolNames,
    messages,
  );
  const toolSchemas = activeTools.map((tool) => tool.schema);
  const toolMap = new Map<string, Tool>(
    activeTools.map((tool) => [tool.schema.name, tool]),
  );
  let request: LlmRequest = {
    system,
    messages,
    tools: toolSchemas.length > 0 ? toolSchemas : undefined,
    ...(deps.params ? { params: deps.params } : {}),
    // Per conversation line, not per session: each address carries its own prefix, so keying
    // them apart is what actually helps the cache. Seeded here rather than merged, so an
    // extension returning its own `providerOptions` from `beforeModelRequest` stays in control.
    ...(deps.sessionId !== undefined
      ? { providerOptions: { sessionId: `${deps.sessionId}:${deps.address ?? "main"}` } }
      : {}),
  };
  if (hooks?.beforeModelRequest) {
    const beforeModel = await hooks.beforeModelRequest({
      turnId,
      stepNumber: currentStep,
      address: deps.address,
      signal,
      model,
      request,
      context: deps.context,
    });
    if (beforeModel?.block === true) {
      throw new Error(beforeModel.reason ?? `model request for step ${currentStep} was blocked`);
    }
    if (beforeModel?.request !== undefined) request = beforeModel.request;
  }
  signal.throwIfAborted();
  const stepId = `${turnId}.${currentStep}`;
  const outputGuardrail = deps.createOutputGuardrailMonitor?.({
    turnId,
    step: currentStep,
    stepId,
    signal,
  });
  const call: CallOptions = { signal: outputGuardrail?.signal ?? signal };
  deps.dispatchEvent?.({ type: "turn.step.started", turnId, step: currentStep, stepId });
  // The final request, after both hooks — the only place the system prompt reaches the stream.
  // `messages` is snapshotted: `request.messages` may alias the live context array, which this
  // very step appends to below.
  deps.dispatchEvent?.({
    type: "model.request",
    turnId,
    step: currentStep,
    stepId,
    ...(request.system !== undefined ? { system: request.system } : {}),
    messages: [...request.messages],
    toolNames: (request.tools ?? []).map((tool) => tool.name),
    ...(request.params !== undefined ? { params: request.params } : {}),
  });

  let message!: AssistantMessage;
  let stopReason!: StepStopReason;
  let stopTurnAfterUsage = false;
  try {
    const retryResult = await streamWithRetry({
      model,
      request,
      call,
      logger: deps.logger,
      maxRetries: deps.maxRetriesPerStep,
      // Optimistic policy: surface the delta first, then let the monitor inspect it in the
      // background. A tripwire aborts `call.signal`; the final message is held below.
      onEvent: (event) => {
        emitStreamEvent(deps, turnId, currentStep, event);
        if (event.type === "text_delta") outputGuardrail?.observeTextDelta(event.delta);
      },
      onRetrying: (event) =>
        deps.dispatchEvent?.({
          type: "turn.step.retrying",
          turnId,
          step: currentStep,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          reason: event.reason,
        }),
      onReset: (event) => {
        outputGuardrail?.reset();
        deps.dispatchEvent?.({
          type: "turn.step.reset",
          turnId,
          step: currentStep,
          stepId,
          discardedAttempt: event.discardedAttempt,
          nextAttempt: event.nextAttempt,
          reason: event.reason,
        });
      },
      // A dropped failed attempt is a transcript record, not an event (#8) — replay must not resurrect it.
      onDropPartial: (failed) => deps.context.record({ type: "custom", name: "dropped_partial", data: failed }),
    });
    message = retryResult.message;
    if (hooks?.afterModelResponse) {
      try {
        message =
          (await hooks.afterModelResponse({
            turnId,
            stepNumber: currentStep,
            address: deps.address,
            signal,
            model,
            request,
            response: message,
            context: deps.context,
          })) ?? message;
      } catch {
        // The provider response already exists. Observer/transform failures are isolated.
      }
    }
    stopReason = mapModelStopReason(retryResult.stopReason);

    // A context overflow is not a step outcome: journaling the error message would feed the
    // already-oversized history PLUS a garbage assistant message to every later request. Keep
    // the failed message as a transcript record (same discipline as dropped_partial — replay
    // must not resurrect it) and surface an exception so the turn loop can consult
    // `recoverStepError` (compaction claims it, and the step re-runs on the compacted context).
    // The adapter reduced the transport error to a message string, hence the text match and
    // the synthetic status code 0.
    if (stopReason === "error" && isContextOverflowMessage(message.errorMessage ?? "")) {
      deps.context.record({ type: "custom", name: "overflow_dropped", data: message });
      throw new APIContextOverflowError(0, message.errorMessage ?? "context overflow", null);
    }

    // Preserve usage even when an optimistic/final output guardrail rejects the message.
    const usageResult = await deps.recordUsage(message.usage);
    stopTurnAfterUsage = usageResult?.stopTurn === true;
    const effectiveStop = stopTurnAfterUsage && stopReason === "tool_use" ? "end_turn" : stopReason;
    await outputGuardrail?.finish(assistantText(message), effectiveStop === "end_turn", message.usage);
  } catch (error) {
    try {
      await outputGuardrail?.settle();
    } catch (guardrailError) {
      throw guardrailError;
    }
    throw error;
  } finally {
    outputGuardrail?.dispose();
  }

  deps.dispatchEvent?.({ type: "turn.step.completed", turnId, step: currentStep, stepId, usage: message.usage, finishReason: stopReason });

  // Enters live history, journaled to the log — and the journal is what broadcasts
  // `message.appended` (see ConversationContext.onHistoryChange), so there is no paired
  // emit here to forget.
  deps.context.appendMessage(message);

  let effectiveStopReason: StepStopReason = stopTurnAfterUsage && stopReason === "tool_use" ? "end_turn" : stopReason;
  let handoff: HandoffSignal | undefined;

  if (effectiveStopReason === "tool_use") {
    const batch = await runToolCallBatch(
      { turnId, stepNumber: currentStep, address: deps.address, signal, model, machine: deps.machine, background: deps.background, responder: deps.responder, fileLedger: deps.fileLedger, tools: toolMap, hooks, dispatchEvent: deps.dispatchEvent, logger: deps.logger },
      message,
    );

    // Each toolResult enters history and is surfaced via `message.appended` (by the journal),
    // parallel to — not replacing — the `tool.result` runtime event from the tool-call layer.
    for (const result of batch.results) deps.context.appendMessage(result);
    if ((batch.pending && batch.pending.length > 0) || (batch.suspensions && batch.suspensions.length > 0)) {
      return {
        usage: message.usage,
        stopReason: "interrupt",
        pending: batch.pending,
        suspensions: batch.suspensions,
      };
    }
    if (batch.stopTurn) effectiveStopReason = "end_turn";
    // A handoff ends this agent's turn; the Runner switches the active agent.
    if (batch.handoff) {
      effectiveStopReason = "handoff";
      handoff = batch.handoff;
    }
  }

  signal.throwIfAborted();

  let stopTurnAfterStep = stopTurnAfterUsage;
  if (hooks?.afterStep) {
    try {
      const after = await hooks.afterStep({
        turnId,
        stepNumber: currentStep,
        address: deps.address,
        usage: message.usage,
        stopReason: effectiveStopReason,
        signal,
        model,
        messages,
        context: deps.context,
        system,
      });
      stopTurnAfterStep = stopTurnAfterStep || after?.stopTurn === true;
    } catch {
      // The step is already sealed; observer hooks cannot change the result.
    }
  }

  return {
    usage: message.usage,
    stopReason: stopTurnAfterStep && effectiveStopReason === "tool_use" ? "end_turn" : effectiveStopReason,
    handoff,
  };
}

/** Decompose an `AssistantMessageEvent` into the framework's own events. */
function emitStreamEvent(deps: ExecuteStepDeps, turnId: string, step: number, event: AssistantMessageEvent): void {
  const dispatch = deps.dispatchEvent;
  if (dispatch === undefined) return;
  switch (event.type) {
    case "text_delta":
      dispatch({ type: "assistant.delta", turnId, delta: event.delta });
      break;
    case "text_end":
      dispatch({ type: "content.part", turnId, step, part: { type: "text", text: event.content } });
      break;
    case "thinking_delta":
      dispatch({ type: "thinking.delta", turnId, delta: event.delta });
      break;
    case "thinking_end":
      dispatch({ type: "content.part", turnId, step, part: { type: "thinking", thinking: event.content } });
      break;
    case "toolcall_start": {
      const tc = toolCallAt(event.partial, event.contentIndex);
      if (tc) dispatch({ type: "tool.call.delta", turnId, toolCallId: tc.id, toolName: tc.name, argumentsPart: "" });
      break;
    }
    case "toolcall_delta": {
      const tc = toolCallAt(event.partial, event.contentIndex);
      if (tc) dispatch({ type: "tool.call.delta", turnId, toolCallId: tc.id, argumentsPart: event.delta });
      break;
    }
    // `start`/`text_start`/`thinking_start`/`toolcall_end`/`done`/`error`: no live event —
    // step boundaries and the final message are surfaced by turn.step.* and message.appended.
    default:
      break;
  }
}

/** The tool call sitting at `contentIndex` of an assistant message snapshot, if any. */
function toolCallAt(message: AssistantMessage, contentIndex: number): { id: string; name: string } | undefined {
  const part = message.content?.[contentIndex];
  return part?.type === "toolCall" ? part : undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is import("../protocol/index.ts").TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * pi's stop reason → ours. Exhaustive on purpose: when pi adds a reason, this stops compiling
 * rather than silently falling through to a wrong outcome.
 *
 * `pending` and `deferred` both arrive as terminal reasons we cannot honor, and both fail
 * closed to `error`:
 *
 * - `pending` marks a PARTIAL streaming message. Seeing it as terminal means the stream ended
 *   mid-message; treating it as `end_turn` would present a truncated answer as complete.
 * - `deferred` means the provider parked the request behind a `DeferredHandle` to be polled
 *   later. We never request that mode and have no polling path, so the message carries no
 *   content — an `end_turn` here would look like the model answered with silence.
 */
function mapModelStopReason(reason: AssistantMessage["stopReason"]): StepStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "tool_use";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    case "pending":
    case "deferred":
      return "error";
  }
}
