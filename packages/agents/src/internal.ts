/**
 * `operon-agents/internal` — low-level engine plumbing (re-exports `operon-agents-core/internal`).
 *
 * NOT part of the stable public API. The turn/step loop, retry, tool scheduling,
 * store blob/migration/index machinery, capability assembly, and file-op / shell-rule helpers.
 * No stability guarantees — prefer the main `operon-agents` surface.
 */
export * from "operon-agents-core/internal";
export { setHarnessCloseTimeoutsForTest } from "./harness.ts";
