import type {
  ApprovalResponse,
  GoalSnapshot,
  PermissionMode,
  ThinkingLevel,
  ToolDisplay,
  Usage,
} from 'operon-agents';

import type { NotificationsConfig, StatusLineConfig } from './config.ts';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types.ts';
import type { ColorToken, ThemeName } from './theme/index.ts';
import type { ModelCatalog } from './utils/model-catalog.ts';

export interface AppState {
  /** The active model id, `provider/model`. */
  model: string;
  workDir: string;
  additionalDirs: readonly string[];
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  /** 'bash' when the editor is in `!` shell-command mode. */
  inputMode: 'prompt' | 'bash';
  /** Live thinking level of the active session; the single source of truth in the TUI. */
  thinkingLevel: ThinkingLevel;
  /** Fraction of the context window in use (0..1), from the last turn boundary. */
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  /** Run-total tokens (input + output + cache) accrued so far, from `usage.updated`. */
  cumulativeTokens?: number;
  isCompacting: boolean;
  isReplaying: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  streamingStartTime: number;
  /** Pending step retry backoff (fed by `turn.step.retrying`); null when no retry is in flight. */
  stepRetry: StepRetryState | null;
  theme: ThemeName;
  version: string;
  editorCommand: string | null;
  disablePasteBurst?: boolean;
  renderLatex?: boolean;
  notifications: NotificationsConfig;
  /** Footer status line customization from tui.toml; absent means the default layout. */
  statusLine?: StatusLineConfig;
  /** Models the `/model` picker offers, keyed by `provider/model`. */
  availableModels: ModelCatalog;
  sessionTitle: string | null;
  /** Current goal snapshot for the footer badge; null/undefined when no active goal. */
  goal?: GoalSnapshot | null;
  mcpServersSummary: string | null;
}

/** Run-total token count, the figure the footer and `/usage` report. */
export function sumTokenUsage(total: Usage): number {
  return total.totalTokens > 0 ? total.totalTokens : total.input + total.output + total.cacheRead + total.cacheWrite;
}

export interface StepRetryState {
  /** Upcoming attempt number (1-based). */
  nextAttempt: number;
  maxAttempts: number;
  /** Backoff wait before the next attempt, in milliseconds. */
  delayMs: number;
  errorName: string;
  errorMessage: string;
  statusCode?: number;
  /**
   * `backoff` while sleeping before the next attempt (label shows the countdown); `attempt`
   * once the `delayMs` backoff has elapsed and the next attempt is running.
   */
  phase: 'backoff' | 'attempt';
}

/**
 * A lifecycle transition of the goal loop, derived by the event handler from consecutive
 * `goal.updated` snapshots (the engine broadcasts state, not deltas).
 */
export interface GoalChange {
  readonly kind: 'lifecycle' | 'completion';
  readonly status?: GoalSnapshot['status'] | 'complete';
  readonly reason?: string;
  readonly actor?: 'user' | 'model' | 'runtime' | 'system';
}

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  /** The tool's own display hints (`ToolDisplay`): title, detail, and tool-specific fields. */
  display?: ToolDisplay;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
  result?: ToolResultBlockData;
  subagent?: SubagentReplayBlockData;
  step?: number;
  turnId?: string;
  /** Set when the step ended (e.g. max_tokens) before the tool call's arguments finished
   *  streaming. Renderer flips the header verb to "Truncated". */
  truncated?: boolean;
  /** The call entered its detachable window (`tool.detachable`): Ctrl+B may move it to the background. */
  detachable?: boolean;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  /** The result's structured `details` (todo lists, goal records, plan state…). */
  details?: unknown;
  synthetic?: boolean;
}

export interface SubagentReplayToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
}

export interface SubagentReplayBlockData {
  id: string;
  name?: string;
  text?: string;
  toolCalls?: readonly SubagentReplayToolCallData[];
}

export interface BackgroundAgentMetadata {
  readonly agentId: string;
  readonly parentToolCallId: string;
  readonly agentName?: string;
  readonly description?: string;
  /** Display name of the model the agent is bound to (resolved at spawn). */
  readonly model?: string;
  readonly effort?: string;
}

export type BackgroundAgentStatusPhase = 'started' | 'completed' | 'failed';

export interface BackgroundAgentStatusData {
  readonly phase: BackgroundAgentStatusPhase;
  readonly headline: string;
  readonly detail?: string;
}

export interface CompactionTranscriptData {
  readonly result?: 'cancelled';
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly instruction?: string;
}

export interface CronTranscriptData {
  readonly jobId?: string;
  readonly cron?: string;
  readonly recurring?: boolean;
  readonly coalescedCount?: number;
  readonly stale?: boolean;
  readonly missedCount?: number;
}

export type GoalTranscriptData =
  | { readonly kind: 'created' }
  | { readonly kind: 'lifecycle'; readonly change: GoalChange };

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'status'
  | 'skill_activation'
  | 'cron'
  | 'goal';

export type SkillActivationTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: 'markdown' | 'plain' | 'notice';
  content: string;
  /** True only for entries holding real model-authored text (created by the assistant stream). */
  modelText?: boolean;
  color?: ColorToken;
  detail?: string;
  /** Optional override for the leading bullet of a 'user' message entry. An empty string
   *  suppresses the bullet entirely (shell-command echoes use `$` instead). */
  bullet?: string;
  toolCallData?: ToolCallBlockData;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  compactionData?: CompactionTranscriptData;
  cronData?: CronTranscriptData;
  goalData?: GoalTranscriptData;
  imageAttachmentIds?: readonly number[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
  skillTrigger?: SkillActivationTrigger;
  /** Card belongs to the following prompt's bundled submission. */
  bundledWithPrompt?: boolean;
}

export type LivePaneMode = 'idle' | 'waiting' | 'thinking' | 'tool' | 'session';

export interface LivePaneState {
  mode: LivePaneMode;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
}

export interface InlineSkillActivation {
  readonly skillName: string;
  /** Skill arguments. Only set for a leading `/skill:<name> args` command. */
  readonly args?: string;
}

/** A user message's image attachments, sent as `image` content parts alongside the text. */
export interface PromptImagePart {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export type PromptPart = { readonly type: 'text'; readonly text: string } | PromptImagePart;

export interface QueuedMessage {
  readonly text: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  /** `bash` for a `!` shell command queued while another command is running; `skill` for a
   *  slash-skill activation queued while the session is busy; undefined for a normal message. */
  readonly mode?: 'prompt' | 'bash' | 'skill';
  readonly skillName?: string;
  readonly skillArgs?: string;
  /** Skills to activate together with this queued message's prompt. */
  readonly inlineSkillActivations?: readonly InlineSkillActivation[];
}

/** One unit of Ctrl-S steer input: a queued message or the editor draft. */
export interface SteerInputItem {
  readonly text: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  pendingApproval: null,
  pendingQuestion: null,
};

// ---------------------------------------------------------------------------
// TUI startup / options types
// ---------------------------------------------------------------------------

export interface TUIStartupOptions {
  /** `--session <id>`; an empty string opens the picker. */
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly permission?: PermissionMode;
  readonly plan: boolean;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface OperonTuiOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
  setLabel(label: string): void;
}

/** What the transcript records about an answered approval. */
export interface ApprovalTranscriptRecord {
  readonly toolName: string;
  readonly action: string;
  readonly response: ApprovalResponse;
}
