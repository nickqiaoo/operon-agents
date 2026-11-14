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
export { PermissionManager, AUTO_MODE_DENIAL_LIMITS } from "./manager.ts";
export type { AuthorizeProviders, PermissionManagerOptions } from "./manager.ts";
export { permissionDenialDetails, permissionDenialOf, type PermissionDenialDetails, type PermissionDenialKind } from "./denial.ts";
export { parsePattern, matchPermissionRule, permissionPatternError } from "./matches-rule.ts";
export { createPolicies } from "./policies.ts";
export {
  LlmAutoApprover,
  DecisionAutoApprover,
  createAutoApprover,
  buildClassifierSystemPrompt,
  defaultClassifierRules,
  resolveClassifierRules,
  CLASSIFIER_BASE_PROMPT,
  CLASSIFIER_PERMISSIONS_TEMPLATE,
  DEFAULT_RULES_TOKEN,
  type AutoApprovalOutcome,
  type AutoApprovalReport,
  type ClassifierRules,
  type ResolvedClassifierRules,
  type CreateAutoApproverOptions,
  type DecisionAutoApproverOptions,
  type LlmAutoApproverOptions,
  type TwoStageMode,
} from "./auto-approver/index.ts";
