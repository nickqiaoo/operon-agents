import type { Capability, RunContext, CompactionGate } from "../capability.ts";
import { T } from "../../scope/tokens.ts";
import { APIContextOverflowError } from "../../llm/errors.ts";
import type { InjectionManager } from "../injection.ts";
import type { EventSink } from "../../events/index.ts";
import type { AgentEventBody } from "../../events/index.ts";
import { type Logger, noopLogger } from "../../logging/index.ts";
import { CompactionStrategy, DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from "./strategy.ts";
import { MicroCompaction, type MicroCompactionConfig } from "./micro.ts";
import { runFullCompaction } from "./full.ts";
import { estimateTokensForMessages } from "./tokens.ts";
import { CompactionService, type PendingCompaction } from "./service.ts";

export { CompactionStrategy, DEFAULT_COMPACTION_CONFIG } from "./strategy.ts";
export type { CompactionConfig } from "./strategy.ts";
export { MicroCompaction } from "./micro.ts";
export { estimateTokens, estimateTokensForMessages } from "./tokens.ts";
export { CompactionService } from "./service.ts";
export type { CompactRequestOptions, PendingCompaction } from "./service.ts";

export interface CompactionOptions {
  readonly maxContextTokens: number;
  readonly config?: Partial<CompactionConfig>;
  readonly micro?: boolean | Partial<MicroCompactionConfig>;
  readonly customInstruction?: string;
}

/** Consecutive auto-compaction failures before we stop trying for the rest of the session. A
 *  context that is irrecoverably over the limit otherwise re-attempts a doomed summary on every
 *  single step, burning a model call each time and never making progress. */
const MAX_CONSECUTIVE_FAILURES = 3;

export function compactionCapability(options: CompactionOptions): Capability {
  const mergedConfig: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    ...options.config,
  };
  // The active model — hence its output limit — is only known once a step runs, so the strategy
  // reads it through a provider that each hook refreshes.
  let maxOutputTokens = 0;
  const strategy = new CompactionStrategy(() => options.maxContextTokens, () => maxOutputTokens, mergedConfig);
  const micro = options.micro
    ? new MicroCompaction(typeof options.micro === "object" ? options.micro : {})
    : null;
  const service = new CompactionService(() => strategy.reservedTokens);

  let injection: InjectionManager | undefined;
  // Live reference from the assembler: reading it at compact() time (not at start()) means gates
  // from capabilities ordered after this one are still seen.
  let gates: readonly CompactionGate[] | undefined;
  let events: EventSink | undefined;
  let logger: Logger = noopLogger;
  let sessionId = "";
  let lastAssistantAtMs = Date.now();
  let consecutiveFailures = 0;

  const compact = async (ctx: {
    messages: readonly import("../../protocol/index.ts").Message[];
    context: import("../../loop/context.ts").ConversationContext;
    model: import("../../llm/define-model.ts").ChatModel;
    system?: string;
    signal: AbortSignal;
  }, request?: PendingCompaction): Promise<number> => {
    const address = ctx.context.address;
    const isManual = request !== undefined;
    // Circuit breaker applies to automatic compaction only — an explicit /compact is the user
    // asking again on purpose, and it gets a real attempt (and a real error) every time.
    if (!isManual && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return 0;

    try {
      const count = await runFullCompaction({
        messages: ctx.messages,
        context: ctx.context,
        model: ctx.model,
        system: ctx.system,
        signal: ctx.signal,
        strategy,
        customInstruction: request?.instruction ?? options.customInstruction,
        trigger: isManual ? "manual" : "auto",
        sessionId,
        injection,
        address,
        gates,
        emit: (body: AgentEventBody) => {
          events?.emit({ ...body, address, sessionId });
        },
        logger,
      });
      if (count > 0) service.recordCompleted();
      consecutiveFailures = 0;
      return count;
    } catch (error) {
      // An abort is the user stopping the turn, not a compaction that can't succeed: propagate
      // it untouched and don't count it against the breaker.
      if (ctx.signal.aborted) throw error;
      // A manual request must surface its failure — swallowing it makes /compact look like a
      // no-op. Automatic compaction degrades instead: the step proceeds uncompacted.
      if (isManual) throw error;
      consecutiveFailures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      logger.log("warn", "compaction failed", { reason, consecutiveFailures });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.log("warn", "compaction circuit breaker tripped — skipping automatic compaction for this session", {
          consecutiveFailures,
        });
      }
      return 0;
    }
  };

  return {
    name: "compaction",
    provides: [{ token: T.Compaction, create: () => service }],
    hooks: {
      beforeStep: async (ctx) => {
        maxOutputTokens = ctx.model.maxOutputTokens;
        const manual = service.consume();
        if (manual !== null) await compact(ctx, manual);
        if (micro) {
          // Truncate on a copy and commit through the journaled mutator. The previous
          // in-place edit of the live array bypassed the journal, so a replay would
          // resurrect every tool result micro-compaction had cleared.
          const trimmed = [...ctx.messages];
          if (micro.detectAndApply(trimmed, lastAssistantAtMs, options.maxContextTokens) > 0) {
            ctx.context.replaceHistory(trimmed);
          }
        }
        if (strategy.shouldBlock(estimateTokensForMessages(ctx.messages))) {
          await compact(ctx);
        }
        return undefined;
      },
      afterStep: async (ctx) => {
        maxOutputTokens = ctx.model.maxOutputTokens;
        lastAssistantAtMs = Date.now();
        if (strategy.checkAfterStep && strategy.shouldCompact(estimateTokensForMessages(ctx.messages))) {
          await compact(ctx);
        }
        return undefined;
      },
      // Reactive overflow recovery: the API rejected the request as too large, so the
      // threshold check is skipped — the provider is ground truth and the estimate simply
      // under-counted. The circuit breaker still applies (compact() returns 0 when tripped),
      // and a compaction that made no progress does NOT claim: the turn then fails exactly
      // as it would have without this hook.
      recoverStepError: async (ctx) => {
        if (!(ctx.error instanceof APIContextOverflowError)) return undefined;
        maxOutputTokens = ctx.model.maxOutputTokens;
        const compacted = await compact(ctx);
        if (compacted <= 0) return undefined;
        return { recovered: true };
      },
    },
    start: (ctx: RunContext) => {
      injection = ctx.injection;
      gates = ctx.gates.compaction;
      events = ctx.scope.get(T.Events);
      logger = ctx.scope.get(T.Logger) ?? noopLogger;
      sessionId = ctx.sessionId;
      lastAssistantAtMs = Date.now();
    },
  };
}
