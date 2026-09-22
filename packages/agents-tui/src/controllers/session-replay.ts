import type { AgentRecord, BackgroundTaskInfo, HarnessSession, Message, PermissionMode } from 'operon-agents';

import { ToolCallComponent } from '../components/messages/tool-call.ts';
import type { TodoItem } from '../components/chrome/todo-panel.ts';
import { MAIN_AGENT_ID } from '../constant/tui.ts';
import type { AppState, BackgroundAgentMetadata, ToolResultBlockData, TranscriptEntry } from '../types.ts';
import { formatErrorMessage, isTodoItemShape } from '../utils/event-payload.ts';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status.ts';
import { formatBackgroundTaskTranscript, isTerminalBackgroundTask } from '../utils/background-task-status.ts';
import { PERMISSION_MODE_DISPLAY_NAMES, isPermissionMode } from '../utils/permission-mode.ts';
import {
  appStateFromRecords,
  assistantToolCalls,
  collectReplayMessageContent,
  countActiveBackgroundTasks,
  createReplayRenderContext,
  limitReplayRecordsByTurn,
  REPLAY_TURN_LIMIT,
  replayBackgroundProjection,
  replayEntry,
  toolCallFromReplayMessage,
  toolResultOutput,
  userMessageContentText,
  type ReplayRenderContext,
} from '../utils/message-replay.ts';
import type { StreamingUIController } from './streaming-ui.ts';
import type { SessionEventHandler } from './session-event-handler.ts';
import type { TUIState } from '../tui-state.ts';

type AppendRecord = Extract<AgentRecord, { type: 'context.append_message' }>;
type CompactionRecord = Extract<AgentRecord, { type: 'context.apply_compaction' }>;
type ApprovalRecord = Extract<AgentRecord, { type: 'permission.record_approval' }>;

export interface SessionReplayHost {
  state: TUIState;
  readonly streamingUI: StreamingUIController;
  readonly sessionEventHandler: SessionEventHandler;
  setAppState(patch: Partial<AppState>): void;
  showError(msg: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  mergeAllTurnSteps(): void;
}

/**
 * Rebuilds the transcript of a resumed session from its journal — the same append-only record
 * stream the live session writes — through the same live render hooks the event handler uses,
 * so a replayed turn looks exactly like it did while it streamed.
 */
export class SessionReplayRenderer {
  constructor(private readonly host: SessionReplayHost) {}

  async hydrateFromReplay(session: HarnessSession): Promise<boolean> {
    this.host.setAppState({ isReplaying: true });
    try {
      const records = await session.getRecords(MAIN_AGENT_ID);
      const background = await this.loadBackgroundTasks(session);
      this.hydrateSnapshot(session, records, background);
      this.renderRecords(records);
      this.applyTerminalBackgroundAgentStatuses(background);
      this.host.mergeAllTurnSteps();
      return true;
    } catch (error) {
      this.host.showError(`Failed to replay session history: ${formatErrorMessage(error)}`);
      return false;
    } finally {
      this.host.setAppState({ isReplaying: false });
    }
  }

  private async loadBackgroundTasks(session: HarnessSession): Promise<readonly BackgroundTaskInfo[]> {
    try {
      return session.background?.list(false) ?? [];
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot hydration
  // ---------------------------------------------------------------------------

  private hydrateSnapshot(session: HarnessSession, records: readonly AgentRecord[], background: readonly BackgroundTaskInfo[]): void {
    this.host.setAppState(appStateFromRecords(records));
    this.hydrateTodoPanel(session);
    this.hydrateBackgroundState(background);
  }

  private hydrateTodoPanel(session: HarnessSession): void {
    const todos = session
      .getTodos()
      .filter((todo): todo is TodoItem => isTodoItemShape(todo))
      .map((todo) => ({ title: todo.title, status: todo.status }));
    if (todos.length > 0 && todos.every((todo) => todo.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
      return;
    }
    this.host.streamingUI.setTodoList(todos);
  }

  /**
   * Push the real terminal status into each replayed `Agent` card whose backing background
   * task already ended; runs after `renderRecords` because the cards only exist then.
   */
  private applyTerminalBackgroundAgentStatuses(background: readonly BackgroundTaskInfo[]): void {
    for (const info of background) {
      if (info.kind !== 'agent' || !isTerminalBackgroundTask(info)) continue;
      const status = info.status === 'paused' ? 'failed' : info.status;
      if (status !== 'completed' && status !== 'failed' && status !== 'timed_out' && status !== 'killed' && status !== 'lost') continue;
      this.host.streamingUI.applyBackgroundTaskTerminalStatus({ agentId: info.agentId, description: info.description, status });
    }
  }

  private hydrateBackgroundState(background: readonly BackgroundTaskInfo[]): void {
    const { state, sessionEventHandler } = this.host;
    const projection = replayBackgroundProjection(background);
    sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata = new Map(projection.backgroundAgentMetadata);
    sessionEventHandler.backgroundTasks.clear();
    for (const info of background) sessionEventHandler.backgroundTasks.set(info.taskId, info);
    sessionEventHandler.backgroundTaskTranscriptedTerminal.clear();
    for (const info of background) {
      if (isTerminalBackgroundTask(info)) sessionEventHandler.backgroundTaskTranscriptedTerminal.add(info.taskId);
    }
    state.footer.setBackgroundCounts(countActiveBackgroundTasks(sessionEventHandler.backgroundTasks));
    state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Record rendering
  // ---------------------------------------------------------------------------

  private renderRecords(records: readonly AgentRecord[]): void {
    const context = createReplayRenderContext();
    for (const record of limitReplayRecordsByTurn(records, REPLAY_TURN_LIMIT)) {
      this.renderRecord(context, record);
    }
    this.flushAssistant(context);
    this.cleanupRuntime(context);
  }

  private renderRecord(context: ReplayRenderContext, record: AgentRecord): void {
    switch (record.type) {
      case 'context.append_message':
        this.renderMessage(context, record);
        return;
      case 'context.replace':
        // History was reset (micro-compaction): what follows is what the model sees now.
        this.flushAssistant(context);
        return;
      case 'context.apply_compaction':
        this.renderCompaction(context, record);
        return;
      case 'permission.set_mode':
        this.flushAssistant(context);
        this.renderPermissionUpdate(context, record.mode);
        return;
      case 'permission.record_approval':
        this.flushAssistant(context);
        this.renderApprovalResult(context, record);
        return;
      case 'custom_message':
        if (record.display) {
          this.flushAssistant(context);
          const text = typeof record.content === 'string' ? record.content : record.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('');
          this.host.appendTranscriptEntry(replayEntry(context, 'status', text, 'plain'));
        }
        return;
      case 'guardrail.blocked':
        this.flushAssistant(context);
        this.host.appendTranscriptEntry(
          replayEntry(context, 'status', `Blocked by ${record.guardrail} (${record.stage}): ${record.message}`, 'notice'),
        );
        return;
      case 'event.lifecycle':
        if (record.event.type === 'turn.ended' && record.event.reason === 'failed' && record.event.error !== undefined) {
          this.flushAssistant(context);
          this.host.appendTranscriptEntry(replayEntry(context, 'status', `Turn failed: ${record.event.error}`, 'notice'));
        }
        return;
      case 'agent.handoff':
        this.flushAssistant(context);
        this.host.appendTranscriptEntry(replayEntry(context, 'status', `Handoff: ${record.from} → ${record.to}`, 'notice'));
        return;
      case 'metadata':
      case 'usage.record':
      case 'config.update':
      case 'agent.handoff.accepted':
      case 'custom':
        return;
    }
  }

  private renderMessage(context: ReplayRenderContext, record: AppendRecord): void {
    const { message, origin } = record;
    switch (message.role) {
      case 'user':
        this.renderUserMessage(context, message, origin);
        return;
      case 'assistant':
        collectReplayMessageContent(context.assistant, message.content);
        this.flushAssistant(context);
        this.renderToolCalls(context, message);
        return;
      case 'toolResult':
        this.flushAssistant(context);
        this.renderToolResult(context, message);
        return;
    }
  }

  private renderUserMessage(context: ReplayRenderContext, message: Extract<Message, { role: 'user' }>, origin: AppendRecord['origin']): void {
    const kind = origin?.kind;
    if (kind === 'injection' || kind === 'compaction_summary' || kind === 'tool_catalog_delta' || kind === 'handoff_seed') return;
    if (origin?.kind === 'background_task') {
      this.flushAssistant(context);
      this.renderBackgroundTaskNotification(context, origin.taskId, origin.status, origin.agentId);
      return;
    }
    if (origin?.kind === 'cron_job') {
      this.flushAssistant(context);
      this.advanceTurn(context);
      this.host.appendTranscriptEntry({
        ...replayEntry(context, 'cron', userMessageContentText(message), 'plain'),
        cronData: {
          jobId: origin.jobId,
          cron: origin.cron,
          recurring: origin.recurring,
          coalescedCount: origin.coalescedCount,
          stale: origin.stale,
        },
      });
      return;
    }
    if (origin?.kind === 'cron_missed') {
      this.flushAssistant(context);
      this.advanceTurn(context);
      this.host.appendTranscriptEntry({
        ...replayEntry(context, 'cron', userMessageContentText(message), 'plain'),
        cronData: { missedCount: origin.count },
      });
      return;
    }
    this.flushAssistant(context);
    const text = userMessageContentText(message);
    // A skill activation is journaled as a system-reminder-wrapped prompt: show it as a card.
    const skill = /<skill-loaded name="([^"]+)"(?: args="([^"]*)")?>/.exec(text);
    if (skill !== null) {
      this.host.appendTranscriptEntry({
        ...replayEntry(context, 'skill_activation', `Activated skill: ${skill[1]!}`, 'plain'),
        skillName: skill[1]!,
        skillArgs: skill[2] === undefined || skill[2].length === 0 ? undefined : unescapeXmlAttr(skill[2]),
        skillTrigger: 'user-slash',
      });
      this.advanceTurn(context);
      return;
    }
    this.advanceTurn(context);
    const bullet =
      origin?.kind === 'external'
        ? `${origin.actor ?? origin.source} ›`
        : origin?.kind === 'extension'
          ? `${origin.extensionId} ›`
          : undefined;
    this.host.appendTranscriptEntry(replayEntry(context, 'user', text, 'plain', { bullet }));
  }

  private renderToolCalls(context: ReplayRenderContext, message: Extract<Message, { role: 'assistant' }>): void {
    const toolCalls = assistantToolCalls(message);
    if (toolCalls.length === 0) return;
    const { streamingUI } = this.host;
    context.stepIndex += 1;
    this.applyStepContext(context);
    for (const rawToolCall of toolCalls) {
      const toolCall = toolCallFromReplayMessage(rawToolCall, context);
      if (toolCall === undefined) continue;
      context.toolCalls.set(toolCall.id, toolCall);
      streamingUI.setActiveToolCall(toolCall.id, toolCall);
      streamingUI.onToolCallStart(toolCall);
    }
  }

  private renderToolResult(context: ReplayRenderContext, message: Extract<Message, { role: 'toolResult' }>): void {
    const toolCallId = message.toolCallId;
    const call = context.toolCalls.get(toolCallId);
    if (call === undefined) return;
    const result: ToolResultBlockData = {
      tool_call_id: toolCallId,
      output: toolResultOutput(message.content),
      is_error: message.isError,
      details: message.details,
    };
    call.result = result;
    this.applyStepContext(context);
    this.host.streamingUI.onToolCallEnd(toolCallId, result);
    this.host.streamingUI.removeActiveToolCall(toolCallId);
    context.completedToolCallIds.add(toolCallId);
  }

  private advanceTurn(context: ReplayRenderContext): void {
    context.turnIndex += 1;
    context.stepIndex = 0;
    context.currentTurnId = `replay:${String(context.turnIndex)}`;
    this.applyStepContext(context);
  }

  private applyStepContext(context: ReplayRenderContext): void {
    this.host.streamingUI.setTurnId(context.currentTurnId);
    this.host.streamingUI.setStep(context.stepIndex);
  }

  private flushAssistant(context: ReplayRenderContext): void {
    const { streamingUI } = this.host;
    const thinking = context.assistant.thinking.join('');
    const text = context.assistant.text.join('');
    context.assistant = { thinking: [], text: [] };
    this.applyStepContext(context);
    if (thinking.length > 0) {
      streamingUI.onThinkingUpdate(thinking);
      streamingUI.onThinkingEnd();
    }
    if (text.length > 0) {
      streamingUI.onStreamingTextStart();
      streamingUI.onStreamingTextUpdate(text);
      streamingUI.onStreamingTextEnd();
      streamingUI.clearAssistantDraft();
    }
  }

  private cleanupRuntime(context: ReplayRenderContext): void {
    this.flushAssistant(context);
    this.host.streamingUI.cleanupAfterReplay(context.completedToolCallIds);
  }

  // ---------------------------------------------------------------------------
  // Special content renderers
  // ---------------------------------------------------------------------------

  private renderCompaction(context: ReplayRenderContext, record: CompactionRecord): void {
    this.flushAssistant(context);
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'status', 'Compaction complete', 'plain'),
      compactionData: {
        summary: record.summary,
        tokensBefore: record.tokensBefore,
        tokensAfter: record.tokensAfter,
      },
    });
  }

  private renderPermissionUpdate(context: ReplayRenderContext, mode: string): void {
    const label = isPermissionMode(mode) ? PERMISSION_MODE_DISPLAY_NAMES[mode as PermissionMode] : mode;
    this.host.appendTranscriptEntry(replayEntry(context, 'status', `Permission mode: ${label}`, 'notice'));
  }

  private renderApprovalResult(context: ReplayRenderContext, record: ApprovalRecord): void {
    if (record.toolName === 'ExitPlanMode') {
      this.renderPlanReviewResult(context, record);
      return;
    }
    const parts: string[] = [];
    switch (record.decision) {
      case 'approved':
        parts.push(record.scope === 'session' ? 'Approved for session' : 'Approved');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
      default:
        parts.push(record.decision);
    }
    parts.push(`: ${record.approvalRule ?? record.toolName}`);
    if (record.feedback !== undefined && record.feedback.length > 0) parts.push(` — "${record.feedback}"`);
    this.host.appendTranscriptEntry(replayEntry(context, 'status', parts.join(''), 'notice'));
  }

  private renderPlanReviewResult(context: ReplayRenderContext, record: ApprovalRecord): void {
    if (record.decision === 'approved') return;
    this.removeToolCall(record.toolCallId);
    const content =
      record.decision === 'rejected'
        ? record.feedback === 'Revise'
          ? 'Plan sent back for revision'
          : 'Plan review rejected'
        : 'Plan review cancelled';
    const detail = record.feedback !== undefined && record.feedback.length > 0 && record.feedback !== 'Revise' ? `Feedback: ${record.feedback}` : undefined;
    this.host.appendTranscriptEntry(replayEntry(context, 'status', content, 'notice', { detail }));
  }

  private removeToolCall(toolCallId: string): void {
    const { state, streamingUI } = this.host;
    streamingUI.removeActiveToolCall(toolCallId);
    streamingUI.removeToolComponent(toolCallId);
    const index = state.transcriptEntries.findIndex((entry) => entry.toolCallData?.id === toolCallId);
    if (index >= 0) state.transcriptEntries.splice(index, 1);
    const children = state.transcriptContainer.children;
    const childIndex = children.findIndex((child) => child instanceof ToolCallComponent && child.toolCallView.id === toolCallId);
    if (childIndex >= 0) children.splice(childIndex, 1);
  }

  private renderBackgroundTaskNotification(context: ReplayRenderContext, taskId: string, status: string | undefined, agentId: string | undefined): void {
    const { sessionEventHandler } = this.host;
    const task = sessionEventHandler.backgroundTasks.get(taskId);
    if (task !== undefined && task.kind !== 'agent') {
      const info = status !== undefined ? ({ ...task, status } as BackgroundTaskInfo) : task;
      const card = formatBackgroundTaskTranscript(info);
      this.host.appendTranscriptEntry({
        ...replayEntry(context, 'status', card.headline, 'plain'),
        detail: card.detail,
        backgroundAgentStatus: card,
      });
      sessionEventHandler.backgroundTaskTranscriptedTerminal.add(taskId);
      return;
    }
    const meta: BackgroundAgentMetadata = {
      agentId: agentId ?? (task?.kind === 'agent' ? task.agentId : undefined) ?? taskId,
      parentToolCallId: task?.toolCallId ?? taskId,
      agentName: task?.kind === 'agent' ? task.subagentType : undefined,
      description: task?.description,
    };
    const phase = status === 'completed' ? 'completed' : 'failed';
    let card = formatBackgroundAgentTranscript(phase, meta);
    if (status === 'lost') card = { ...card, headline: card.headline.replace(' failed in background', ' lost in background') };
    else if (status === 'killed') card = { ...card, headline: card.headline.replace(' failed in background', ' stopped') };
    else if (status === 'timed_out') card = { ...card, headline: card.headline.replace(' failed in background', ' timed out') };
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'status', card.headline, 'plain'),
      detail: card.detail,
      backgroundAgentStatus: card,
    });
    sessionEventHandler.subAgentEventHandler.backgroundAgentMetadata.delete(meta.agentId);
    sessionEventHandler.backgroundTaskTranscriptedTerminal.add(taskId);
  }
}

function unescapeXmlAttr(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
