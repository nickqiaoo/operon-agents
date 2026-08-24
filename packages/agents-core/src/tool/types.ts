import type { ImageContent, TextContent, ToolSchema } from "../protocol/index.ts";
import type { ToolAccesses } from "./access.ts";
import type { Machine } from "./machine.ts";
import type { BackgroundSpawner } from "./background.ts";
import type { FileFreshnessLedger } from "./file-freshness.ts";
import type { QuestionResponder } from "./questions.ts";

export type { ToolAccesses, ToolResourceAccess, ToolFileAccess } from "./access.ts";

export interface ToolDisplay {
  readonly title?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

export interface ToolUpdate {
  readonly kind: "stdout" | "stderr" | "progress" | "status" | "custom";
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export type ToolResultContent = (TextContent | ImageContent)[];

/**
 * What a suspending tool wants from the user — the user-facing half of a durable
 * mid-execution interrupt (`ToolRunContext.suspend`). Surfaced to the caller on the
 * paused run's pending list; the private continuation `state` travels separately.
 */
export interface ToolInputRequest {
  /** Discriminator for renderers, e.g. "question" | "oauth" | app-defined. */
  readonly kind?: string;
  /** Renderable payload (question items, an auth URL, a plan preview, …). */
  readonly display?: unknown;
}

/** Continuation of a previously suspended call, present on its re-run. */
export interface ToolResumeContext {
  /** The state passed to `suspend` (a JSON snapshot), if any was given. */
  readonly state?: unknown;
  /** The caller's answer from `Runner.resume`. Always delivered: an unanswered
   *  suspended call is re-parked by the framework instead of being re-run. */
  readonly answer: unknown;
}

export interface ToolResult<Details = unknown> {
  readonly content: ToolResultContent;
  readonly details?: Details;
  /**
   * Tool definitions made available by this result. pi 0.81 uses these names
   * as the transcript load point for native deferred-tool serialization.
   */
  readonly addedToolNames?: readonly string[];
  readonly isError?: boolean;
  readonly stopTurn?: boolean;
}

/**
 * The call identity + execution surface shared by the resolve phase and the run phase of
 * one tool call. New fields needed by both phases belong here, not on both subtypes.
 */
export interface ToolContextBase {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly machine: Machine;
  /**
   * Journal address of the frame running this call — `main` for the root agent, `main/<agentId>`
   * for a subagent. It is the frame's identity: what `agent.started`/`agent.ended` events carry,
   * and what `Session.steerTo` addresses. A tool that coordinates between agents needs it to know
   * which one it is running inside.
   */
  readonly address?: string;
  /**
   * Session-scoped file freshness ledger (read-before-write / staleness checks); at
   * resolve time it supports pre-approval validation. The runner always provides it;
   * tools that depend on it must fail closed when absent (a hand-built context without
   * one), never skip the check silently.
   */
  readonly fileLedger?: FileFreshnessLedger;
}

export interface ToolRunContext extends ToolContextBase {
  readonly onUpdate?: (update: ToolUpdate) => void;
  readonly background?: BackgroundSpawner;
  /**
   * Client channel for interactive questions (AskUserQuestion). Absent — or present
   * without `requestQuestion` — when the connected client cannot render questions;
   * tools must then fall back to asking in their text response.
   */
  readonly responder?: QuestionResponder;
  /**
   * Suspend this call durably: `state` (JSON-serializable, keep it small — spill big
   * data to your own storage and save a reference) is persisted with the interruption,
   * `request` is surfaced to the caller, and the whole run pauses. After the caller
   * answers via `Runner.resume`, this call re-runs with `resumed` populated. Note the
   * re-run repeats `resolve()` and everything in `run` before the suspend point — keep
   * side effects idempotent up to the saved state. Never returns.
   */
  readonly suspend: (request: ToolInputRequest, state?: unknown) => never;
  /** Present when this call is the re-run of a previously suspended call. */
  readonly resumed?: ToolResumeContext;
  /**
   * Fires when the caller requests this running call be moved to the background
   * (foreground → background). DISTINCT from `signal`: `signal` aborting means "stop/kill",
   * whereas `detachSignal` aborting means "detach the live work into a background task and
   * return a synthetic result — do NOT kill it". Present only for tools whose work can be
   * detached (a live process/subagent/workflow) on a session with the background capability.
   */
  readonly detachSignal?: AbortSignal;
}

export interface ToolPlan {
  readonly approvalRule: string;
  readonly matchesRule?: (ruleArgs: string) => boolean;
  readonly accesses?: ToolAccesses;
  readonly display?: ToolDisplay;
  readonly stopBatchAfterThis?: boolean;
  readonly handoff?: { readonly targetAgentName: string };
  readonly controlFlow?: boolean;
  readonly run: (ctx: ToolRunContext) => Promise<ToolResult>;
}

export interface ToolResolveContext extends ToolContextBase {}

export interface Tool {
  readonly schema: ToolSchema;
  resolve(args: unknown, ctx: ToolResolveContext): ToolPlan | Promise<ToolPlan>;
  /**
   * Compact, security-relevant projection of this tool call for the `auto`-mode judge
   * (and for the prior tool calls it reconstructs from the transcript). Examples: the
   * `command` for Bash, `"path: <new content>"` for Write/Edit. Return `""` to declare
   * the call has no security relevance — the judge then skips it (allow, and omit it
   * from the transcript). When omitted, the judge falls back to a generic projection of
   * the arguments.
   */
  toAutoApprovalInput?(args: unknown): unknown;
}
