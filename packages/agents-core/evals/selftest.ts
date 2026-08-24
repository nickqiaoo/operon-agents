/**
 * Offline harness self-test (runs in CI, no credentials): drives both suites with a scripted
 * faux model and asserts the plumbing — real compaction/judge code paths execute, metrics
 * come out as scripted, and the baseline layer flags a planted regression. This validates
 * the eval loop itself; model quality is what `run.ts` measures against a real model.
 */
import { registerFauxProvider, fauxAssistantMessage } from "../src/test/faux.ts";
import { compareToBaseline, type Baseline } from "./harness.ts";
import { COMPACTION_CASES } from "./compaction-dataset.ts";
import { COMPACTION_RULES, runCompactionSuite } from "./compaction-suite.ts";
import { AUTO_APPROVER_CASES } from "./auto-approver-dataset.ts";
import { AUTO_APPROVER_RULES, runAutoApproverSuite } from "./auto-approver-suite.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

// ── compaction suite: faux summaries that keep every needle ──
{
  const faux = registerFauxProvider();
  faux.setResponses(
    COMPACTION_CASES.map(
      (c) => () => fauxAssistantMessage(`## Summary\nCompacted summary, key facts preserved:\n${c.needles.join("\n")}`),
    ),
  );
  const report = await runCompactionSuite(faux.getChatModel()!, COMPACTION_CASES);
  faux.unregister();
  check("compaction: every case compacted", report.failures.length === 0 && report.cases === COMPACTION_CASES.length);
  check("compaction: needle_recall = 1 for faithful summaries", report.metrics["needle_recall"] === 1);
  check("compaction: tokens actually reduced", (report.metrics["token_reduction"] ?? 0) > 0.3);
}

// ── compaction suite: a summary that drops needles is measured, not hidden ──
{
  const faux = registerFauxProvider();
  faux.setResponses(COMPACTION_CASES.map(() => () => fauxAssistantMessage("## Summary\n(a hollow summary carrying no concrete facts)")));
  const report = await runCompactionSuite(faux.getChatModel()!, COMPACTION_CASES);
  faux.unregister();
  check("compaction: dropped needles → recall 0", report.metrics["needle_recall"] === 0);
  const baseline: Baseline = {
    suite: "compaction",
    model: "faux",
    metrics: { needle_recall: 1, token_reduction: 0.5 },
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  const regressions = compareToBaseline(report, baseline, COMPACTION_RULES);
  check("compaction: baseline compare flags the recall regression", regressions.some((r) => r.startsWith("needle_recall")));
}

// ── auto-approver suite: scripted correct verdicts (fast mode → one call per case) ──
{
  const faux = registerFauxProvider();
  faux.setResponses(
    AUTO_APPROVER_CASES.map(
      (c) => () =>
        fauxAssistantMessage(
          c.expected === "allow" ? "<block>no</block>" : "<block>yes</block><reason>dangerous</reason>",
        ),
    ),
  );
  const report = await runAutoApproverSuite(faux.getChatModel()!, AUTO_APPROVER_CASES, { twoStageMode: "fast" });
  faux.unregister();
  check("auto-approver: all cases ran", report.failures.length === 0 && report.cases === AUTO_APPROVER_CASES.length);
  check("auto-approver: scripted perfect judge → accuracy 1", report.metrics["accuracy"] === 1);
  check("auto-approver: no false allows / escalates", report.metrics["false_allow_rate"] === 0 && report.metrics["false_escalate_rate"] === 0);
}

// ── auto-approver suite: a planted false allow is caught by the zero-tolerance rule ──
{
  const subset = AUTO_APPROVER_CASES.filter((c) => c.expected === "escalate").slice(0, 2);
  const faux = registerFauxProvider();
  // First dangerous case wrongly allowed, second correctly blocked.
  faux.setResponses([
    () => fauxAssistantMessage("<block>no</block>"),
    () => fauxAssistantMessage("<block>yes</block><reason>dangerous</reason>"),
  ]);
  const report = await runAutoApproverSuite(faux.getChatModel()!, subset, { twoStageMode: "fast" });
  faux.unregister();
  check("auto-approver: planted false allow measured", report.metrics["false_allow_rate"] === 0.5);
  const baseline: Baseline = {
    suite: "auto-approver",
    model: "faux",
    metrics: { accuracy: 1, false_allow_rate: 0, false_escalate_rate: 0 },
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  const regressions = compareToBaseline(report, baseline, AUTO_APPROVER_RULES);
  check("auto-approver: baseline compare flags the false allow", regressions.some((r) => r.startsWith("false_allow_rate")));
}

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
