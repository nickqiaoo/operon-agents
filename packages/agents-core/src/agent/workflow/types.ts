/**
 * Shared types for the Workflow tool — a deterministic JS orchestration runtime
 * built on this framework's subagent runner.
 *
 * The runtime (`runtime.ts`) is framework-agnostic: it speaks only to the host
 * through `WorkflowHostHooks`. The host (`Runner.buildWorkflowTool`) implements
 * those hooks against `runLoop` / `ConversationContext`, so token usage and
 * structured output are backed by real accounting rather than stubs.
 */

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
}

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  /** Everything after the `export const meta = {...}` statement. */
  scriptBody: string;
}

/** Options accepted by the in-script `agent(prompt, opts)` hook. */
export interface AgentHookOptions {
  label?: string;
  phase?: string;
  /** JSON Schema — when present, the subagent must return a matching object. */
  schema?: Record<string, unknown>;
  model?: string;
  /** Subagent type to spawn (resolved against the parent's available agents). */
  agentType?: string;
  /** When 'worktree', request isolation (best-effort; see host). */
  isolation?: string;
}

/** One agent execution as the host runs it. */
export interface WorkflowAgentRunArgs {
  readonly index: number;
  readonly prompt: string;
  readonly label: string;
  readonly phase?: string;
  readonly model?: string;
  readonly agentType?: string;
  readonly isolation?: string;
  /** When set, the host must force + validate structured output against this schema. */
  readonly schema?: Record<string, unknown>;
  readonly signal: AbortSignal;
  /**
   * Called once the host has assigned the subagent its identity, BEFORE running it — lets
   * the runtime journal a `started` marker and correlate orchestration progress with the
   * child's full Session AgentEvent stream.
   */
  readonly onStart: (identity: WorkflowAgentIdentity) => void;
}

export interface WorkflowAgentIdentity {
  readonly agentId: string;
  readonly address: string;
}

export interface WorkflowAgentRunResult extends WorkflowAgentIdentity {
  /** The subagent's answer: a parsed object when `schema` was set, else the text. */
  readonly value: unknown;
  /** Output tokens spent by this agent across all internal attempts. */
  readonly outputTokens: number;
}

/** Progress event emitted by the runtime back to the host (for display). */
// Defined in events/: the same shape travels as an AgentEvent and is folded by the
// SessionProjection, so there is one declaration rather than two that can drift.
import type { WorkflowProgressEvent } from "../../events/index.ts";
export type { WorkflowProgressEvent, WorkflowAgentRecord } from "../../events/index.ts";

/** Token budget directive for the turn. `total: null` = unbounded. */
export interface WorkflowBudget {
  total: number | null;
  /** Output tokens already spent this turn OUTSIDE the workflow (its baseline). */
  getTurnSpent: () => number;
}

/**
 * Host callbacks the runtime uses to talk back to the tool layer. Keeps the
 * sandbox runtime decoupled from the runner / subagent machinery.
 */
export interface WorkflowHostHooks {
  /** Run one subagent to completion. Resolves with its value + output-token spend. */
  runAgent: (args: WorkflowAgentRunArgs) => Promise<WorkflowAgentRunResult>;
  /** Emit a progress event (phase started / agent state change / log line). */
  emitProgress: (event: WorkflowProgressEvent) => void;
  /** Resolve a named/saved workflow's script for the `workflow()` hook. */
  resolveWorkflowScript?: (name: string) => Promise<string | null>;
  /** Max number of concurrent agents. */
  concurrency: number;
  budget: WorkflowBudget;
  abortSignal: AbortSignal;
}

export const WORKFLOW_SCRIPT_MAX_BYTES = 524_288;
export const WORKFLOW_VM_TIMEOUT_MS = 30_000;
export const WORKFLOW_AGENT_CAP = 1000;
/** Max items a single parallel()/pipeline() call accepts. */
export const WORKFLOW_MAX_ITEMS_PER_CALL = 4096;
/** Absolute per-agent timeout — a hung subagent is aborted after this. */
export const WORKFLOW_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
