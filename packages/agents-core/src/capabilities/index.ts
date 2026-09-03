export type {
  AssembledGates,
  Capability,
  CapabilityDiagnostic,
  CapabilityGates,
  CompactionGate,
  CompactionGateContext,
  CompactionGateResult,
  Provision,
  ProvisionContext,
  RunContext,
  SessionControls,
  ToolFilter,
} from "./capability.ts";
export type { Injector, InjectionContext, InjectionResult, InjectionAppender } from "./injection.ts";
export { BoundaryInjector, InjectionManager, systemReminder } from "./injection.ts";
export { readLog, readSessionLog } from "./capability-state.ts";
export type { ToolProvider } from "./tool-provider.ts";
export { staticToolProvider, tagToolSource, toolSource } from "./tool-provider.ts";
// Extensions are a HARNESS concept and live in `operon-agents` — core deliberately knows
// nothing about them. What an extension runtime is built out of is all here: `Capability`,
// `LoopHooks`, `ToolFilter`, `Injector`, `SessionControls`, `tagToolSource`.
//
// The capability assembler (assembleCapabilities / AssembledCapabilities) is Runner-internal
// wiring — on `operon-agents-core/internal`, not the public surface.

export { planCapability, PlanMode } from "./plan/index.ts";
export type { PlanData } from "./plan/index.ts";

export { goalCapability, GoalStore } from "./goal/index.ts";
export type { GoalSnapshot, GoalStatus, GoalBudget } from "./goal/index.ts";

export { workflowCapability, WorkflowManager } from "./workflow/index.ts";
export type { WorkflowSnapshot, WorkflowSnapshotStatus } from "./workflow/index.ts";

export { todoCapability, TodoStore, TodoListInjector, todoListTool, renderTodoList, TODO_LIST_TOOL_NAME } from "./todo/index.ts";
export type { TodoItem, TodoStatus, TodoDetails } from "./todo/index.ts";

export {
  taskCapability,
  TaskStore,
  TaskListInjector,
  StoreTaskListPersistence,
  DiskTaskListPersistence,
  makeTaskListPersistence,
  isValidTask,
  renderTaskList,
  TASK_STATUSES,
  TASK_CREATE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_GET_TOOL_NAME,
} from "./task/index.ts";
export type { Task, TaskCreateInput, TaskScalarUpdate, TaskListPersistence } from "./task/index.ts";
// The raw task tool constructors (taskCreateTool/taskUpdateTool/taskListTool/taskGetTool) are
// intentionally not re-exported here: `taskListTool` would collide with the background
// capability's export of the same name. Use `taskCapability()` to get the wired tools.

export { compactionCapability, CompactionService, CompactionStrategy, DEFAULT_COMPACTION_CONFIG, MicroCompaction, estimateTokens, estimateTokensForMessages } from "./compaction/index.ts";
export type { CompactRequestOptions, CompactionOptions, CompactionConfig, PendingCompaction } from "./compaction/index.ts";

export { userHooksCapability, HookEngine, HOOK_EVENT_TYPES } from "./user-hooks/index.ts";
export type { HookDef, HookEventType } from "./user-hooks/index.ts";

export {
  backgroundCapability,
  BackgroundManager,
  CommandBackgroundTask,
  AgentBackgroundTask,
  WorkflowBackgroundTask,
  QuestionBackgroundTask,
  backgroundListTool,
  backgroundOutputTool,
  backgroundStopTool,
  TERMINAL_STATUSES,
  isBackgroundTaskTerminal,
  StoreBackgroundTaskPersistence,
  DiskBackgroundTaskPersistence,
  isPersistedTaskTerminal,
  isValidPersistedTask,
} from "./background/index.ts";
export type {
  BackgroundManagerOptions,
  BackgroundManagerRuntime,
  BackgroundTaskOutputDelta,
  BackgroundTaskOutputSnapshot,
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
  BackgroundTaskSettlement,
  BackgroundTaskSettlementStatus,
  BackgroundTaskStatus,
  CommandBackgroundTaskInfo,
  AgentBackgroundTaskInfo,
  AgentBackgroundTaskOptions,
  WorkflowBackgroundTaskInfo,
  WorkflowBackgroundTaskOptions,
  QuestionBackgroundTaskInfo,
  QuestionBackgroundTaskOptions,
  BackgroundTaskPersistence,
  PersistedTask,
  TaskOutputRef,
  TaskOutputLocation,
} from "./background/index.ts";


export {
  skillsCapability,
  loadSkillRoots,
  SkillRegistry,
  SkillNotFoundError,
  SkillCatalogInjector,
  skillTool,
  flowSkillProvider,
  flowSkillToolName,
  resolveSkillRoots,
  discoverSkills,
  parseSkillText,
  parseSkillFromMachine,
  parseFrontmatter,
  expandSkillParameters,
  skillArgumentNames,
  SkillParseError,
  FrontmatterError,
  UnsupportedSkillTypeError,
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  normalizeSkillName,
  isInlineSkillType,
  isFlowSkillType,
  isUserActivatableSkillType,
  isSupportedSkillType,
  summarizeSkill,
} from "./skills/index.ts";
export type {
  SkillsOptions,
  SkillCatalog,
  SkillDefinition,
  SkillMetadata,
  SkillSource,
  SkillSummary,
  SkillRoot,
  SkillPluginContext,
  SkippedSkill,
  FlowSkillExecutor,
  FlowSkillRequest,
  SkillRegistryOptions,
  ResolveSkillRootsOptions,
  DiscoverSkillsOptions,
} from "./skills/index.ts";
