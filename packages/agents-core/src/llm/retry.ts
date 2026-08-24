import type { ChatModel } from "./define-model.ts";
import { streamResult } from "./model.ts";
import type { CallOptions, LlmRequest } from "./model.ts";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../protocol/index.ts";
import { type Logger, logDataPolicy, noopLogger } from "../logging/index.ts";

export const DEFAULT_MAX_RETRIES_PER_STEP = 3;
const BASE_DELAY_MS = 300;
const MAX_BACKOFF_MS = 32_000;

export interface StepRetryingEvent {
  readonly type: "step_retrying";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason?: string;
}

export interface StepResetEvent {
  readonly type: "step_reset";
  readonly discardedAttempt: number;
  readonly nextAttempt: number;
  readonly reason?: string;
}

export interface StreamWithRetryInput {
  readonly model: ChatModel;
  readonly request: LlmRequest;
  readonly call?: CallOptions;
  readonly maxRetries?: number;
  readonly onEvent?: (event: AssistantMessageEvent) => void;
  readonly onRetrying?: (event: StepRetryingEvent) => void;
  readonly onReset?: (event: StepResetEvent) => void;
  readonly onDropPartial?: (failed: AssistantMessage) => void;
  readonly logger?: Logger;
}

export interface StreamWithRetryResult {
  readonly message: AssistantMessage;
  readonly stopReason: AssistantMessage["stopReason"];
}

interface AttemptResult {
  readonly message: AssistantMessage;
  readonly surfaced: boolean;
  readonly mode: "stream" | "complete";
}

export async function streamWithRetry(input: StreamWithRetryInput): Promise<StreamWithRetryResult> {
  const { model, request, call } = input;
  const logger = input.logger ?? noopLogger;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES_PER_STEP;
  const signal = call?.signal;
  let useCompleteFallback = false;

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const mode: AttemptResult["mode"] = useCompleteFallback ? "complete" : "stream";
    logger.log("debug", "llm request", logDataPolicy.dontLogModelData
      ? { model: model.id, attempt, mode, messages: request.messages.length, tools: request.tools?.length ?? 0 }
      : { model: model.id, attempt, mode, system: request.system, messages: request.messages, tools: request.tools?.map((t) => t.name), params: request.params });

    const attemptResult = useCompleteFallback
      ? await runCompleteAttempt(model, request, call)
      : await runStreamAttempt(model, request, call, input.onEvent);
    const result: StreamWithRetryResult = { message: attemptResult.message, stopReason: attemptResult.message.stopReason };

    if (result.stopReason !== "error") {
      if (attemptResult.mode === "complete") emitMessageEvents(result.message, input.onEvent);
      logger.log("debug", "llm response", logDataPolicy.dontLogModelData
        ? { model: model.id, attempt, mode: attemptResult.mode, stopReason: result.stopReason, usage: result.message.usage }
        : { model: model.id, attempt, mode: attemptResult.mode, stopReason: result.stopReason, content: result.message.content, usage: result.message.usage });
      return result; // success (stop / toolUse / length / aborted)
    }

    const reason = result.message.errorMessage ?? "";
    const hint = model.classifyError(reason);
    if (!hint.retryable || attempt >= maxRetries) {
      logger.log("error", "llm error", { model: model.id, attempt, mode: attemptResult.mode, retryable: hint.retryable, reason: result.message.errorMessage });
      return result; // give up → machine error as the result
    }

    input.onDropPartial?.(result.message);
    if (attemptResult.surfaced) {
      useCompleteFallback = true;
      input.onReset?.({
        type: "step_reset",
        discardedAttempt: attempt + 1,
        nextAttempt: attempt + 2,
        reason: result.message.errorMessage,
      });
    }

    const delayMs = retryDelayMs(attempt, hint.afterMs);
    logger.log("warn", "llm retry", { model: model.id, attempt: attempt + 1, maxAttempts: maxRetries, delayMs, reason: result.message.errorMessage });
    input.onRetrying?.({
      type: "step_retrying",
      attempt: attempt + 1,
      maxAttempts: maxRetries,
      delayMs,
      reason: result.message.errorMessage,
    });
    await abortableSleep(delayMs, signal);
  }
}

async function runStreamAttempt(
  model: ChatModel,
  request: LlmRequest,
  call: CallOptions | undefined,
  onEvent: ((event: AssistantMessageEvent) => void) | undefined,
): Promise<AttemptResult> {
  let surfaced = false;
  const message = await streamResult(model.stream(request, call), {
    onEvent: (event) => {
      if (isSurfacedEvent(event)) surfaced = true;
      onEvent?.(event);
    },
  });
  return { message, surfaced, mode: "stream" };
}

async function runCompleteAttempt(
  model: ChatModel,
  request: LlmRequest,
  call: CallOptions | undefined,
): Promise<AttemptResult> {
  return { message: await model.complete(request, call), surfaced: false, mode: "complete" };
}

/**
 * Replay a non-streamed message as the event sequence a streamed one would have produced, so
 * the `complete` fallback looks identical downstream.
 *
 * Only reasons that describe a finished, content-bearing message are replayed. `error` and
 * `aborted` never were; `pending` (a partial message) and `deferred` (content parked behind a
 * handle we do not poll) join them — synthesizing a `done` for either would announce an answer
 * that is not there. The turn loop maps both to `error` on its own.
 */
function emitMessageEvents(message: AssistantMessage, onEvent: ((event: AssistantMessageEvent) => void) | undefined): void {
  if (onEvent === undefined) return;
  const reason = message.stopReason;
  if (reason !== "stop" && reason !== "length" && reason !== "toolUse") return;
  onEvent({ type: "start", partial: message });
  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
    const part = message.content[contentIndex]!;
    if (part.type === "text") {
      if (part.text.length === 0) continue;
      onEvent({ type: "text_start", contentIndex, partial: message });
      onEvent({ type: "text_delta", contentIndex, delta: part.text, partial: message });
      onEvent({ type: "text_end", contentIndex, content: part.text, partial: message });
    } else if (part.type === "thinking") {
      if (part.thinking.length === 0) continue;
      onEvent({ type: "thinking_start", contentIndex, partial: message });
      onEvent({ type: "thinking_delta", contentIndex, delta: part.thinking, partial: message });
      onEvent({ type: "thinking_end", contentIndex, content: part.thinking, partial: message });
    } else {
      onEvent({ type: "toolcall_start", contentIndex, partial: message });
      const delta = toolArgumentsDelta(part);
      if (delta.length > 0) onEvent({ type: "toolcall_delta", contentIndex, delta, partial: message });
      onEvent({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
    }
  }
  onEvent({ type: "done", reason, message });
}

function toolArgumentsDelta(call: ToolCall): string {
  if (typeof call.arguments === "string") return call.arguments;
  return JSON.stringify(call.arguments ?? {});
}

function isSurfacedEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "text_end":
      return event.content.length > 0;
    case "thinking_end":
      return event.content.length > 0;
    case "toolcall_start":
    case "toolcall_end":
      return true;
    default:
      return false;
  }
}

function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const baseDelay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(baseDelay + Math.random() * 0.25 * baseDelay);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
