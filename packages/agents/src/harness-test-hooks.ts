/** How long `HarnessSession.close()` waits for aborted runs to settle before continuing teardown. */
export const closeDeadlines = { runSettleMs: 5_000 };

/** Test-only (exported via `operon-agents/internal`): shrink the close deadlines. */
export function setHarnessCloseTimeoutsForTest(ms: { runSettle?: number }): void {
  if (ms.runSettle !== undefined) closeDeadlines.runSettleMs = ms.runSettle;
}
