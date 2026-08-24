export type * from "./types.ts";
export { ToolAccesses } from "./access.ts";
export type {
  Machine,
  MachineFactory,
  MachineOpenContext,
  DecodeErrors,
  Environment,
  OsKind,
  ShellName,
} from "./machine.ts";
export { StaleFileError, FileExistsError } from "./machine.ts";
export type {
  ByteRange,
  RunCommandResult,
  DirEntry,
  OutputChunk,
  RunCommandOptions,
  FileInfo,
  FileKind,
  FileVersion,
  LineEndings,
  WriteTextOptions,
  WriteTextResult,
  WriteTextIfUnchangedOptions,
  WriteFileResult,
} from "./machine.ts";
// ── Writing a Machine backend ────────────────────────────────────────────────
// Everything above is the CALLER's surface: `Machine` and the shapes its methods take and
// return. What follows is the IMPLEMENTER's, and only a backend author needs it.
//
// Extend `BaseMachine` and it derives the high-level operations for you. Its process SPI —
// `spawn`, returning a `SpawnedProcess` — is what gets you `run` for free, and is optional:
// a transport with no OS process (a sandbox HTTP API, as in `operon-sandbox`) omits it and
// overrides `run` natively instead. Nothing outside the class hierarchy calls either one.
export { BaseMachine } from "./machine-base.ts";
export type { SpawnedProcess } from "./machine-base.ts";
export { materializeWorkspace, describeWorkspace, WorkspaceMaterializeError } from "./workspace-spec.ts";
export type { HostReader, MaterializeOptions, WorkspaceEntry, WorkspaceSpec } from "./workspace-spec.ts";
// Low-level file-op helpers (readTextFile / decodeText / …) are on
// `operon-agents-core/internal`.
export {
  FileFreshnessLedger,
  checkFreshness,
  CONTENT_RETENTION_MAX_BYTES,
  FILE_NOT_READ_MESSAGE,
  FILE_MODIFIED_MESSAGE,
  FILE_UNCHANGED_STUB,
} from "./file-freshness.ts";
export type { FileReadRecord, FreshnessVerdict, RecordWriteOptions, CheckFreshnessInput } from "./file-freshness.ts";
// Bash permission-rule matching helpers are on `operon-agents-core/internal`.
export { LocalMachine, detectEnvironment } from "./machine-local.ts";
export { NullMachine } from "./machine-null.ts";
export { nonInteractiveShellEnv, proxyEnv, PROXY_ENV_VARS } from "./shell-env.ts";
export type { NonInteractiveEnvOptions } from "./shell-env.ts";
export { collectGitContext, formatGitContext, sanitizeRemoteUrl, parseProjectName } from "./git-context.ts";
export type { GitContext, GitContextOptions } from "./git-context.ts";
export { SshMachine } from "./machine-ssh.ts";
export type { SshMachineOptions, SshMachineExtraOptions } from "./machine-ssh.ts";
export type { BackgroundSpawner } from "./background.ts";
export { askUser } from "./ask.ts";
export { defineTool, tool } from "./define.ts";
export { globApproval } from "./support/tool-path.ts";
export type { ToolDef, FunctionToolDef, ToolReturn } from "./define.ts";
export { writeTool } from "./builtin/write.ts";
export { editTool } from "./builtin/edit.ts";
export { readTool } from "./builtin/read.ts";
export { globTool } from "./builtin/glob.ts";
export { bashTool } from "./builtin/bash.ts";
export { grepTool } from "./builtin/grep.ts";
export { askUserQuestionTool } from "./builtin/ask-user-question.ts";
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
} from "./questions.ts";
export type { QuestionSpawnOptions } from "./background.ts";
export { filesystemTools } from "./filesystem-tools.ts";
export type { FilesystemToolsOptions } from "./filesystem-tools.ts";
export * from "./web/index.ts";
