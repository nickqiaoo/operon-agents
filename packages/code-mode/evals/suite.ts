/**
 * Code Mode eval: does a program actually save round-trips, and does the model reach for it?
 *
 * Each case runs twice on the REAL harness — once with direct tools only, once with the
 * extension attached — and the two runs are measured on the same signals a session already
 * reports: model calls (`turn.step.started`), tokens (`usage.updated`), whether `RunCode` was
 * used, and whether the final answer is right. Nothing here is a judge; the dataset's `expect`
 * is the whole verdict on correctness.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHarness } from "operon-agents";
import type { AgentEvent, ChatModel } from "operon-agents";
import { codeMode, RUN_CODE_NAME } from "../src/index.ts";
import { mean, type RegressionRule, type SuiteReport } from "../../agents-core/evals/harness.ts";
import type { CodeModeEvalCase } from "./dataset.ts";

export const CODE_MODE_RULES: readonly RegressionRule[] = [
  // The point of the feature: fewer model calls than the direct path. A ratio creeping toward 1 is a regression.
  { metric: "step_ratio", direction: "lower-better", tolerance: 0.15 },
  { metric: "token_ratio", direction: "lower-better", tolerance: 0.2 },
  // The model must still get the answer right with the program in hand.
  { metric: "correct_code", direction: "higher-better", tolerance: 0.1 },
  // And it must actually reach for the program on tasks built for it.
  { metric: "runcode_adoption", direction: "higher-better", tolerance: 0.2 },
];

/** One run's measurements. */
export interface RunMeasure {
  readonly steps: number;
  readonly tokens: number;
  readonly toolCalls: number;
  readonly usedRunCode: boolean;
  readonly correct: boolean;
  readonly answer: string;
}

export interface CodeModeSuiteOptions {
  /** Cap on model calls per run, so a model that loops does not run up the bill. */
  readonly maxStepsPerTurn?: number;
}

/** Run one case one way. Exported so the self-test can drive it with a scripted model. */
export async function measureRun(
  model: ChatModel,
  evalCase: CodeModeEvalCase,
  variant: "direct" | "code",
  options: CodeModeSuiteOptions = {},
): Promise<RunMeasure> {
  const work = mkdtempSync(join(tmpdir(), `code-mode-eval-${evalCase.id}-`));
  try {
    for (const [path, content] of Object.entries(evalCase.files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    const harness = createHarness({
      model,
      workDir: work,
      permission: { mode: "yolo" },
      maxStepsPerTurn: options.maxStepsPerTurn ?? 12,
      extensions: variant === "code" ? [codeMode()] : [],
    });
    const session = await harness.createSession();
    let steps = 0;
    let tokens = 0;
    let toolCalls = 0;
    let usedRunCode = false;
    session.onEvent((event: AgentEvent) => {
      if (event.type === "turn.step.started") steps += 1;
      if (event.type === "usage.updated") tokens = event.usage.input + event.usage.output;
      if (event.type === "tool.call.started" && event.parentToolCallId === undefined) {
        toolCalls += 1;
        if (event.toolName === RUN_CODE_NAME) usedRunCode = true;
      }
    });
    const result = await session.prompt(evalCase.prompt);
    await harness.close();
    return { steps, tokens, toolCalls, usedRunCode, correct: evalCase.expect(result.output), answer: result.output };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function runCodeModeSuite(
  model: ChatModel,
  cases: readonly CodeModeEvalCase[],
  options: CodeModeSuiteOptions = {},
): Promise<SuiteReport> {
  const stepsDirect: number[] = [];
  const stepsCode: number[] = [];
  const tokensDirect: number[] = [];
  const tokensCode: number[] = [];
  const stepRatios: number[] = [];
  const tokenRatios: number[] = [];
  const correctDirect: number[] = [];
  const correctCode: number[] = [];
  const adoption: number[] = [];
  const failures: string[] = [];

  for (const evalCase of cases) {
    try {
      const direct = await measureRun(model, evalCase, "direct", options);
      const code = await measureRun(model, evalCase, "code", options);
      stepsDirect.push(direct.steps);
      stepsCode.push(code.steps);
      tokensDirect.push(direct.tokens);
      tokensCode.push(code.tokens);
      stepRatios.push(direct.steps === 0 ? 1 : code.steps / direct.steps);
      tokenRatios.push(direct.tokens === 0 ? 1 : code.tokens / direct.tokens);
      correctDirect.push(direct.correct ? 1 : 0);
      correctCode.push(code.correct ? 1 : 0);
      adoption.push(code.usedRunCode ? 1 : 0);
      console.log(
        `  ${evalCase.id.padEnd(14)} direct: ${String(direct.steps)} steps, ${String(direct.tokens)} tok, ${direct.correct ? "ok" : "WRONG"}` +
          `   code: ${String(code.steps)} steps, ${String(code.tokens)} tok, ${code.correct ? "ok" : "WRONG"}${code.usedRunCode ? "" : " (no RunCode)"}`,
      );
    } catch (error) {
      failures.push(`${evalCase.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    suite: "code-mode",
    model: model.id,
    cases: cases.length,
    metrics: {
      steps_direct: mean(stepsDirect),
      steps_code: mean(stepsCode),
      step_ratio: mean(stepRatios),
      tokens_direct: mean(tokensDirect),
      tokens_code: mean(tokensCode),
      token_ratio: mean(tokenRatios),
      correct_direct: mean(correctDirect),
      correct_code: mean(correctCode),
      runcode_adoption: mean(adoption),
    },
    failures,
  };
}
