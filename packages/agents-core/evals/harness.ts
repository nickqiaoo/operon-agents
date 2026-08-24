/**
 * Minimal eval harness: a suite produces a `SuiteReport` (aggregate metrics over a dataset),
 * and the baseline layer answers "did this get better or worse" against a committed JSON.
 *
 * This is deliberately a consumer of existing signals (compaction tokensBefore/After, the
 * auto-approver's verdicts), not a new telemetry layer.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SuiteReport {
  readonly suite: string;
  readonly model: string;
  readonly cases: number;
  /** Aggregate metric name → value. All metrics are numbers so baselines diff mechanically. */
  readonly metrics: Record<string, number>;
  /** Per-case hard failures (harness errors, not model-quality misses). */
  readonly failures: readonly string[];
}

export interface RegressionRule {
  readonly metric: string;
  /** Which direction is good. A move in the bad direction beyond `tolerance` is a regression. */
  readonly direction: "higher-better" | "lower-better";
  /** Absolute slack before a bad move counts. 0 means any bad move regresses. */
  readonly tolerance: number;
}

export interface Baseline {
  readonly suite: string;
  readonly model: string;
  readonly metrics: Record<string, number>;
  readonly updatedAt: string;
}

export function loadBaseline(path: string): Baseline | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Baseline;
  } catch {
    return undefined;
  }
}

export function writeBaseline(path: string, report: SuiteReport): void {
  const baseline: Baseline = {
    suite: report.suite,
    model: report.model,
    metrics: report.metrics,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** Regression descriptions, empty when the report holds the baseline. */
export function compareToBaseline(
  report: SuiteReport,
  baseline: Baseline,
  rules: readonly RegressionRule[],
): string[] {
  const regressions: string[] = [];
  for (const rule of rules) {
    const current = report.metrics[rule.metric];
    const base = baseline.metrics[rule.metric];
    if (current === undefined || base === undefined) continue;
    const delta = rule.direction === "higher-better" ? base - current : current - base;
    if (delta > rule.tolerance) {
      regressions.push(
        `${rule.metric}: ${base.toFixed(4)} → ${current.toFixed(4)} (${rule.direction}, tolerance ${rule.tolerance})`,
      );
    }
  }
  return regressions;
}

export function printReport(report: SuiteReport, baseline: Baseline | undefined, regressions: readonly string[]): void {
  console.log(`\n═══ ${report.suite} — ${report.model} (${report.cases} cases) ═══`);
  for (const [name, value] of Object.entries(report.metrics)) {
    const base = baseline?.metrics[name];
    const vs = base === undefined ? "" : `  (baseline ${base.toFixed(4)})`;
    console.log(`  ${name.padEnd(24)} ${value.toFixed(4)}${vs}`);
  }
  for (const failure of report.failures) console.log(`  ⚠️  ${failure}`);
  if (baseline === undefined) {
    console.log("  (no baseline — run with --update-baseline to record one)");
  } else if (regressions.length === 0) {
    console.log("  ✅ holds baseline");
  } else {
    for (const r of regressions) console.log(`  ❌ regression: ${r}`);
  }
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
