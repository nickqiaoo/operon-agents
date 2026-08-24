import type { AssistantMessage, ToolCall, ToolResultMessage } from "../protocol/index.ts";
import { ToolAccesses } from "../tool/access.ts";
import type { Tool, ToolInputRequest, ToolPlan, ToolResult, ToolResumeContext } from "../tool/types.ts";
import type { Machine } from "../tool/machine.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import type { QuestionResponder } from "../tool/questions.ts";
import type { FileFreshnessLedger } from "../tool/file-freshness.ts";
import type { ChatModel } from "../llm/define-model.ts";
import { type Logger, logDataPolicy, noopLogger } from "../logging/index.ts";
import { ToolScheduler } from "./scheduler.ts";
import type { LoopEventDispatcher } from "./events.ts";
import type {
  BatchResume,
  HandoffSignal,
  LoopHooks,
  PendingApprovalInterrupt,
  PendingInputInterrupt,
  PendingInterrupt,
} from "./types.ts";
import {
  ToolSuspendSignal,
  isToolInterruptionSignal,
  isToolSuspendSignal,
  type InterruptionState,
  type ToolCallSuspension,
} from "./interruption.ts";

/** After abort, how long a tool may still settle before we synthesize an error result. */
const GRACE_TIMEOUT_MS = 2_000;

export interface ToolCallStepContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly address?: string;
  readonly signal: AbortSignal;
  readonly model: ChatModel;
  readonly machine: Machine;
  readonly tools: ReadonlyMap<string, Tool>;
  readonly hooks?: LoopHooks;
  readonly background?: BackgroundSpawner;
  /** Client interactive-question channel, forwarded into the tool run context (AskUserQuestion). */
  readonly responder?: QuestionResponder;
  /** Session-scoped file freshness ledger, forwarded into both tool contexts. */
  readonly fileLedger?: FileFreshnessLedger;
  /** Surfaces each tool result the moment it lands (the unified loop event out). */
  readonly dispatchEvent?: LoopEventDispatcher;
  readonly logger?: Logger;
  /** Present when re-running a previously interrupted batch (HITL resume). */
  readonly resume?: BatchResume;
}

export interface ToolBatchResult {
  readonly results: readonly ToolResultMessage[];
  readonly stopTurn: boolean;
  readonly pending?: readonly PendingInterrupt[];
  readonly handoff?: HandoffSignal;
  readonly suspensions?: readonly ToolCallSuspension[];
}

type PreparedCall =
  | { readonly kind: "result"; readonly call: ToolCall; readonly result: ToolResult }
  | { readonly kind: "interrupt"; readonly call: ToolCall; readonly pending: PendingApprovalInterrupt }
  // A previously suspended call whose answer has not arrived: frozen as-is (state kept),
  // never executed, re-emitted on the next pause. The framework re-parks it so tools
  // don't have to re-suspend themselves on partial resumes.
  | { readonly kind: "repark"; readonly call: ToolCall; readonly pending: PendingInputInterrupt }
  | {
      readonly kind: "run";
      readonly call: ToolCall;
      readonly tool: Tool;
      readonly plan: ToolPlan;
      readonly args: unknown;
      /** Continuation of a suspended call being re-run with its answer. */
      readonly resumed?: ToolResumeContext;
    };

type CallOutcome =
  | { readonly kind: "result"; readonly result: ToolResult }
  | { readonly kind: "suspension"; readonly state: InterruptionState }
  | { readonly kind: "input"; readonly pending: PendingInputInterrupt };

export async function runToolCallBatch(step: ToolCallStepContext, message: AssistantMessage): Promise<ToolBatchResult> {
  const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
  return runCalls(step, calls);
}

export async function runCalls(step: ToolCallStepContext, calls: readonly ToolCall[]): Promise<ToolBatchResult> {
  // Phase A — resolve + authorize, sequentially in provider order.
  const prepared: PreparedCall[] = [];
  for (const call of calls) {
    prepared.push(await prepareCall(step, call));
  }

  // If any call needs approval, suspend the whole batch (reify + bubble) — run nothing.
  // Re-parked input suspensions ride along so the paused frame stays complete.
  const approvalPending = prepared
    .filter((p): p is Extract<PreparedCall, { kind: "interrupt" | "repark" }> => p.kind === "interrupt" || p.kind === "repark")
    .map((p) => p.pending);
  if (approvalPending.some((p) => p.kind === "approval")) {
    return { results: [], stopTurn: false, pending: approvalPending };
  }

  // tool.call.started (provider order) — fired for every call that will actually execute.
  for (const p of prepared) {
    if (p.kind === "repark") continue;
    const startArgs = p.kind === "run" ? p.args : p.call.arguments;
    step.dispatchEvent?.({ type: "tool.call.started", toolCallId: p.call.id, toolName: p.call.name, args: startArgs });
  }

  // Phase B — run the runnable ones, scheduled by resource conflict.
  const scheduler = new ToolScheduler<CallOutcome>();
  const outcomes = await Promise.all(
    prepared.map((p) => {
      if (p.kind === "result") return Promise.resolve({ kind: "result", result: p.result } satisfies CallOutcome);
      if (p.kind === "repark") return Promise.resolve({ kind: "input", pending: p.pending } satisfies CallOutcome);
      // (interrupt kind is impossible here — handled above)
      const run = p as Extract<PreparedCall, { kind: "run" }>;
      return scheduler.add({
        accesses: run.plan.accesses ?? ToolAccesses.all(),
        start: async () => ({ result: runAndFinalize(step, run) }),
      });
    }),
  );

  // Detect a handoff (first run plan flagged as one, in provider order).
  let handoff: HandoffSignal | undefined;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]!;
    const outcome = outcomes[i]!;
    if (p.kind === "run" && p.plan.handoff && outcome.kind === "result" && !outcome.result.isError) {
      handoff = {
        toolName: p.call.name,
        toolCallId: p.call.id,
        targetAgentName: p.plan.handoff.targetAgentName,
        args: p.args,
      };
      break;
    }
  }

  const stopTurn = outcomes.some(
    (outcome, i) =>
      outcome.kind === "result" &&
      (outcome.result.stopTurn === true || planOf(prepared[i])?.stopBatchAfterThis === true),
  );
  // Tool tasks may finish out of order; results are dispatched in provider order so each
  // tool call gets a paired result event (drives incremental tool.result).
  const resultMessages: ToolResultMessage[] = [];
  const suspensions: ToolCallSuspension[] = [];
  const inputPending: PendingInputInterrupt[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]!;
    if (outcome.kind === "suspension") {
      suspensions.push({ toolCallId: calls[i]!.id, state: outcome.state });
      step.dispatchEvent?.({ type: "tool.suspended", toolCallId: calls[i]!.id, toolName: calls[i]!.name });
    } else if (outcome.kind === "input") {
      inputPending.push(outcome.pending);
      // Re-parked calls stay frozen — only a fresh suspension is news.
      if (prepared[i]!.kind !== "repark") {
        step.dispatchEvent?.({ type: "tool.suspended", toolCallId: calls[i]!.id, toolName: calls[i]!.name, request: outcome.pending.request });
      }
    } else {
      resultMessages.push(toResultMessage(calls[i]!, outcome.result));
    }
  }
  for (const result of resultMessages) {
    step.dispatchEvent?.({
      type: "tool.result",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      result: { content: result.content, isError: result.isError, details: result.details },
      isError: result.isError ?? false,
    });
  }
  return {
    results: resultMessages,
    stopTurn,
    handoff,
    ...(inputPending.length > 0 ? { pending: inputPending } : {}),
    ...(suspensions.length > 0 ? { suspensions } : {}),
  };
}

async function prepareCall(step: ToolCallStepContext, call: ToolCall): Promise<PreparedCall> {
  let args: unknown = call.arguments;
  const tool = step.tools.get(call.name);

  // ⓪ Resume disposition — a call that suspended for input either re-runs with its answer
  //   (resumed context) or is re-parked untouched until the answer arrives.
  let resumed: ToolResumeContext | undefined;
  if (step.resume) {
    const entry = step.resume.pending.find((p) => p.toolCallId === call.id);
    if (entry?.kind === "input") {
      if (!Object.hasOwn(step.resume.inputAnswers, call.id)) return { kind: "repark", call, pending: entry };
      resumed = { state: entry.state, answer: step.resume.inputAnswers[call.id] };
    }
  }

  // ① prepareToolExecution — input guardrail / arg rewrite / early block.
  if (step.hooks?.prepareToolExecution) {
    const prep = await step.hooks.prepareToolExecution({
      turnId: step.turnId,
      stepNumber: step.stepNumber,
      address: step.address,
      signal: step.signal,
      model: step.model,
      toolCall: call,
      tool,
      args,
    });
    if (prep?.syntheticResult) return { kind: "result", call, result: prep.syntheticResult };
    if (prep?.block === true) {
      return { kind: "result", call, result: errorResult(prep.reason ?? "blocked", prep.terminate === true) };
    }
    if (prep && "updatedArgs" in prep && prep.updatedArgs !== undefined) args = prep.updatedArgs;
  }

  if (!tool) return { kind: "result", call, result: errorResult(`unknown tool: ${call.name}`) };

  // Phase 1 — resolve to a plan (a throw becomes an error result).
  let plan: ToolPlan;
  try {
    plan = await tool.resolve(args, {
      turnId: step.turnId,
      toolCallId: call.id,
      signal: step.signal,
      machine: step.machine,
      ...(step.fileLedger !== undefined ? { fileLedger: step.fileLedger } : {}),
    });
  } catch (error) {
    if (isToolSuspendSignal(error)) {
      return { kind: "result", call, result: errorResult("suspend() is only available during tool execution (plan.run), not resolve().") };
    }
    return { kind: "result", call, result: errorResult(messageOf(error)) };
  }

  if (step.hooks?.authorizeToolExecution) {
    const decision = await step.hooks.authorizeToolExecution({
      turnId: step.turnId,
      stepNumber: step.stepNumber,
      address: step.address,
      signal: step.signal,
      model: step.model,
      toolCall: call,
      tool,
      args,
      plan,
    });
    if (decision?.interrupt) return { kind: "interrupt", call, pending: decision.interrupt };
    if (decision?.syntheticResult) return { kind: "result", call, result: decision.syntheticResult };
    if (decision?.block === true) return { kind: "result", call, result: errorResult(decision.reason ?? "denied") };
  }

  return { kind: "run", call, tool, plan, args, resumed };
}

async function runAndFinalize(
  step: ToolCallStepContext,
  run: Extract<PreparedCall, { kind: "run" }>,
): Promise<CallOutcome> {
  const { call, tool, plan, args, resumed } = run;
  const logger = step.logger ?? noopLogger;
  logger.log("debug", "tool invoke", logDataPolicy.dontLogToolData
    ? { tool: call.name, toolCallId: call.id }
    : { tool: call.name, toolCallId: call.id, args });

  // ③ execute (phase 2). A per-call detach trigger (fired via `background.detach(toolCallId)`)
  // lets a running detachable tool move its live work into a background task; unregistered
  // the moment the call leaves the foreground.
  const detachSignal = step.background?.registerDetachable?.(call.id);
  let result: ToolResult;
  try {
    try {
      const executePromise = plan.run({
        turnId: step.turnId,
        toolCallId: call.id,
        signal: step.signal,
        machine: step.machine,
        ...(step.address !== undefined ? { address: step.address } : {}),
        background: step.background,
        responder: step.responder,
        ...(step.fileLedger !== undefined ? { fileLedger: step.fileLedger } : {}),
        ...(detachSignal !== undefined ? { detachSignal } : {}),
        suspend: (request: ToolInputRequest, state?: unknown): never => {
          throw new ToolSuspendSignal(request, snapshotSuspendState(call.name, state));
        },
        resumed,
        // Live progress → tool.progress (the unified dispatcher carries it out). A tool signals
        // it has entered its detachable window via a `custom/detachable` update, which we lift to
        // the first-class `tool.detachable` event (the UI's cue to offer "move to background").
        onUpdate: (update) => {
          if (step.signal.aborted) return;
          if (update.kind === "custom" && update.customKind === "detachable") {
            step.dispatchEvent?.({ type: "tool.detachable", toolCallId: call.id, toolName: call.name });
            return;
          }
          step.dispatchEvent?.({ type: "tool.progress", toolCallId: call.id, toolName: call.name, args, update });
        },
      });
      result = await raceExecuteWithGraceTimeout(executePromise, step.signal, call.name);
    } catch (error) {
      if (isToolInterruptionSignal(error)) return { kind: "suspension", state: error.state };
      if (isToolSuspendSignal(error)) {
        return {
          kind: "input",
          pending: { kind: "input", toolCallId: call.id, toolName: call.name, request: error.request, state: error.state },
        };
      }
      result = errorResult(messageOf(error));
    }
  } finally {
    step.background?.unregisterDetachable?.(call.id);
  }

  // ④ finalizeToolResult — output guardrail / redact.
  if (step.hooks?.finalizeToolResult) {
    const finalized = await step.hooks.finalizeToolResult({
      turnId: step.turnId,
      stepNumber: step.stepNumber,
      address: step.address,
      signal: step.signal,
      model: step.model,
      toolCall: call,
      tool,
      args,
      result,
    });
    if (finalized) result = finalized;
  }

  logger.log(result.isError === true ? "warn" : "debug", "tool result", logDataPolicy.dontLogToolData
    ? { tool: call.name, toolCallId: call.id, isError: result.isError === true }
    : { tool: call.name, toolCallId: call.id, isError: result.isError === true, result: result.content });
  return { kind: "result", result };
}

function planOf(p: PreparedCall | undefined): ToolPlan | undefined {
  return p?.kind === "run" ? p.plan : undefined;
}

function errorResult(text: string, stopTurn = false): ToolResult {
  return { content: [{ type: "text", text }], isError: true, ...(stopTurn ? { stopTurn: true } : {}) };
}

/**
 * Continuation state persists inside the interruption state (session KV), so it must be a
 * JSON value. Snapshot it at the suspend point: fail-fast on unserializable state (in the
 * tool author's face, with the tool named) instead of at persistence time, and freeze the
 * value so later mutations by the tool can't leak into the checkpoint.
 */
function snapshotSuspendState(toolName: string, state: unknown): unknown {
  if (state === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(state)) as unknown;
  } catch (error) {
    throw new Error(`Tool "${toolName}" suspend() state must be JSON-serializable: ${messageOf(error)}`);
  }
}

/**
 * Race a tool's execution against a post-abort grace window. A tool that ignores the
 * abort signal may never settle; after abort we wait GRACE_TIMEOUT_MS, then resolve with
 * a synthetic error result so the turn can finish instead of hanging.
 */
async function raceExecuteWithGraceTimeout(
  executePromise: Promise<ToolResult>,
  signal: AbortSignal,
  toolName: string,
): Promise<ToolResult> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const graceSentinel = new Promise<ToolResult>((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(
        () => resolve(errorResult(`Tool "${toolName}" aborted by grace timeout (${GRACE_TIMEOUT_MS}ms)`)),
        GRACE_TIMEOUT_MS,
      );
    };
    if (signal.aborted) armTimer();
    else {
      onAbort = armTimer;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // some AbortSignal polyfills lack removeEventListener
      }
    }
  }
}

function toResultMessage(call: ToolCall, result: ToolResult): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    details: result.details,
    ...(result.addedToolNames !== undefined ? { addedToolNames: [...result.addedToolNames] } : {}),
    isError: result.isError ?? false,
    timestamp: Date.now(),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
