import type { AgentRecord, BackgroundTaskInfo, Message, PromptOrigin, ToolCall } from 'operon-agents';

import type { AppState, BackgroundAgentMetadata, ToolCallBlockData, TranscriptEntry } from '../types.ts';
import { isTerminalBackgroundTask } from './background-task-status.ts';
import { toolResultText, userMessageText } from './event-payload.ts';
import { nextTranscriptId } from './transcript-id.ts';

/** How many of the most recent turns a resume renders; older history stays in the log. */
export const REPLAY_TURN_LIMIT = 10;

export interface ReplayRenderContext {
  turnIndex: number;
  stepIndex: number;
  currentTurnId: string | undefined;
  assistant: {
    thinking: string[];
    text: string[];
  };
  toolCalls: Map<string, ToolCallBlockData>;
  completedToolCallIds: Set<string>;
  skillActivationIds: Set<string>;
}

export interface ReplayBackgroundProjection {
  readonly backgroundAgentMetadata: ReadonlyMap<string, BackgroundAgentMetadata>;
}

export function createReplayRenderContext(): ReplayRenderContext {
  return {
    turnIndex: 0,
    stepIndex: 0,
    currentTurnId: undefined,
    assistant: { thinking: [], text: [] },
    toolCalls: new Map(),
    completedToolCallIds: new Set(),
    skillActivationIds: new Set(),
  };
}

export function countActiveBackgroundTasks(tasks: ReadonlyMap<string, BackgroundTaskInfo>): {
  bashTasks: number;
  agentTasks: number;
} {
  let bashTasks = 0;
  let agentTasks = 0;
  for (const info of tasks.values()) {
    if (isTerminalBackgroundTask(info)) continue;
    if (info.kind === 'agent') agentTasks += 1;
    else bashTasks += 1;
  }
  return { bashTasks, agentTasks };
}

export function replayBackgroundProjection(background: readonly BackgroundTaskInfo[]): ReplayBackgroundProjection {
  const backgroundAgentMetadata = new Map<string, BackgroundAgentMetadata>();
  for (const info of background) {
    if (info.kind !== 'agent') continue;
    if (isTerminalBackgroundTask(info)) continue;
    const agentId = info.agentId ?? info.taskId;
    backgroundAgentMetadata.set(agentId, {
      agentId,
      parentToolCallId: info.toolCallId ?? info.taskId,
      agentName: info.subagentType,
      description: info.description,
    });
  }
  return { backgroundAgentMetadata };
}

/** A user-authored message starts a turn; injections, summaries and task notices do not. */
export function isTurnStartingOrigin(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined) return true;
  switch (origin.kind) {
    case 'user':
    case 'user_follow_up':
    case 'external':
    case 'cron_job':
    case 'cron_missed':
      return true;
    case 'extension':
      return true;
    default:
      return false;
  }
}

export function isTurnBoundaryRecord(record: AgentRecord): boolean {
  return record.type === 'context.append_message' && record.message.role === 'user' && isTurnStartingOrigin(record.origin);
}

/** Keep the records of the last `maxTurns` turns (a turn starts at a user-authored message). */
export function limitReplayRecordsByTurn(records: readonly AgentRecord[], maxTurns: number): readonly AgentRecord[] {
  if (maxTurns <= 0) return records;
  let boundaries = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (!isTurnBoundaryRecord(records[i]!)) continue;
    boundaries += 1;
    if (boundaries === maxTurns) return records.slice(i);
  }
  return records;
}

export function replayEntry(
  context: ReplayRenderContext,
  kind: TranscriptEntry['kind'],
  content: string,
  renderMode: TranscriptEntry['renderMode'],
  extras: { detail?: string; bullet?: string } = {},
): TranscriptEntry {
  return {
    id: nextTranscriptId(),
    kind,
    turnId: context.currentTurnId,
    renderMode,
    content,
    detail: extras.detail,
    bullet: extras.bullet,
  };
}

export function collectReplayMessageContent(
  target: ReplayRenderContext['assistant'],
  content: Extract<Message, { role: 'assistant' }>['content'],
): void {
  for (const part of content) {
    switch (part.type) {
      case 'thinking':
        if (part.redacted !== true) target.thinking.push(part.thinking);
        break;
      case 'text':
        target.text.push(part.text);
        break;
      case 'toolCall':
        break;
    }
  }
}

export function assistantToolCalls(message: Extract<Message, { role: 'assistant' }>): ToolCall[] {
  return message.content.filter((part): part is ToolCall => part.type === 'toolCall');
}

export function toolCallFromReplayMessage(rawToolCall: ToolCall, context: ReplayRenderContext): ToolCallBlockData | undefined {
  const id = rawToolCall.id;
  const name = rawToolCall.name;
  if (id.length === 0 || name.length === 0) return undefined;
  const args = rawToolCall.arguments ?? {};
  const description = typeof args['description'] === 'string' ? (args['description'] as string) : undefined;
  return {
    id,
    name,
    args,
    ...(description !== undefined ? { description } : {}),
    step: context.stepIndex,
    turnId: context.currentTurnId,
  };
}

export function toolResultOutput(content: Extract<Message, { role: 'toolResult' }>['content']): string {
  return toolResultText(content);
}

export function userMessageContentText(message: Extract<Message, { role: 'user' }>): string {
  return userMessageText(message);
}

/** The footer figures a resume seeds from the log: cumulative usage from the last `usage.record`. */
export function appStateFromRecords(records: readonly AgentRecord[]): Partial<AppState> {
  let cumulativeTokens: number | undefined;
  for (const record of records) {
    if (record.type !== 'usage.record') continue;
    const total = record.total ?? record.usage;
    cumulativeTokens = total.totalTokens > 0 ? total.totalTokens : total.input + total.output + total.cacheRead + total.cacheWrite;
  }
  return cumulativeTokens === undefined ? {} : { cumulativeTokens };
}
