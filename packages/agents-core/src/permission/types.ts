import type { ResolvedToolExecutionHookContext } from "../loop/types.ts";
import type { Message } from "../protocol/index.ts";
import type { Tool } from "../tool/types.ts";
import type { QuestionResponder } from "../tool/questions.ts";

// The question contract lives at tool altitude (tool/questions.ts) so ToolRunContext
// can carry it; re-exported here because responder implementers import it from permission/.
export type {
  QuestionOption,
  QuestionItem,
  QuestionRequest,
  QuestionAnswerValue,
  QuestionAnswers,
  QuestionAnswerMethod,
  QuestionResponse,
  QuestionResult,
  QuestionResponder,
} from "../tool/questions.ts";

export type PermissionRuleDecision = "allow" | "deny" | "ask";
export type PermissionRuleScope = "turn-override" | "session-runtime" | "project" | "user";

// `auto` is the model-judged tier: the static chain runs first (deny/approve short-circuit),
// and any residual `ask` is handed to an injected `AutoApprover` instead of prompting a human.
export type PermissionMode = "manual" | "workspace" | "yolo" | "auto";

export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface ApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly approvalRule: string;
  readonly display?: unknown;
}

export interface ApprovalResponse {
  readonly decision: "approved" | "rejected" | "cancelled";
  readonly scope?: "session";
  readonly feedback?: string;
}

export interface ApprovalRequestOptions {
  readonly signal?: AbortSignal;
}

export interface Responder extends QuestionResponder {
  requestApproval(request: ApprovalRequest, options?: ApprovalRequestOptions): Promise<ApprovalResponse>;
  /**
   * Whether this responder answers approvals live (inline) right now. When it returns `false`,
   * the run does not consult `requestApproval` and instead interrupts durably — persisting a
   * interruption state and handing control back to the caller to resume later (possibly cross-process).
   * Absent ⇒ treated as `true` (live), preserving the live-answer default. Note this gates only
   * approvals (not questions): returning `true` means it will *answer* the approval inline, not
   * that it will approve it.
   */
  isLiveApprover?(): boolean;
}

export type PermissionPolicyContext = ResolvedToolExecutionHookContext;

export type PermissionDecisionReason = Readonly<Record<string, string | number | boolean | null>>;

export type PermissionPolicyResult =
  | { readonly kind: "approve"; readonly reason?: PermissionDecisionReason }
  | { readonly kind: "deny"; readonly reason?: PermissionDecisionReason; readonly message?: string }
  | {
      readonly kind: "ask";
      readonly reason?: PermissionDecisionReason;
      readonly resolveApproval?: (response: ApprovalResponse) => PermissionPolicyResult | undefined;
      // In `auto` mode, whether the model judge may clear this ask (default true). Set false
      // for asks that must always reach a human — e.g. an explicit user "ask me for X" rule.
      readonly classifierApprovable?: boolean;
    };

export interface PermissionPolicy {
  readonly name: string;
  evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;
}

/** Input handed to the `auto`-mode judge for a single would-prompt action. */
export interface AutoApprovalInput {
  /** The action under review (tool name / args / tool / model / signal). */
  readonly ctx: ResolvedToolExecutionHookContext;
  /** Conversation so far. The judge sanitises this (user text + tool calls only). */
  readonly transcript: readonly Message[];
  /** The approval-rule subject the static chain produced for this action. */
  readonly approvalRule: string;
  /** Tool registry, so the judge can project prior tool calls in the transcript faithfully. */
  readonly tools?: readonly Tool[];
}

export interface AutoApprovalVerdict {
  /** `allow` proceeds without a human; `escalate` falls back to the normal approval prompt. */
  readonly decision: "allow" | "escalate";
  readonly reason?: string;
}

/**
 * The `auto`-mode judge. Consulted by the PermissionManager only for actions the static
 * policy chain would otherwise prompt on (and that are `classifierApprovable`). Implementations
 * must be fail-closed — return `escalate` on any uncertainty rather than `allow`.
 */
export interface AutoApprover {
  classify(input: AutoApprovalInput): Promise<AutoApprovalVerdict>;
}
