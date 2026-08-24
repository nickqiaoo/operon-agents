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
}

export type HookInputData = Readonly<Record<string, unknown>>;

export interface HookTriggerArgs {
  readonly matcherValue?: string;
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
