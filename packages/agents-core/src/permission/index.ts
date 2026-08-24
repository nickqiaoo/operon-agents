export type {
  PermissionMode,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
  ApprovalRequest,
  ApprovalRequestOptions,
  ApprovalResponse,
  QuestionOption,
  QuestionItem,
  QuestionRequest,
  QuestionAnswerValue,
  QuestionAnswers,
  QuestionAnswerMethod,
  QuestionResponse,
  QuestionResult,
  Responder,
  AutoApprover,
  AutoApprovalInput,
  AutoApprovalVerdict,
} from "./types.ts";
export { PermissionManager } from "./manager.ts";
export type { AuthorizeProviders, PermissionManagerOptions } from "./manager.ts";
export { parsePattern, matchPermissionRule, permissionPatternError } from "./matches-rule.ts";
export { createPolicies } from "./policies.ts";
export {
  LlmAutoApprover,
  buildClassifierSystemPrompt,
  CLASSIFIER_BASE_PROMPT,
  CLASSIFIER_PERMISSIONS_TEMPLATE,
  type AutoApprovalOutcome,
  type AutoApprovalReport,
  type ClassifierRules,
  type LlmAutoApproverOptions,
  type TwoStageMode,
} from "./auto-approver/index.ts";
