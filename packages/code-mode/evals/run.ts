/**
 * Code Mode eval CLI — "does a program save round-trips, and does the model use it?"
 *
 *   pnpm --filter operon-code-mode evals                          # vs the committed baseline
 *   pnpm --filter operon-code-mode evals -- --update-baseline     # record this run as the baseline
 *   EVALS_MODEL=anthropic/claude-haiku-4-5 pnpm --filter operon-code-mode evals
 *
 * Needs real model credentials in the ambient environment (e.g. ANTHROPIC_API_KEY). Exits 1 on
 * a regression against the baseline, or on harness failures. The offline plumbing check is
 * `evals:selftest`.
 */
import { join } from "node:path";
import { defineModel } from "operon-agents-core";
import { compareToBaseline, loadBaseline, printReport, writeBaseline } from "../../agents-core/evals/harness.ts";
import { CODE_MODE_CASES } from "./dataset.ts";
import { CODE_MODE_RULES, runCodeModeSuite } from "./suite.ts";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const BASELINE_PATH = join(import.meta.dirname, "baselines", "code-mode.json");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const updateBaseline = argv.includes("--update-baseline");
  const modelFlag = argv.indexOf("--model");
  const modelId = modelFlag >= 0 ? argv[modelFlag + 1] : (process.env["EVALS_MODEL"] ?? DEFAULT_MODEL);
  const [provider, ...rest] = (modelId ?? DEFAULT_MODEL).split("/");
  const model = defineModel({ provider: provider!, model: rest.join("/") });

  console.log(`\n▶ code-mode (${modelId})`);
  const report = await runCodeModeSuite(model, CODE_MODE_CASES);
  const baseline = loadBaseline(BASELINE_PATH);
  const regressions = baseline === undefined ? [] : compareToBaseline(report, baseline, CODE_MODE_RULES);
  printReport(report, baseline, regressions);
  if (baseline !== undefined && baseline.model !== report.model) console.log(`  (note: baseline was recorded with ${baseline.model})`);
  if (updateBaseline) {
    writeBaseline(BASELINE_PATH, report);
    console.log(`  baseline written → ${BASELINE_PATH}`);
  }
  process.exit(regressions.length > 0 || report.failures.length > 0 ? 1 : 0);
}

await main();
