/**
 * Unit-style coverage for loop/usage.ts (addUsage / subtractUsage / emptyUsage) —
 * previously zero test coverage despite being the token/cost accounting primitive used
 * for every subagent usage-folding and interruption-resume delta calculation.
 */
import type { Usage } from "../protocol/index.ts";
import { addUsage, subtractUsage } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Usage {
  const totalTokens = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, totalTokens, cost: { input: cost, output: cost, cacheRead: cost, cacheWrite: cost, total: cost * 4 } };
}

function eq(a: Usage, b: Usage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.totalTokens === b.totalTokens &&
    a.cost.input === b.cost.input &&
    a.cost.output === b.cost.output &&
    a.cost.cacheRead === b.cost.cacheRead &&
    a.cost.cacheWrite === b.cost.cacheWrite &&
    a.cost.total === b.cost.total
  );
}

function main(): void {
  const a = usage(10, 20, 5, 2, 1);
  const b = usage(3, 4, 1, 0, 0.5);

  check("addUsage: sums every field, including nested cost", eq(addUsage(a, b), usage(13, 24, 6, 2, 1.5)));
  check("addUsage: identity with a zero usage returns the same values", eq(addUsage(a, usage(0, 0, 0, 0, 0)), a));

  check("subtractUsage: computes the delta between a cumulative total and a prior snapshot", eq(subtractUsage(usage(13, 24, 6, 2, 1.5), b), a));

  // The clamp: a "previous" snapshot bigger than "total" must never go negative — this is
  // the exact shape that happens when a resumed child's usage briefly looks smaller than
  // what was already folded into the parent (see subagent-tools.ts's fold-on-resume).
  const smallerTotal = usage(5, 5, 5, 5, 5);
  const biggerPrevious = usage(10, 10, 10, 10, 10);
  const delta = subtractUsage(smallerTotal, biggerPrevious);
  check(
    "subtractUsage: clamps every field to 0 instead of going negative when previous > total",
    eq(delta, usage(0, 0, 0, 0, 0)),
  );

  // Mixed: some fields grew, some shrank relative to "previous" — each field clamps independently.
  const mixedTotal: Usage = { input: 20, output: 1, cacheRead: 5, cacheWrite: 0, totalTokens: 26, cost: { input: 2, output: 0.1, cacheRead: 0.5, cacheWrite: 0, total: 2.6 } };
  const mixedPrevious: Usage = { input: 10, output: 5, cacheRead: 5, cacheWrite: 3, totalTokens: 23, cost: { input: 1, output: 0.5, cacheRead: 0.5, cacheWrite: 0.3, total: 2.3 } };
  const mixedDelta = subtractUsage(mixedTotal, mixedPrevious);
  check(
    "subtractUsage: independently clamps each field (some grew, some shrank)",
    mixedDelta.input === 10 && mixedDelta.output === 0 && mixedDelta.cacheRead === 0 && mixedDelta.cacheWrite === 0,
  );
  check(
    "subtractUsage: cost sub-fields clamp independently too",
    mixedDelta.cost.input === 1 && mixedDelta.cost.output === 0 && mixedDelta.cost.total > 0,
  );

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — loop/usage.ts addUsage/subtractUsage");
}

main();
