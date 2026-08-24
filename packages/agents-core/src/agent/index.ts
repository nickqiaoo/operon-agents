export { Agent, defineAgent } from "./agent.ts";
export type { AgentConfig, AgentGuardrails, AgentRunContext } from "./agent.ts";

export { Handoff, handoff, getTransferMessage, toFunctionToolName } from "./handoff.ts";
export type { HandoffOptions, HandoffInputData, HandoffInputFilter } from "./handoff.ts";

export {
  GuardrailTripwireError,
  isGuardrailTripwireError,
  runInputGuardrails,
  runOutputGuardrails,
  toolGuardrail,
  toolInputGuardrailHook,
  toolOutputGuardrailHook,
} from "./guardrail.ts";
export type {
  GuardrailFunctionOutput,
  GuardrailStage,
  GuardrailLocation,
  InputGuardrail,
  InputGuardrailArgs,
  OutputGuardrail,
  OutputGuardrailArgs,
  OutputGuardrailStreamingOptions,
  ToolGuardrailBehavior,
  ToolGuardrailFunctionOutput,
  ToolInputGuardrail,
  ToolInputGuardrailData,
  ToolOutputGuardrail,
  ToolOutputGuardrailData,
} from "./guardrail.ts";

export { composeLoopHooks } from "./compose-hooks.ts";


/** Agent profile + session runtime → the params one request carries. Exported so embedders
 *  that drive `runTurn` directly resolve precedence the same way the Runner does. */
export { resolveModelParams } from "./run-support.ts";

export { CapabilityMissingError, Session, newSessionId } from "./session.ts";
export type {
  BackgroundTaskListOptions,
  ReadBackgroundTaskOutputDeltaOptions,
  ReadBackgroundTaskOutputOptions,
  ConversationHead,
  CreateGoalInput,
  GoalBudgetInput,
  GoalStatusInput,
  PlanModeOptions,
  SessionConfig,
  SessionPort,
} from "./session.ts";

export { newAgentId } from "./subagent.ts";
export type { SubagentRecord, SubagentStatus, AgentSpawnDetails } from "./subagent.ts";
export {
  RawAgentProfileSchema,
  resolveAgentProfiles,
  resolveProfileDirs,
  loadAgentProfiles,
  loadAgentProfilesFromSources,
  prepareSystemPromptContext,
  buildAgentFromProfile,
  profileSubagentProvider,
} from "./profiles.ts";
export type {
  RawAgentProfile,
  RawSubagentProfile,
  ResolvedAgentProfile,
  SystemPromptContext,
  SystemPromptRenderer,
  ProfileLoadOptions,
  BuildAgentOptions,
  SubagentInfo,
  SubagentProvider,
} from "./profiles.ts";
export { DEFAULT_AGENT_PROFILES, DEFAULT_AGENT_PROFILE_NAME, DEFAULT_SUBAGENT_NAMES } from "./profile-builtins.ts";

export { createWorktree } from "./worktree.ts";
export type { WorktreeHandle } from "./worktree.ts";

// Per-turn context-window breakdown (system/tools/messages/injections/free) for observability.
export { computeContextBreakdown } from "./context-report.ts";
export type {
  ContextBreakdown,
  ContextSlice,
  ContextInjectionSlice,
  ComputeContextBreakdownInput,
} from "./context-report.ts";

export { Runner } from "./runner.ts";
export type {
  AgentInput,
  ResumeInput,
  RunInterruption,
  RunnerConfig,
  RunOptions,
  RunResult,
  RunStatus,
} from "./runner.ts";

// Workflow engine (the deterministic subagent-orchestration runtime) + its manager
// and snapshot/journal layers, exposed so upper layers can integrate programmatically.
export * from "./workflow/index.ts";
