/**
 * `operon-agents-core/internal` — low-level engine plumbing.
 *
 * NOT part of the stable public API and NOT re-exported from the main `operon-agents-core`
 * (or `operon-agents`) surface. These are implementation internals — the turn/step loop,
 * retry, tool scheduling, the store blob/migration/index machinery, capability
 * assembly, and file-op / shell-rule helpers — exposed on a dedicated subpath for advanced
 * embedders. No stability guarantees; prefer the main surface.
 */

// ── loop: the turn/step engine ───────────────────────────────────────────────
export { runTurn } from "./loop/run-turn.ts";
export type { RunTurnInput } from "./loop/run-turn.ts";
export { executeStep } from "./loop/turn-step.ts";
export type { ExecuteStepDeps, StepResult, RecordUsageResult } from "./loop/turn-step.ts";
export { streamWithRetry, DEFAULT_MAX_RETRIES_PER_STEP } from "./llm/retry.ts";
export type { StreamWithRetryInput, StreamWithRetryResult, StepRetryingEvent, StepResetEvent } from "./llm/retry.ts";
export { runToolCallBatch, runCalls } from "./loop/tool-call.ts";
export type { ToolCallStepContext, ToolBatchResult } from "./loop/tool-call.ts";
export { ToolScheduler } from "./loop/scheduler.ts";
export type { ToolCallTask } from "./loop/scheduler.ts";

// ── store: blobs, wire migration, disk catalog ───────────────────────────────
export { BlobStore, diskBlobIO, isBlobRef, offloadRecord, rehydrateRecord } from "./store/blob-store.ts";
export type { BlobStoreOptions, BlobIO } from "./store/blob-store.ts";
export { WIRE_PROTOCOL_VERSION, WIRE_VERSION_KEY, RECORD_MIGRATIONS, migrateRecord } from "./store/migrate.ts";
export type { RecordMigration } from "./store/migrate.ts";
export { encodeWorkdirKey, normalizeWorkDir, slugifyWorkDirName } from "./store/workdir-key.ts";
export { sessionCatalogPath, appendSessionCatalogRecord, readSessionCatalog } from "./store/session-catalog.ts";
export type { DiskSessionCatalogEntry, DiskSessionCatalogRecord } from "./store/session-catalog.ts";

// ── tool: file-op and shell-rule helpers, SSH transport internals ────────────
export {
  readTextFile,
  writeTextFile,
  decodeText,
  fileVersionFromInfo,
  normalizeForCompare,
} from "./tool/support/machine-ops.ts";
export {
  matchesBashRule,
  matchWildcardPattern,
  permissionRuleExtractPrefix,
  scanShellCommand,
  singleCommandMatchesRule,
  stripSafeEnvPrefix,
} from "./tool/support/bash-rule-match.ts";
export { SshProcess, buildSshExecCommand, sshShellQuote } from "./tool/machine-ssh.ts";

// ── agent: test-only hooks ────────────────────────────────────────────────────
export { setSessionCloseTimeoutsForTest } from "./agent/session.ts";

// ── capabilities: the assembler (Runner-internal wiring) ─────────────────────
export { assembleCapabilities, AssembledCapabilities } from "./capabilities/assembler.ts";
export type { AssembleCapabilitiesOptions } from "./capabilities/assembler.ts";

// ── testing: scope-wiring helpers (a flat options bag → harness/session scopes) ──────────────
export {
  testHarnessScope,
  wireTestSession,
  testRunner,
  openTestSession,
  testSessionScope,
  testProvisionContext,
  testRunContext,
  openCapability,
} from "./testing.ts";
export type { TestSessionWiring, TestRunnerOptions, TestSessionOptions, TestCapabilityHandle } from "./testing.ts";
