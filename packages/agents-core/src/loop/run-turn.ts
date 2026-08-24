import type { ChatModel } from "../llm/define-model.ts";
import type { AssistantMessage, Message, ToolCall, Usage } from "../protocol/index.ts";
import type { PromptOrigin } from "../store/origin.ts";
import type { Tool } from "../tool/types.ts";
import type { Machine } from "../tool/machine.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import type { QuestionResponder } from "../tool/questions.ts";
import { FileFreshnessLedger } from "../tool/file-freshness.ts";
import type { Logger } from "../logging/index.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import { isAbortError, MaxStepsExceededError } from "./errors.ts";
import { APIContextOverflowError } from "../llm/errors.ts";
import { executeStep, type RecordUsageResult, type StepResult } from "./turn-step.ts";
import { activeDeferredTools } from "../tool/search/activation.ts";
import type { ConversationContext } from "./context.ts";
import { runCalls } from "./tool-call.ts";
import type { LoopEventDispatcher } from "./events.ts";
import type {
  BatchResume,
  HandoffSignal,
  LoopHooks,
  OutputGuardrailMonitorFactory,
  PendingInterrupt,
  TerminalStepStopReason,
  TurnResult,
  TurnStopReason,
} from "./types.ts";
import type { ToolCallSuspension } from "./interruption.ts";

export interface RunTurnInput {
  readonly turnId: string;
  readonly address?: string;
  /** Forwarded to the request as provider prompt-cache affinity; see `ExecuteStepDeps`. */
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
  readonly params?: import("../llm/model.ts").LlmRequest["params"];
  readonly context: ConversationContext;
  readonly tools?: readonly Tool[];
  /** Capability tools hidden until transcript load/use evidence activates them. */
  readonly deferredToolNames?: ReadonlySet<string>;
  readonly hooks?: LoopHooks;
  /** Per-step optimistic output guardrail adapter supplied by the active agent layer. */
  readonly createOutputGuardrailMonitor?: OutputGuardrailMonitorFactory;
  readonly maxSteps?: number;
  readonly maxRetriesPerStep?: number;
  readonly recordStepUsage?: (usage: Usage) => RecordUsageResult | void | Promise<RecordUsageResult | void>;
  /** Unified loop event sink — model stream, tool results, retries, dropped partials. */
  readonly dispatchEvent?: LoopEventDispatcher;
  readonly logger?: Logger;
  readonly resumeFrom?: AssistantMessage;
  /** Paired with `resumeFrom`: the paused frame's pending entries + input answers, consumed
   *  by the re-run batch (suspended-call continuation and auto re-park). */
  readonly resume?: BatchResume;
  readonly drainSteering?: () => readonly SteeredInput[];
}

/** A steered message plus its structured origin, mapped by the caller (which owns the SteerBus). */
export interface SteeredInput {
  readonly message: Message;
  readonly origin?: PromptOrigin;
}

/**
 * Cap on `recoverStepError` claims per turn. A claimant that keeps "recovering" without
 * changing the outcome (compaction that shrinks too little, say) would otherwise loop the
 * failed step forever; two attempts cover "compact once, then compact harder" and no more.
 */
const MAX_STEP_RECOVERIES_PER_TURN = 2;

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const toolList = input.tools ?? [];
  const deferredToolNames = input.deferredToolNames ?? new Set<string>();
  const fileLedger = input.fileLedger ?? new FileFreshnessLedger();

  let usage: Usage = emptyUsage();
  let steps = 0;
  let stepRecoveries = 0;
  // Normal exits overwrite this with the completed step's stop reason.
  let stopReason: TurnStopReason = "end_turn";
  let handoff: HandoffSignal | undefined;
  let pending: readonly PendingInterrupt[] | undefined;
  let suspensions: readonly ToolCallSuspension[] | undefined;

  const recordUsage = async (stepUsage: Usage): Promise<RecordUsageResult | void> => {
    usage = addUsage(usage, stepUsage);
    return input.recordStepUsage?.(stepUsage);
  };

  try {
    // HITL resume — re-run the interrupted batch with pre-loaded answers first.
    if (input.resumeFrom) {
      const resumeTools = activeDeferredTools(
        toolList,
        deferredToolNames,
        input.context.messages,
      );
      const resumeToolMap = new Map<string, Tool>(
        resumeTools.map((tool) => [tool.schema.name, tool]),
      );
      const completed = completedToolCallIds(input.context.messages, input.resumeFrom);
      const calls = input.resumeFrom.content.filter(
        (p): p is ToolCall => p.type === "toolCall" && !completed.has(p.id),
      );
      const batch = await runCalls(
        { turnId: input.turnId, stepNumber: 0, address: input.address, signal: input.signal, model: input.model, machine: input.machine, background: input.background, responder: input.responder, fileLedger, tools: resumeToolMap, hooks: input.hooks, dispatchEvent: input.dispatchEvent, logger: input.logger, resume: input.resume },
        calls,
      );
      // No hand-written `message.appended` here (or at the two drains below): appending
      // journals, and journaling broadcasts. See ConversationContext.onHistoryChange.
      for (const result of batch.results) input.context.appendMessage(result);
      if ((batch.pending && batch.pending.length > 0) || (batch.suspensions && batch.suspensions.length > 0)) {
        return {
          stopReason: "interrupt",
          steps,
          usage,
          pending: batch.pending,
          suspensions: batch.suspensions,
        };
      }
      if (batch.handoff) {
        return { stopReason: "handoff", steps, usage, handoff: batch.handoff };
      }
      if (batch.stopTurn) {
        return { stopReason: "end_turn", steps, usage };
      }
    }

    while (true) {
      input.signal.throwIfAborted();

      // live history before this model step, so the model responds to them this turn.
      if (input.drainSteering) {
        for (const { message, origin } of input.drainSteering()) input.context.appendMessage(message, origin);
      }

      if (input.maxSteps !== undefined && input.maxSteps > 0 && steps >= input.maxSteps) {
        throw new MaxStepsExceededError(input.maxSteps);
      }

      steps += 1;
      let step: StepResult;
      try {
        step = await executeStep({
          turnId: input.turnId,
          address: input.address,
          sessionId: input.sessionId,
          signal: input.signal,
          model: input.model,
          machine: input.machine,
          background: input.background,
          responder: input.responder,
          fileLedger,
          system: input.system,
          context: input.context,
          params: input.params,
          tools: toolList,
          deferredToolNames,
          hooks: input.hooks,
          createOutputGuardrailMonitor: input.createOutputGuardrailMonitor,
          currentStep: steps,
          maxRetriesPerStep: input.maxRetriesPerStep,
          dispatchEvent: input.dispatchEvent,
          logger: input.logger,
          recordUsage,
        });
      } catch (error) {
        // An abort wins over recovery — the outer catch maps it to "aborted" as before.
        if (isAbortError(error) || input.signal.aborted) throw error;
        const recovery =
          input.hooks?.recoverStepError && stepRecoveries < MAX_STEP_RECOVERIES_PER_TURN
            ? await input.hooks.recoverStepError({
                turnId: input.turnId,
                stepNumber: steps,
                address: input.address,
                signal: input.signal,
                model: input.model,
                messages: input.context.messages,
                context: input.context,
                system: input.system,
                error,
                attempt: stepRecoveries + 1,
              })
            : undefined;
        if (recovery?.recovered === true) {
          stepRecoveries += 1;
          input.dispatchEvent?.({
            type: "turn.step.retrying",
            turnId: input.turnId,
            step: steps,
            attempt: stepRecoveries,
            maxAttempts: MAX_STEP_RECOVERIES_PER_TURN,
            delayMs: 0,
            reason: error instanceof Error ? error.message : String(error),
          });
          // A recovered step re-runs under the same number: it never produced an outcome, so
          // it must not consume the turn's step budget.
          steps -= 1;
          continue;
        }
        // Unclaimed context overflow degrades exactly as before recovery existed: the turn
        // settles with "error" instead of rejecting the whole run (the failed message is
        // already preserved as an `overflow_dropped` transcript record by executeStep).
        if (error instanceof APIContextOverflowError) {
          stopReason = "error";
          break;
        }
        throw error;
      }

      if (step.stopReason === "tool_use") continue;

      const terminal = step.stopReason as TerminalStepStopReason;
      stopReason = terminal;

      // handoff / interrupt bubble straight to the Runner (no continuation hook).
      if (terminal === "handoff") {
        handoff = step.handoff;
        break;
      }
      if (terminal === "interrupt") {
        pending = step.pending;
        suspensions = step.suspensions;
        break;
      }

      const continuation = input.hooks?.shouldContinueAfterStop
        ? await input.hooks.shouldContinueAfterStop({
            turnId: input.turnId,
            stepNumber: steps,
            usage: step.usage,
            stopReason: terminal,
            signal: input.signal,
            model: input.model,
          })
        : undefined;
      if (continuation?.continue === true) continue;

      // pi `getSteeringMessages` semantics: a user steer that landed DURING this terminal step
      // must be answered in THIS turn, not deferred to a fresh one. The top-of-loop drain only
      // runs before a step, so re-drain here before breaking — if anything queued, inject it and
      // loop for one more step. Follow-ups (cron/background) are a separate channel the Runner
      // drains at the turn boundary, so they intentionally do NOT keep this turn alive.
      if (input.drainSteering) {
        const late = input.drainSteering();
        if (late.length > 0) {
          for (const { message, origin } of late) input.context.appendMessage(message, origin);
          continue;
        }
      }
      break;
    }
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted) {
      return { stopReason: "aborted", steps, usage };
    }
    throw error;
  }

  return { stopReason, steps, usage, handoff, pending, suspensions };
}

/** Tool results already journaled after the anchored assistant are stable sibling completions. */
function completedToolCallIds(messages: readonly Message[], assistant: AssistantMessage): Set<string> {
  const completed = new Set<string>();
  const index = messages.lastIndexOf(assistant);
  if (index < 0) return completed;
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant") break;
    if (message.role === "toolResult") completed.add(message.toolCallId);
  }
  return completed;
}
