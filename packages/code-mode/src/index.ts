/**
 * Code Mode for operon-agents: the model writes a TypeScript program that calls its tools, and
 * one `RunCode` call does what would otherwise take a round-trip per tool call.
 *
 * ```ts
 * import { createHarness } from "operon-agents";
 * import { codeMode } from "operon-code-mode";
 *
 * const harness = createHarness({ model, extensions: [codeMode()] });
 * ```
 *
 * The program runs in QuickJS compiled to WebAssembly: it can reach nothing but `tools.*`, and
 * every `tools.X(args)` is a nested tool call the engine runs through its own pipeline —
 * permissions, hooks and the Environment apply exactly as for a direct call. See the README.
 */
export { codeMode, CODE_MODE_EXTENSION_ID, DEFAULT_DIRECT_TOOLS } from "./extension.ts";
export type { CodeModeMode, CodeModeOptions } from "./extension.ts";
export { createRunCodeTool, DEFAULT_RUN_CODE_LIMITS } from "./run-code-tool.ts";
export type { RunCodeApprovalRequest, RunCodeDetails, RunCodeDispatch, RunCodeJournalStore, RunCodeLimits, RunCodeSuspendState, RunCodeToolOptions } from "./run-code-tool.ts";
export { createQuickJSRuntime } from "./runtime-quickjs.ts";
export type { QuickJSRuntimeOptions } from "./runtime-quickjs.ts";
export { ToolCallFailure } from "./runtime.ts";
export type { CodeBinding, CodeRunFailure, CodeRunFailureKind, CodeRunLimits, CodeRunRequest, CodeRunResult, CodeRuntime } from "./runtime.ts";
export { renderToolDeclarations, briefOf } from "./declarations.ts";
export type { DeclarationOptions } from "./declarations.ts";
export { RUN_CODE_NAME, runCodeDescription } from "./prompt.ts";
export type { RunCodePromptInput } from "./prompt.ts";
