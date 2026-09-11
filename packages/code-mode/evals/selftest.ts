/**
 * Offline self-test of the Code Mode eval (runs in CI, no credentials): drives the real suite
 * with a scripted faux model that answers the direct variant with one tool call per file and
 * the code variant with one program, and asserts the plumbing — steps and tokens are counted,
 * correctness is judged by the dataset, RunCode use is detected, and a planted regression is
 * flagged by the baseline layer. Model quality is what `run.ts` measures against a real model.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import type { FauxResponseStep } from "../../agents/test/faux.ts";
import { compareToBaseline, type Baseline } from "../../agents-core/evals/harness.ts";
import { RUN_CODE_NAME } from "../src/index.ts";
import { CODE_MODE_CASES } from "./dataset.ts";
import { CODE_MODE_RULES, measureRun, runCodeModeSuite } from "./suite.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** The right answer for a case, as a faux model would say it. */
const ANSWERS: Record<string, string> = {
  "todo-count": "6",
  "config-key": "beta.yaml and delta.yaml",
  "longest-file": "two.md",
  mentions: "billing.md, returns.md, faq.md",
  importers: "app.ts and worker.ts",
};

/** Direct variant: read every file one call at a time, then answer. */
function directScript(files: readonly string[], answer: string): FauxResponseStep[] {
  return [
    ...files.map((path) => fauxAssistantMessage(fauxToolCall("Read", { path }), { stopReason: "toolUse" })),
    fauxAssistantMessage(answer, { stopReason: "stop" }),
  ];
}

/** Code variant: one program that reads them all, then answer. */
function codeScript(files: readonly string[], answer: string): FauxResponseStep[] {
  return [
    fauxAssistantMessage(
      fauxToolCall(RUN_CODE_NAME, {
        code: `const texts = await Promise.all(${JSON.stringify(files)}.map((path) => tools.Read({ path })));\nreturn texts.map((t) => t.length);`,
        description: "Read every file at once",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(answer, { stopReason: "stop" }),
  ];
}

const faux = registerFauxProvider();
const model = faux.getChatModel();

// ── one case, both variants, measured ──
{
  const evalCase = CODE_MODE_CASES[0]!;
  const files = Object.keys(evalCase.files);
  faux.setResponses(directScript(files, ANSWERS[evalCase.id]!));
  const direct = await measureRun(model, evalCase, "direct");
  faux.setResponses(codeScript(files, ANSWERS[evalCase.id]!));
  const code = await measureRun(model, evalCase, "code");
  check("direct: one model call per file plus the answer", direct.steps === files.length + 1 && direct.toolCalls === files.length && !direct.usedRunCode);
  check("code: one program plus the answer", code.steps === 2 && code.toolCalls === 1 && code.usedRunCode);
  check("both answers judged correct by the dataset", direct.correct && code.correct);
  check("tokens are counted on both", direct.tokens > 0 && code.tokens > 0);
  faux.setResponses([fauxAssistantMessage("the wrong answer", { stopReason: "stop" })]);
  const wrong = await measureRun(model, evalCase, "direct");
  check("a wrong answer is judged wrong", !wrong.correct);
}

// ── the whole suite: one queue of scripted responses, in the order the suite consumes them ──
{
  // The suite runs direct then code for each case, in dataset order; each run consumes exactly
  // its own responses, so one flat queue scripts the lot.
  const queue: FauxResponseStep[] = [];
  for (const evalCase of CODE_MODE_CASES) {
    const files = Object.keys(evalCase.files);
    queue.push(...directScript(files, ANSWERS[evalCase.id]!), ...codeScript(files, ANSWERS[evalCase.id]!));
  }
  faux.setResponses(queue);
  const report = await runCodeModeSuite(model, CODE_MODE_CASES);
  check("suite: every case measured", report.cases === CODE_MODE_CASES.length);
  check("suite: reports no harness failures", report.failures.length === 0);
  check("suite: step_ratio well below 1", (report.metrics["step_ratio"] ?? 1) < 0.6);
  check("suite: RunCode adoption is total", report.metrics["runcode_adoption"] === 1);
  check("suite: correctness is total on both sides", report.metrics["correct_direct"] === 1 && report.metrics["correct_code"] === 1);

  // ── the baseline layer flags a planted regression, and only that ──
  const better: Baseline = { suite: "code-mode", model: report.model, updatedAt: "", metrics: { ...report.metrics, step_ratio: (report.metrics["step_ratio"] ?? 0) - 0.3 } };
  const regressions = compareToBaseline(report, better, CODE_MODE_RULES);
  check("baseline: a worse step_ratio is a regression", regressions.length === 1 && (regressions[0]?.startsWith("step_ratio") ?? false));
  const same: Baseline = { suite: "code-mode", model: report.model, updatedAt: "", metrics: report.metrics };
  check("baseline: holding the line is not", compareToBaseline(report, same, CODE_MODE_RULES).length === 0);
}

faux.unregister();
const failed = checks.filter(([, passed]) => !passed);
console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
if (failed.length > 0) {
  console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
  process.exit(1);
}
console.log("✅ CODE MODE EVALS SELFTEST PASS");
