import type { AssistantMessage, Message } from "../../protocol/index.ts";
import type { ChatModel } from "../../llm/define-model.ts";
import { type Logger, logDataPolicy, noopLogger } from "../../logging/index.ts";
import { type ConversationContext, summaryMessage } from "../../loop/context.ts";
import type { InjectionManager } from "../injection.ts";
import type { CompactionGate } from "../capability.ts";
import { systemReminder } from "../injection.ts";
import { compactionInstruction } from "./instruction.ts";
import { estimateTokens, estimateTokensForMessages } from "./tokens.ts";
import type { CompactionStrategy } from "./strategy.ts";

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

export interface FullCompactionDeps {
  readonly messages: readonly Message[];
  readonly model: ChatModel;
  readonly system?: string;
  readonly signal: AbortSignal;
  readonly strategy: CompactionStrategy;
  readonly customInstruction?: string;
  readonly trigger?: string;
  readonly sessionId: string;
  readonly injection?: InjectionManager;
  readonly context: ConversationContext;
  readonly address: string;
  readonly emit?: (event: import("../../events/index.ts").AgentEventBody) => void;
  readonly logger?: Logger;
  /** Capability gates to consult before compacting. See `CapabilityGates`. */
  readonly gates?: readonly CompactionGate[];
}

export async function runFullCompaction(deps: FullCompactionDeps): Promise<number> {
  const { messages, strategy } = deps;
  const logger = deps.logger ?? noopLogger;
  const initialCount = strategy.computeCompactCount(messages);
  if (initialCount === 0) return 0;

  // Ask before acting. Compaction is self-initiated, so this is the only chance another
  // capability gets to veto it or to supply the summary itself.
  const verdict = await consultGates(deps, initialCount);
  if (verdict?.cancel === true) {
    logger.log("debug", "compaction cancelled by a capability gate", { count: initialCount });
    return 0;
  }

  const tokensBefore = estimateTokensForMessages(messages);
  const trigger = deps.trigger ?? "auto";
  logger.log("debug", "compaction start", { trigger, count: initialCount, tokensBefore });
  deps.emit?.({ type: "compaction.started", trigger, instruction: deps.customInstruction });

  const { summary, count } = verdict?.replacement
    ? { summary: verdict.replacement.summary, count: clampCount(verdict.replacement.count ?? initialCount, messages.length) }
    : await summarize(deps, initialCount);

  // Token estimate of the post-splice list (summary + kept tail), before mutating.
  const tokensAfter = estimateTokensForMessages([summaryMessage(summary), ...messages.slice(count)]);

  // Replace the oldest `count` messages with one summary AND append the compaction entry, in order —
  // one journaled operation, mirrored by replay's applyCompaction.
  deps.context.applyCompaction({ summary, compactedCount: count, tokensBefore, tokensAfter });

  // Rebuild reminders whose prior append-only copies were removed by compaction.
  deps.injection?.onContextCompacted(count);
  if (deps.injection) {
    deps.injection.runAtTurnBoundary(
      {
        history: messages,
        sessionId: deps.sessionId,
        address: deps.address,
        originOf: (message) => deps.context.originOf(message),
      },
      (result, injectorId) => {
        const message: Message = {
          role: "user",
          content: [{ type: "text", text: systemReminder(result.text) }],
          timestamp: Date.now(),
        };
        deps.context.appendMessage(message, {
          kind: "injection",
          injectorId,
          variant: result.variant ?? injectorId,
        });
      },
    );
  }

  logger.log("debug", "compaction done", { trigger, tokensBefore, tokensAfter, compactedCount: count });
  deps.emit?.({ type: "compaction.completed", tokensBefore, tokensAfter, compactedCount: count });
  return count;
}

/**
 * Run every registered compaction gate in order. First `cancel` wins and stops the pass; first
 * `replacement` wins and is used verbatim. A gate that throws is skipped — a broken arbiter must
 * not be able to wedge compaction shut, or the context would grow until the window blows.
 */
async function consultGates(
  deps: FullCompactionDeps,
  compactCount: number,
): Promise<{ cancel?: boolean; replacement?: { summary: string; count?: number } } | undefined> {
  const gates = deps.gates ?? [];
  if (gates.length === 0) return undefined;
  const logger = deps.logger ?? noopLogger;
  let replacement: { summary: string; count?: number } | undefined;
  for (const gate of gates) {
    let result: Awaited<ReturnType<typeof gate>>;
    try {
      result = await gate({
        reason: deps.trigger === "manual" ? "manual" : "auto",
        messages: deps.messages,
        compactCount,
        signal: deps.signal,
      });
    } catch (error) {
      logger.log("warn", "compaction gate failed; ignored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (result?.cancel === true) return { cancel: true };
    if (result?.replacement !== undefined && replacement === undefined) replacement = result.replacement;
  }
  return replacement ? { replacement } : undefined;
}

/** A gate-supplied count must still be a valid splice point, or `applyCompaction` corrupts history. */
function clampCount(count: number, total: number): number {
  if (!Number.isInteger(count) || count < 1) return 1;
  return Math.min(count, total);
}

async function summarize(deps: FullCompactionDeps, initialCount: number): Promise<{ summary: string; count: number }> {
  const logger = deps.logger ?? noopLogger;
  const instruction = compactionInstruction(deps.customInstruction);
  let count = initialCount;
  let attempt = 0;

  while (true) {
    deps.signal.throwIfAborted();
    const prefix = deps.messages.slice(0, count);
    const request = {
      system: deps.system,
      messages: [...prefix, instructionUserMessage(instruction)],
      tools: undefined,
    };

    logger.log("debug", "compaction llm request", logDataPolicy.dontLogModelData
      ? { model: deps.model.id, attempt, count, messages: request.messages.length }
      : { model: deps.model.id, attempt, count, system: request.system, messages: request.messages });

    let summaryText = "";
    let truncatedOrError = false;
    try {
      const message = await deps.model.complete(request, { signal: deps.signal });
      if (message.stopReason === "error") throw new Error(message.errorMessage ?? "compaction stream error");
      summaryText = textOf(message);
      if (message.stopReason === "length" || summaryText.trim().length === 0) truncatedOrError = true;
      logger.log("debug", "compaction llm response", logDataPolicy.dontLogModelData
        ? { model: deps.model.id, attempt, stopReason: message.stopReason, truncatedOrError, usage: message.usage }
        : { model: deps.model.id, attempt, stopReason: message.stopReason, truncatedOrError, summary: summaryText, usage: message.usage });
    } catch (error) {
      if (deps.signal.aborted) throw error;
      truncatedOrError = true;
      logger.log("warn", "compaction llm error", { model: deps.model.id, attempt, reason: error instanceof Error ? error.message : String(error) });
    }

    if (!truncatedOrError) return { summary: summaryText, count };

    attempt += 1;
    if (attempt >= MAX_COMPACTION_RETRY_ATTEMPTS) {
      throw new Error("Compaction failed to produce a complete summary after retries.");
    }
    // Truncated/overflowed → compact a bit more and retry (compact-and-retry, not #8).
    const nextCount = deps.strategy.reduceCompactOnOverflow(deps.messages.slice(0, count));
    logger.log("warn", "compaction retry", { attempt, maxAttempts: MAX_COMPACTION_RETRY_ATTEMPTS, count, nextCount });
    count = nextCount;
    if (count === 0) throw new Error("Compaction could not reduce the prefix further.");
  }
}

function instructionUserMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((p): p is import("../../protocol/index.ts").TextContent => p.type === "text")
    .map((p) => p.text)
    .join("");
}
