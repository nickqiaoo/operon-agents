// Public loop surface. The turn/step engine itself (runTurn, executeStep,
// runToolCallBatch, ToolScheduler, …) is plumbing — it lives on
// `operon-agents-core/internal`, not here.
export type * from "./types.ts";
export { addUsage, emptyUsage, subtractUsage } from "./usage.ts";
export { MaxStepsExceededError, isMaxStepsExceededError, isAbortError } from "./errors.ts";
export { SteerBus, renderSteerText, steerOriginToPromptOrigin } from "./steer.ts";
export type { SteerOrigin, SteerMessage, SteerContent, SteerContentPart, SteerBusOptions, SteerChannel, SteerReceipt, NowFn } from "./steer.ts";
export {
  INTERRUPTION_STATE_KEY,
  INTERRUPTION_STATE_VERSION,
  applyInterruptionAnswers,
  flattenPendingInterrupts,
  getInterruptionState,
  parseInterruptionState,
} from "./interruption.ts";
export type {
  AgentDefinitionReference,
  InterruptAnswer,
  InterruptionAnchor,
  InterruptionExecution,
  InterruptionFrame,
  InterruptionPhase,
  InterruptionState,
  PendingRunInterrupt,
} from "./interruption.ts";
// source of truth lives in the log; `replayContext` rebuilds it on resume.
export { ConversationContext, replayContext, summaryMessage } from "./context.ts";
export type { ConversationContextOptions, CompactionApply } from "./context.ts";
