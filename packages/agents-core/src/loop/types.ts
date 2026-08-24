import type { ChatModel } from "../llm/define-model.ts";
import type { LlmRequest } from "../llm/model.ts";
import type { AssistantMessage, Message, ToolCall, Usage } from "../protocol/index.ts";
import type { ConversationContext } from "./context.ts";
import type { Tool, ToolInputRequest, ToolPlan, ToolResult } from "../tool/types.ts";
import type { ToolCallSuspension } from "./interruption.ts";

export type StepStopReason =
  | "tool_use"
  | "end_turn"
  | "handoff"
  | "interrupt"
  | "max_tokens"
  | "error"
  | "aborted";

export type TerminalStepStopReason = Exclude<StepStopReason, "tool_use">;

export type TurnStopReason = TerminalStepStopReason;

/** Per-model-step output guardrail adapter. The agent layer creates this monitor; the loop
 * only feeds it optimistic text deltas and waits for it before sealing the assistant message. */
export interface OutputGuardrailMonitor {
  /** Child signal aborted when an optimistic streaming check trips. */
  readonly signal: AbortSignal;
  /** Observe a text delta after it has been surfaced to live event consumers. */
  observeTextDelta(delta: string): void;
  /** Discard provisional text when the model retry layer resets the current attempt. */
  reset(): void;
  /** Finish outstanding checks. `runFinal` preserves the old final-output-only semantics. */
  finish(output: string, runFinal: boolean, usage: Usage): Promise<void>;
  /** Settle a check that may have aborted the underlying model stream, surfacing its error. */
  settle(): Promise<void>;
  dispose(): void;
}

export interface OutputGuardrailMonitorOptions {
  readonly turnId: string;
  readonly step: number;
  readonly stepId: string;
  readonly signal: AbortSignal;
}

export type OutputGuardrailMonitorFactory = (
  options: OutputGuardrailMonitorOptions,
) => OutputGuardrailMonitor;

/** A tool call waiting for a permission decision (produced at authorization time —
 *  the whole batch suspends before anything runs). */
export interface PendingApprovalInterrupt {
  readonly kind: "approval";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly approvalRule: string;
  readonly policyName?: string;
  readonly display?: unknown;
}

/** A tool call that suspended itself mid-execution via `ctx.suspend` (sibling calls
 *  have already completed and are journaled). */
export interface PendingInputInterrupt {
  readonly kind: "input";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly request: ToolInputRequest;
  /** Continuation state saved by the tool. Internal — stripped from public projections. */
  readonly state?: unknown;
}

/** Anything a paused run is waiting on the caller for. */
export type PendingInterrupt = PendingApprovalInterrupt | PendingInputInterrupt;

/**
 * Resume payload for re-running an interrupted tool batch: the paused frame's pending
 * entries plus the caller's input answers. Approval answers travel separately (through
 * the authorize hook); this only carries what the tool-call layer itself consumes —
 * which suspended calls may run (`inputAnswers` has their key) and which re-park.
 */
export interface BatchResume {
  readonly pending: readonly PendingInterrupt[];
  readonly inputAnswers: Readonly<Record<string, unknown>>;
}

export interface HandoffSignal {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly targetAgentName: string;
  readonly args: unknown;
}

export interface TurnResult {
  readonly stopReason: TurnStopReason;
  readonly steps: number;
  readonly usage: Usage;
  readonly handoff?: HandoffSignal;
  readonly pending?: readonly PendingInterrupt[];
  readonly suspensions?: readonly ToolCallSuspension[];
}

export interface StepHookContext {
  readonly turnId: string;
  readonly stepNumber: number;
  /** Conversation shard for the active root/subagent/workflow frame. */
  readonly address?: string;
  readonly signal: AbortSignal;
  readonly model: ChatModel;
}

export interface ContextStepHookContext extends StepHookContext {
  /** Live model-visible history — READONLY. To change history, go through the journaled
   *  mutators on `context` (`appendMessage`/`replaceHistory`); mutating this array directly
   *  would bypass the journal and silently diverge live state from replay. */
  readonly messages: readonly Message[];
  readonly context: ConversationContext;
  readonly system?: string;
}

export interface ToolExecutionHookContext extends StepHookContext {
  readonly toolCall: ToolCall;
  readonly tool?: Tool;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly plan: ToolPlan;
}

export interface AuthorizeToolExecutionResult {
  readonly block?: boolean;
  readonly reason?: string;
  readonly syntheticResult?: ToolResult;
  readonly executionMetadata?: unknown;
  readonly interrupt?: PendingApprovalInterrupt;
}

export interface PrepareToolExecutionResult extends AuthorizeToolExecutionResult {
  readonly updatedArgs?: unknown;
  /** With `block`: end the turn after this batch instead of feeding the denial back to the
   *  model. Ignored unless the call is blocked — a `syntheticResult` carries its own `stopTurn`. */
  readonly terminate?: boolean;
}

export interface FinalizeToolResultContext extends ToolExecutionHookContext {
  readonly result: ToolResult;
}

export interface AfterStepContext extends ContextStepHookContext {
  readonly usage: Usage;
  readonly stopReason: StepStopReason;
}

export interface StoppedStepContext extends StepHookContext {
  readonly usage: Usage;
  readonly stopReason: TerminalStepStopReason;
}

export interface BeforeStepResult {
  readonly block?: boolean;
  readonly reason?: string;
  /** Replace the system prompt for THIS step only. Chained across hooks in registration order;
   *  the step's own `deps.system` is untouched, so the next step re-resolves from the agent. */
  readonly system?: string;
}

/** Context for the once-per-run hook that sees the caller's input before it enters history. */
export interface BeforeRunContext {
  readonly sessionId: string;
  readonly address: string;
  /** Name of the agent about to run (the conversation head's agent, post-handoff resolution). */
  readonly agent: string;
  readonly signal: AbortSignal;
  readonly input: readonly Message[];
}

export interface BeforeRunResult {
  /** Replace the input messages before they are appended + journaled. */
  readonly input?: readonly Message[];
  /**
   * Answer the prompt without running the agent at all: no turn, no model call, nothing
   * journaled. The run settles as `status: "skipped"` carrying `output`. The FIRST hook to
   * claim it wins — later hooks are not consulted, since the run is already decided.
   */
  readonly handled?: { readonly output?: string };
}

export interface AfterStepResult {
  readonly stopTurn?: boolean;
}

export interface BeforeModelRequestContext extends StepHookContext {
  readonly request: LlmRequest;
  readonly context: ConversationContext;
}

export interface BeforeModelRequestResult {
  readonly request?: LlmRequest;
  readonly block?: boolean;
  readonly reason?: string;
}

export interface AfterModelResponseContext extends StepHookContext {
  readonly request: LlmRequest;
  readonly response: AssistantMessage;
  readonly context: ConversationContext;
}

export interface ShouldContinueAfterStopResult {
  readonly continue: boolean;
}

/** Context for the step-failure recovery hook. Extends the step-context shape so a claimant
 *  (compaction) can act on live history the same way `beforeStep` does. */
export interface RecoverStepErrorContext extends ContextStepHookContext {
  /** The error the failed step threw (e.g. `APIContextOverflowError`). */
  readonly error: unknown;
  /** 1-based count of recovery attempts within this turn, including this one. */
  readonly attempt: number;
}

export interface RecoverStepErrorResult {
  /** `true` claims the error: the loop re-runs the failed step (without consuming its step
   *  budget). The claimant must already have changed what made the step fail — a claim that
   *  fixed nothing just burns a recovery attempt. */
  readonly recovered: boolean;
}

// Hook function types + the LoopHooks machine.

export type BeforeStepHook = (ctx: ContextStepHookContext) => Promise<BeforeStepResult | undefined>;
export type AfterStepHook = (ctx: AfterStepContext) => Promise<AfterStepResult | void>;
export type BeforeModelRequestHook = (
  ctx: BeforeModelRequestContext,
) => Promise<BeforeModelRequestResult | undefined>;
export type AfterModelResponseHook = (
  ctx: AfterModelResponseContext,
) => Promise<AssistantMessage | undefined>;
export type PrepareToolExecutionHook = (
  ctx: ToolExecutionHookContext,
) => Promise<PrepareToolExecutionResult | undefined>;
export type AuthorizeToolExecutionHook = (
  ctx: ResolvedToolExecutionHookContext,
) => Promise<AuthorizeToolExecutionResult | undefined>;
export type FinalizeToolResultHook = (ctx: FinalizeToolResultContext) => Promise<ToolResult | undefined>;
export type ShouldContinueAfterStopHook = (
  ctx: StoppedStepContext,
) => Promise<ShouldContinueAfterStopResult | undefined>;
export type BeforeRunHook = (ctx: BeforeRunContext) => Promise<BeforeRunResult | undefined>;
/** Consulted when a step THROWS (not when it stops with an error message). First claim wins. */
export type RecoverStepErrorHook = (
  ctx: RecoverStepErrorContext,
) => Promise<RecoverStepErrorResult | undefined>;

/**
 * `beforeRun` and `shouldContinueAfterStop` are RUN-tier, not step-tier: the capability
 * assembler pulls them out of this bag and the Runner drives them directly (see
 * `AssembledCapabilities`). They live here so a capability declares all of its interception
 * points in one place.
 */
export interface LoopHooks {
  beforeRun?: BeforeRunHook;
  beforeStep?: BeforeStepHook;
  afterStep?: AfterStepHook;
  beforeModelRequest?: BeforeModelRequestHook;
  afterModelResponse?: AfterModelResponseHook;
  prepareToolExecution?: PrepareToolExecutionHook;
  authorizeToolExecution?: AuthorizeToolExecutionHook;
  finalizeToolResult?: FinalizeToolResultHook;
  shouldContinueAfterStop?: ShouldContinueAfterStopHook;
  recoverStepError?: RecoverStepErrorHook;
}
