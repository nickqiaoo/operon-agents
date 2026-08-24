/**
 * Eval CLI — the "did it get better or worse" loop for LLM-judged behaviors.
 *
 *   pnpm --filter operon-agents-core evals                       # both suites, vs baselines
 *   pnpm --filter operon-agents-core evals compaction            # one suite
 *   pnpm --filter operon-agents-core evals -- --update-baseline  # record current run as baseline
 *   EVALS_MODEL=anthropic/claude-haiku-4-5 pnpm --filter operon-agents-core evals
 *
 * Needs real model credentials in the ambient environment (e.g. ANTHROPIC_API_KEY).
 * Exits 1 on any regression against a committed baseline, or on harness failures.
 */
import { join } from "node:path";
import { defineModel } from "../src/llm/define-model.ts";
import { compareToBaseline, loadBaseline, printReport, writeBaseline, type SuiteReport, type RegressionRule } from "./harness.ts";
import { COMPACTION_CASES } from "./compaction-dataset.ts";
import { COMPACTION_RULES, runCompactionSuite } from "./compaction-suite.ts";
import { AUTO_APPROVER_CASES } from "./auto-approver-dataset.ts";
import { AUTO_APPROVER_RULES, runAutoApproverSuite } from "./auto-approver-suite.ts";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const BASELINE_DIR = join(import.meta.dirname, "baselines");

interface SuiteDef {
  readonly name: string;
  readonly rules: readonly RegressionRule[];
  readonly run: (model: ReturnType<typeof defineModel>) => Promise<SuiteReport>;
}

const SUITES: readonly SuiteDef[] = [
  { name: "compaction", rules: COMPACTION_RULES, run: (m) => runCompactionSuite(m, COMPACTION_CASES) },
  { name: "auto-approver", rules: AUTO_APPROVER_RULES, run: (m) => runAutoApproverSuite(m, AUTO_APPROVER_CASES) },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const updateBaseline = argv.includes("--update-baseline");
  const modelFlag = argv.indexOf("--model");
  const modelId = modelFlag >= 0 ? argv[modelFlag + 1] : (process.env["EVALS_MODEL"] ?? DEFAULT_MODEL);
  const requested = argv.filter((a) => !a.startsWith("--") && a !== modelId);
  const selected = requested.length > 0 ? SUITES.filter((s) => requested.includes(s.name)) : SUITES;
  if (selected.length === 0) {
    console.error(`unknown suite(s): ${requested.join(", ")} — available: ${SUITES.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }

  const [provider, ...rest] = (modelId ?? DEFAULT_MODEL).split("/");
  const model = defineModel({ provider: provider!, model: rest.join("/") });

  let failed = false;
  for (const suite of selected) {
    console.log(`\n▶ ${suite.name} (${modelId})`);
    const report = await suite.run(model);
    const baselinePath = join(BASELINE_DIR, `${suite.name}.json`);
    const baseline = loadBaseline(baselinePath);
    const regressions = baseline === undefined ? [] : compareToBaseline(report, baseline, suite.rules);
    printReport(report, baseline, regressions);
    if (baseline !== undefined && baseline.model !== report.model) {
      console.log(`  (note: baseline was recorded with ${baseline.model})`);
    }
    if (updateBaseline) {
      writeBaseline(baselinePath, report);
      console.log(`  baseline written → ${baselinePath}`);
    }
    if (regressions.length > 0 || report.failures.length > 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

await main();
