/**
 * `operon-agents` — the public API for building an application on a harness.
 *
 *   import { createHarness } from "operon-agents"
 *
 * This list is deliberate: every symbol here is one an application needs and one we commit to.
 * A symbol has one home. Built-in tools are on `operon-agents/tools`, and model, MCP, protocol
 * and tracing primitives on their own subpaths. Hosts composing a deployment use
 * `operon-agents/advanced`, and engine internals are on `operon-agents/internal`.
 */

// Harness and sessions.
export { createHarness, Harness, HarnessSession, HarnessBusyError, HarnessClosedError, HarnessConfigError, SessionAlreadyLoadedError, SessionAlreadyLoadingError, SessionDependencyMissingError, SessionPolicyViolationError } from "./harness.ts";
export type {
  ApprovalHandler,
  CreateSessionOptions,
  ForkSessionOptions,
  HarnessOptions,
  HarnessPermissionOptions,
  HarnessSessionState,
  HarnessSessionStatus,
  QuestionHandler,
  ResumeSessionOptions,
  SessionBindingKey,
  SessionBindings,
  SessionIdentity,
  SessionOpenInfo,
  SessionOpenedListener,
  SessionOperation,
  SessionOrigin,
  SessionResolution,
  SessionResolveRequest,
} from "./harness.ts";
// Configuration: one session's setup, and the harness configuration a `config.toml` describes.
export { loadHarnessConfig, normalizeHarnessConfig, parseSessionConfig, resolveSessionConfig, mergeConfigs, SessionConfigSchema, SessionPolicySchema } from "operon-agents-core";
export type { HarnessConfig, SessionConfig, SessionPolicy } from "operon-agents-core";
export { createLocalHarness } from "./local.ts";
export type { LocalDeploymentOptions } from "./local.ts";

// Agents and tools.
export { Agent, defineAgent, defineTool, handoff } from "operon-agents-core";
export type {
  AgentConfig,
  AgentGuardrails,
  AgentRunContext,
  FunctionToolDef,
  HandoffOptions,
  OutputSchema,
  ResolveToolDef,
  Tool,
  ToolPlan,
  ToolResolveContext,
  ToolResult,
  ToolReturn,
  ToolRunContext,
} from "operon-agents-core";

// Running a session and reading its outcome.
export type {
  AgentEvent,
  AgentInput,
  ApprovalRequest,
  ApprovalResponse,
  CompletedRunResult,
  FailedRunResult,
  GuardrailBlockedRunResult,
  InterruptAnswer,
  InterruptedRunResult,
  PendingRunInterrupt,
  QuestionRequest,
  QuestionResult,
  RunError,
  RunResult,
  RunStatus,
  SteerReceipt,
  StoppedRunResult,
} from "operon-agents-core";

// Errors a caller can branch on.
export {
  GuardrailTripwireError,
  SessionBusyError,
  SessionClosedError,
  SessionInterruptedError,
  SessionNotInterruptedError,
  SessionRepositoryConflictError,
  SessionRepositoryNotFoundError,
  SteerTargetNotFoundError,
} from "operon-agents-core";

// Permissions.
export type { AutoApprover, PermissionMode, PermissionRule } from "operon-agents-core";

// Models, messages and where tools run.
export { createModelManager, defineModel, LocalEnvironment } from "operon-agents-core";
export type {
  ChatModel,
  Environment,
  EnvironmentFactory,
  ImageContent,
  Message,
  ModelManager,
  ModelSettings,
  TextContent,
  ThinkingLevel,
  Usage,
} from "operon-agents-core";

// Extending a harness.
export type { ExtensionActions, ExtensionAPI, ExtensionDefinition } from "./extensions/index.ts";
export type { McpServerConfig } from "operon-agents-core";
