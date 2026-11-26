export const HOOK_EVENT_TYPES = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionResult",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export interface HookDef {
  readonly event: HookEventType;
  readonly matcher?: string;
  readonly command: string;
  readonly timeout?: number;
  /**
   * In a session with several environments: run only for tool calls in these environments.
   * Absent = every environment. The hook's command itself always runs on the session's root
   * environment (that is where hook scripts live); the call's environment is in its input as
   * `environment`.
   */
  readonly environments?: readonly string[];
}

export type HookInputData = Readonly<Record<string, unknown>>;

export interface HookTriggerArgs {
  readonly matcherValue?: string;
  /** The environment of the tool call that triggered this, in a multi-environment session. */
  readonly environment?: string;
  readonly inputData?: HookInputData;
  readonly signal?: AbortSignal;
}

export interface HookRunResult {
  readonly block: boolean;
  readonly reason?: string;
  readonly stdout: string;
  readonly exitCode: number;
}

export type HookBlockResult = { readonly block: true; readonly reason?: string } | undefined;
