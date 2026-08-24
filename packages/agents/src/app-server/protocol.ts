/**
 * app-server wire protocol — the single source of truth for the cross-process
 * stdio API. Any language that wants to drive the harness implements this:
 * spawn the `operon-app-server` binary, speak NDJSON JSON-RPC 2.0 over stdio.
 *
 * This module is pure types + constants (no runtime deps), so it can be the
 * basis for generating clients / JSON Schema in other languages.
 *
 * Framing: one JSON-RPC 2.0 message per line (`\n`-delimited) on stdio.
 *   stdin  = host → server   stdout = server → host   stderr = logs only.
 *
 * Three message kinds and their directions:
 *   host → server  request       handshake / fleet / run-driving / control-plane
 *   server → host  response      the result of each host request
 *   server → host  notification  `session/event` (an AgentEvent, verbatim)
 *   server → host  request       reverse-RPC: `client/requestApproval` / `…Question`
 *   host → server  response      the host's answer to a reverse-RPC request
 */
import type {
  AgentEvent,
  AgentInput,
  ApprovalRequest,
  ApprovalResponse,
  PermissionMode,
  QuestionRequest,
  QuestionResult,
  RunResult,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
} from "operon-agents-core";

/** Bump on any breaking wire change. Integer, not semver. */
export const PROTOCOL_VERSION = 1;

// ── JSON-RPC 2.0 envelopes ──────────────────────────────────────────────────

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: R;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;

export interface JsonRpcNotification<P = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: P;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Method names ─────────────────────────────────────────────────────────────

export const Method = {
  // host → server
  Initialize: "initialize",
  SessionNew: "session/new",
  SessionResume: "session/resume",
  SessionFork: "session/fork",
  SessionList: "session/list",
  SessionClose: "session/close",
  SessionPrompt: "session/prompt",
  SessionSnapshot: "session/snapshot",
  SessionRespond: "session/respond",
  SessionSteer: "session/steer",
  SessionFollowUp: "session/follow_up",
  SessionCancel: "session/cancel",
  SessionInvoke: "session/invoke",
  // server → host (notification)
  SessionEvent: "session/event",
  // server → host (reverse-RPC request)
  ClientRequestApproval: "client/requestApproval",
  ClientRequestQuestion: "client/requestQuestion",
  // server → host (notification): a previously-sent reverse request is no longer needed
  ClientCancelRequest: "client/cancelRequest",
} as const;

export type MethodName = (typeof Method)[keyof typeof Method];

// ── Error codes ──────────────────────────────────────────────────────────────

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // app-server domain (-32000 … -32099)
  NotInitialized: -32000,
  SessionNotFound: -32001,
  RunAlreadyActive: -32002,
  CapabilityDisabled: -32003,
  /** A guardrail tripwire aborted the run — a policy block, not an internal failure. */
  GuardrailBlocked: -32004,
  ReverseRpcDeclined: -32010,
  RequestCancelled: -32011,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Handshake ────────────────────────────────────────────────────────────────

/** What the host can do — declared up front so the server only sends reverse-RPC
 *  the host is prepared to answer. */
export interface ClientCapabilities {
  /** Host can answer `client/requestApproval`. If false, the server never asks and
   *  falls back to its permission policy (manual mode → tools needing approval are rejected). */
  readonly approval?: boolean;
  /** Host can answer `client/requestQuestion`. If false, questions resolve to `null`. */
  readonly question?: boolean;
}

export interface InitializeParams {
  readonly protocolVersion: number;
  readonly clientInfo?: { readonly name: string; readonly version?: string };
  readonly clientCapabilities?: ClientCapabilities;
}

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly permissionModes: readonly PermissionMode[];
  /** Control-plane methods callable via `session/invoke`. */
  readonly invokableMethods: readonly string[];
}

// ── Fleet ────────────────────────────────────────────────────────────────────

export interface SessionNewParams {
  readonly workDir?: string;
  readonly title?: string;
  /** Per-session model id (`provider/model`), applied via setModel after creation. */
  readonly model?: string;
}

export interface SessionRef {
  readonly sessionId: string;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly workDir: string;
}

export interface SessionResumeParams extends SessionRef {}
export interface SessionForkParams extends SessionRef {
  readonly title?: string;
}
export interface SessionCloseParams extends SessionRef {}
export type SessionListResult = readonly SessionSummary[];

// ── Run driving ──────────────────────────────────────────────────────────────

export interface SessionPromptParams extends SessionRef {
  readonly input: AgentInput;
}
/** The `session/prompt` response. Arrives only when the run completes; events stream
 *  as `session/event` notifications in the meantime. When it carries `status:"interrupted"`,
 *  answer the `interruptions` and continue with `session/respond`. */
export type SessionPromptResult = RunResult;

/**
 * The projection read: the session's folded state (messages + in-flight turn per address).
 *
 * Late-join / reconnect contract — the seam is exact because stdout is one ordered stream:
 * every `session/event` notification the host received BEFORE this response was already
 * folded into the snapshot; every one received AFTER it is not. So a host rebuilding a
 * transcript discards notifications that arrived before the snapshot response and folds
 * the ones after — no loss, no duplicates. `lastEventId` is the diagnostic/correlation
 * watermark for that boundary; ordering still comes from this one channel, not from ids.
 */
export interface SessionSnapshotParams extends SessionRef {
  /** Only these addresses (exact match) in `agents`; the directory always covers all. */
  readonly addresses?: readonly string[];
  /** Cap each agent's `messages` to the last N (`messageCount` still reports the total).
   *  Defaults to 200. */
  readonly maxMessages?: number;
}
export type SessionSnapshotResult = SessionSnapshot;

/** Continue a durably-interrupted run: supply an approval answer per pending `toolCallId`
 *  (from the prior prompt/respond result's `interruptions`). The session must already be
 *  open (use `session/resume` first if resuming in a fresh process). Same result shape as
 *  `session/prompt` — it may interrupt again if further approvals are pending. */
export interface SessionRespondParams extends SessionRef {
  readonly answers: Record<string, ApprovalResponse>;
}
export type SessionRespondResult = RunResult;

export interface SessionSteerParams extends SessionRef {
  readonly text: string;
}
export interface SessionSteerResult {
  readonly accepted: boolean;
  /** Correlation id: matches the `steer.queued` event now and `origin.steerId` on the consuming `message.appended`. */
  readonly steerId: string;
}

/** Queue a user message for a new turn after the currently-running turn finishes. */
export interface SessionFollowUpParams extends SessionRef {
  readonly text: string;
}
export interface SessionFollowUpResult {
  /** False when the session has no active run; callers should use `session/prompt` instead. */
  readonly accepted: boolean;
  /** Correlation id (see `SessionSteerResult.steerId`); absent when not accepted. */
  readonly steerId?: string;
}

export interface SessionCancelParams extends SessionRef {}

// ── Control plane (generic reflection) ───────────────────────────────────────

export interface SessionInvokeParams extends SessionRef {
  /** One of `INVOKABLE_METHODS`. */
  readonly method: string;
  readonly args?: readonly unknown[];
}
export interface SessionInvokeResult {
  readonly value: unknown;
}

/**
 * The whitelist of `HarnessSession` methods reachable through `session/invoke`.
 * Run-driving (prompt/steer/follow_up/cancel), lifecycle (close), and handler registration
 * are deliberately excluded — they are first-class methods or host-side concerns.
 */
export const INVOKABLE_METHODS = [
  // runtime settings
  "setModel",
  "setThinking",
  "setPermissionMode",
  // goal
  "createGoal",
  "getGoal",
  "pauseGoal",
  "resumeGoal",
  "cancelGoal",
  "setGoalBudget",
  // plan
  "setPlanMode",
  "getPlan",
  "clearPlan",
  // compaction
  "compact",
  "pendingCompaction",
  "cancelCompaction",
  // skills
  "listSkills",
  "activateSkill",
  // plugins
  "listPlugins",
  "getPluginInfo",
  "installPlugin",
  "setPluginEnabled",
  "setPluginMcpServerEnabled",
  "removePlugin",
  "reloadPlugins",
  // background tasks
  "listBackgroundTasks",
  "readBackgroundTaskOutput",
  "readBackgroundTaskOutputDelta",
  "stopBackgroundTask",
  "detachTool",
  // slash commands — the serializable control surface for extensions (cron et al.):
  // per-feature cron RPCs are gone with the capability, /cron rides this instead.
  "runCommand",
  // conversation log
  "getRecords",
  // subagents
  "listSubagents",
  "reconcileSubagents",
  // context introspection
  "getContextBreakdown",
  // mcp
  "listMcpServers",
  "reconnectMcpServer",
] as const;

export type InvokableMethod = (typeof INVOKABLE_METHODS)[number];

// ── Notifications & reverse-RPC payloads ─────────────────────────────────────

/** `session/event` — an AgentEvent verbatim (already carries `sessionId` + `address`). */
export type SessionEventParams = AgentEvent;

export interface ClientRequestApprovalParams extends SessionRef {
  readonly request: ApprovalRequest;
}
export type ClientRequestApprovalResult = ApprovalResponse;

export interface ClientRequestQuestionParams extends SessionRef {
  readonly request: QuestionRequest;
}
export type ClientRequestQuestionResult = QuestionResult;

/** `client/cancelRequest` — the server no longer needs the answer to reverse request `id`. */
export interface ClientCancelRequestParams {
  readonly id: JsonRpcId;
}
