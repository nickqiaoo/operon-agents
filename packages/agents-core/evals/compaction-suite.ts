/**
 * Compaction-strategy eval: run the REAL full-compaction path (same code the loop calls)
 * over each dataset case and score the outcome on the signals compaction already reports —
 * token reduction (tokensBefore/After) plus needle retention in the produced summary.
 */
import { ConversationContext } from "../src/loop/context.ts";
import { runFullCompaction } from "../src/capabilities/compaction/full.ts";
import { CompactionStrategy } from "../src/capabilities/compaction/strategy.ts";
import { estimateTokensForMessages } from "../src/capabilities/compaction/tokens.ts";
import type { ChatModel } from "../src/llm/define-model.ts";
import { mean, type SuiteReport, type RegressionRule } from "./harness.ts";
import type { CompactionEvalCase } from "./compaction-dataset.ts";

export const COMPACTION_RULES: readonly RegressionRule[] = [
  // The quality signal: a summary that drops planted facts is a worse summary.
  { metric: "needle_recall", direction: "higher-better", tolerance: 0.05 },
  // The efficiency signal: compaction that stops shrinking the context is a regression too.
  { metric: "token_reduction", direction: "higher-better", tolerance: 0.1 },
];

/** Context window handed to the strategy. Fixed so token metrics are comparable across runs. */
const EVAL_WINDOW_TOKENS = 200_000;

export async function runCompactionSuite(
  model: ChatModel,
  cases: readonly CompactionEvalCase[],
): Promise<SuiteReport> {
  const recalls: number[] = [];
  const reductions: number[] = [];
  const summaryTokens: number[] = [];
  const failures: string[] = [];

  for (const evalCase of cases) {
    const context = new ConversationContext({ history: evalCase.messages });
    const strategy = new CompactionStrategy(() => EVAL_WINDOW_TOKENS);
    const tokensBefore = estimateTokensForMessages(context.messages);
    try {
      const count = await runFullCompaction({
        messages: context.messages,
        model,
        signal: new AbortController().signal,
        strategy,
        sessionId: `eval-${evalCase.id}`,
        context,
        address: "eval",
      });
      if (count === 0) {
        failures.push(`${evalCase.id}: strategy chose not to compact (count=0) — dataset too short?`);
        continue;
      }
      const summaryMsg = context.messages[0];
      const summary = (summaryMsg?.role === "user" ? summaryMsg.content : [])
        .filter((c): c is { type: "text"; text: string } => typeof c !== "string" && c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .toLowerCase();
      const found = evalCase.needles.filter((needle) => summary.includes(needle.toLowerCase()));
      recalls.push(found.length / evalCase.needles.length);
      const tokensAfter = estimateTokensForMessages(context.messages);
      reductions.push(tokensBefore <= 0 ? 0 : 1 - tokensAfter / tokensBefore);
      summaryTokens.push(estimateTokensForMessages([context.messages[0]!]));
      const missing = evalCase.needles.filter((needle) => !summary.includes(needle.toLowerCase()));
      if (missing.length > 0) console.log(`  · ${evalCase.id}: dropped needles: ${missing.join(" | ")}`);
    } catch (error) {
      failures.push(`${evalCase.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    suite: "compaction",
    model: model.id,
    cases: cases.length,
    metrics: {
      needle_recall: mean(recalls),
      token_reduction: mean(reductions),
      mean_summary_tokens: mean(summaryTokens),
    },
    failures,
  };
}
