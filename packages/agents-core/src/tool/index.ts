export type * from "./types.ts";
export { ToolAccesses } from "./access.ts";
export type {
  Environment,
  EnvironmentFactory,
  EnvironmentOpenContext,
  DecodeErrors,
  OsInfo,
  OsKind,
  ShellName,
} from "./environment.ts";
export type {
  ByteRange,
  RunCommandResult,
  DirEntry,
  OutputChunk,
  RunCommandOptions,
  FileInfo,
  FileKind,
} from "./environment.ts";
// Text on top of the byte I/O above — Environment itself reads and writes bytes only.
export { readTextFile, writeTextFile } from "./support/environment-ops.ts";
export type { WriteTextFileOptions } from "./support/environment-ops.ts";
// ── Writing an Environment backend ────────────────────────────────────────────────
// Everything above is the CALLER's surface: `Environment` and the shapes its methods take and
// return. What follows is the IMPLEMENTER's, and only a backend author needs it.
//
// Extend `BaseEnvironment` and it derives the high-level operations for you. Its process SPI —
// `spawn`, returning a `SpawnedProcess` — is what gets you `run` for free, and is optional:
// a transport with no OS process (a sandbox HTTP API, as in `operon-sandbox`) omits it and
// overrides `run` natively instead. Nothing outside the class hierarchy calls either one.
export { BaseEnvironment } from "./environment-base.ts";
export type { SpawnedProcess } from "./environment-base.ts";
export { materializeWorkspace, describeWorkspace, WorkspaceMaterializeError } from "./workspace-spec.ts";
export type { HostReader, MaterializeOptions, WorkspaceEntry, WorkspaceSpec } from "./workspace-spec.ts";
// `decodeText` (the shared strict-UTF-8 contract) is on `operon-agents-core/internal`.
// Bash permission-rule matching helpers are on `operon-agents-core/internal`.
export { LocalEnvironment, detectOsInfo } from "./environment-local.ts";
export { NullEnvironment } from "./environment-null.ts";
export { nonInteractiveShellEnv, proxyEnv, PROXY_ENV_VARS } from "./shell-env.ts";
export type { NonInteractiveEnvOptions } from "./shell-env.ts";
export { collectGitContext, formatGitContext, sanitizeRemoteUrl, parseProjectName } from "./git-context.ts";
export type { GitContext, GitContextOptions } from "./git-context.ts";
export { SshEnvironment } from "./environment-ssh.ts";
export type { SshEnvironmentOptions, SshEnvironmentExtraOptions } from "./environment-ssh.ts";
export type { BackgroundSpawner, MonitorSpawnOptions, MonitorTiming } from "./background.ts";
export { askUser } from "./ask.ts";
export { defineTool } from "./define.ts";
export { globApproval } from "./support/tool-path.ts";
export type { FunctionToolDef, ResolveToolDef, ToolReturn } from "./define.ts";
export { writeTool } from "./builtin/write.ts";
export { editTool } from "./builtin/edit.ts";
export { readTool } from "./builtin/read.ts";
export { globTool } from "./builtin/glob.ts";
export { bashTool, prepareBackgroundLog } from "./builtin/bash.ts";
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
// The keyword search behind SearchTool, for other surfaces that look tools up by intent
// (Code Mode's `searchTools`).
export { searchDeferredTools } from "./search/deferral.ts";

export type * from './environment.ts';
export { runViaHandle, ProcessTable, commandArgv, commandLine, shellQuote, shellJoin, codedError } from './environment-commands.ts';
export { BaseFiles, toBuffer, sliceRange } from './environment-files.ts';
export { PlainSandbox } from './environment-sandbox.ts';

export type { NodePtyModule } from './environment-pty.ts';

export { EnvironmentFilesAdapter } from './environment-files.ts';

export { wrapForTaskLog } from './environment-output.ts';
