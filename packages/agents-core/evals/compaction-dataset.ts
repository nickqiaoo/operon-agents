/**
 * Compaction eval dataset: multi-turn conversations with "needle" facts planted in the
 * prefix that gets summarized. A faithful summary must carry every needle verbatim —
 * needles are chosen to be identifiers a summary keeps as-is (paths, error strings,
 * versions, commands), not prose it would reword.
 *
 * The last 4 messages of each case are neutral tail: with the default strategy config
 * they stay verbatim after compaction, so needles must live strictly before them.
 */
import type { Message } from "../src/protocol/index.ts";
import { fauxAssistantMessage } from "../src/test/faux.ts";

export interface CompactionEvalCase {
  readonly id: string;
  readonly messages: readonly Message[];
  /** Substrings that must survive into the summary (case-insensitive match). */
  readonly needles: readonly string[];
}

let ts = 1_000;
function u(text: string): Message {
  ts += 1;
  return { role: "user", content: [{ type: "text", text }], timestamp: ts };
}
function a(text: string): Message {
  ts += 1;
  return fauxAssistantMessage(text, { timestamp: ts });
}

export const COMPACTION_CASES: readonly CompactionEvalCase[] = [
  {
    id: "bugfix-session",
    needles: [
      "src/billing/invoice.ts",
      "TypeError: Cannot read properties of undefined (reading 'total')",
      "roundHalfEven",
      "pnpm test --filter billing",
    ],
    messages: [
      u("Invoicing throws intermittently in production — please dig into it. The log says TypeError: Cannot read properties of undefined (reading 'total')."),
      a("Let me trace where that error comes from. The stack puts it in the invoice summary step, so I will read the relevant code."),
      u("The code is in src/billing/invoice.ts — the rounding logic changed yesterday."),
      a("I read src/billing/invoice.ts: summarize() returns undefined when lineItems is an empty array, and the caller reads .total straight off it, which is the TypeError. Rounding was also switched to roundHalfEven, but the empty-invoice path has no fallback."),
      u("Fix it then — an empty invoice should return an all-zero summary instead of throwing."),
      a("Fixed: summarize() now returns {total: 0, tax: 0} for empty lineItems, keeping roundHalfEven rounding. The verification command is pnpm test --filter billing, and all 12 cases pass."),
      u("While you are there, confirm no other caller has the same problem."),
      a("I checked all 3 callers. Only invoice.ts destructures .total directly; the rest already guard against null. The fix is complete."),
      u("Good — now tidy the changes up."),
      a("The changes are tidied; only one file was touched."),
      u("Write a short note about it."),
      a("Note: fixes the empty-invoice crash — empty lineItems now return an all-zero summary."),
    ],
  },
  {
    id: "perf-investigation",
    needles: [
      "PostgreSQL 16.3",
      "idx_orders_created_at",
      "p99 340ms",
      "ANALYZE orders",
    ],
    messages: [
      u("The order-list endpoint got slower — look into the database side."),
      a("First, the environment: the database is PostgreSQL 16.3, and the slow query is the one paginating by created_at descending."),
      u("Yes, that one. What is the latency right now?"),
      a("Monitoring shows p99 340ms and p50 45ms. EXPLAIN shows a sequential scan — the index is not being hit."),
      u("Why is it not using the index?"),
      a("idx_orders_created_at exists on the table, but stale statistics made the planner misestimate. After running ANALYZE orders, EXPLAIN shows an index scan."),
      u("Should we automate that?"),
      a("I suggest lowering autovacuum_analyze_scale_factor to 0.02 for this table, so statistics refresh sooner under heavy writes."),
      u("Fine — write it down, but do not touch production yet."),
      a("Recorded as a to-do; no production config was changed."),
      u("Let us stop here for today."),
      a("Understood — the investigation findings are summarized."),
    ],
  },
  {
    id: "migration-plan",
    needles: [
      "pnpm install --frozen-lockfile",
      "packages/agents-core",
      "0.1.0-alpha.0",
      "publishConfig",
    ],
    messages: [
      u("We are about to cut the first release of the monorepo packages — let us walk through the steps."),
      a("Here they are: the main entrypoint package depends on packages/agents-core, so core must be published before the entrypoint."),
      u("What version number should we use?"),
      a("For the first release I suggest 0.1.0-alpha.0, meaning the API is unstable and breaking changes are allowed."),
      u("What should CI watch out for when installing dependencies?"),
      a("CI must use pnpm install --frozen-lockfile, which fails outright on a mismatched lockfile and prevents phantom dependency drift."),
      u("What about the private package field?"),
      a("packages/agents-core is currently marked private; that has to be removed before publishing. To publish to our own registry, add a publishConfig field as well."),
      u("Good, let us go with that."),
      a("Plan confirmed; we will follow it from here."),
      u("Do not actually publish yet."),
      a("Understood — prepare the version only, no publish."),
    ],
  },
];
