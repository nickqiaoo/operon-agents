import type { Component, Focusable } from 'operon-pi-tui';
import type {
  AgentEvent,
  BackgroundTaskInfo,
  GoalSnapshot,
  HarnessSession,
  Message,
  PromptOrigin,
  Usage,
} from 'operon-agents';

import { MoonLoader } from '../components/chrome/moon-loader.ts';
import { buildGoalMarker } from '../components/messages/goal-markers.ts';
import { StatusMessageComponent } from '../components/messages/status-message.ts';
import { MAIN_AGENT_ID } from '../constant/tui.ts';
import { buildGoalCompletionMessage } from '../utils/goal-completion.ts';
import {
  argsRecord,
  formatErrorMessage,
  isTodoItemShape,
  serializeToolResultOutput,
  userMessageText,
} from '../utils/event-payload.ts';
import { formatBackgroundTaskTranscript, isTerminalBackgroundTask } from '../utils/background-task-status.ts';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status.ts';
import { currentTheme } from '../theme/index.ts';
import type { ColorToken } from '../theme/index.ts';
import { nextTranscriptId } from '../utils/transcript-id.ts';
import type { StreamingUIController } from './streaming-ui.ts';
import type { TasksBrowserController } from './tasks-browser.ts';
import { SubAgentEventHandler } from './subagent-event-handler.ts';
import {
  sumTokenUsage,
  type AppState,
  type GoalChange,
  type LivePaneState,
  type QueuedMessage,
  type ToolCallBlockData,
  type ToolResultBlockData,
  type TranscriptEntry,
} from '../types.ts';
import type { TUIState } from '../tui-state.ts';

type EventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

export interface SessionEventHost {
  state: TUIState;
  session: HarnessSession | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): HarnessSession;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  updateActivityPane(): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(session: HarnessSession, item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  handleTurnStarted?(event: EventOf<'turn.started'>): void;
  handleTurnEnded?(event: EventOf<'turn.ended'>): void;
  readonly tasksBrowserController: TasksBrowserController;
}

/** Statuses of a `turn.step.interrupted` the engine reports for a user abort. */
const USER_ABORT_REASONS = new Set(['aborted', 'cancelled', '']);

export class SessionEventHandler {
  readonly subAgentEventHandler: SubAgentEventHandler;

  constructor(private readonly host: SessionEventHost) {
    this.subAgentEventHandler = new SubAgentEventHandler(host, {
      backgroundTasks: this.backgroundTasks,
      backgroundTaskTranscriptedTerminal: this.backgroundTaskTranscriptedTerminal,
      syncBackgroundAgentBadge: () => {
        this.syncBackgroundTaskBadge();
      },
    });
  }

  // Runtime state – owned by this handler, reset between sessions.
  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  renderedSkillActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();
  /** The last goal snapshot seen, so a `goal.updated` can be turned into a lifecycle change. */
  private lastGoal: GoalSnapshot | null = null;
  /** Set by `/goal cancel` so the following `goal.updated: null` reads as a cancel, not a completion. */
  goalCancelPending = false;
  /** Summary text captured from `history.compacted`, consumed by the following `compaction.completed`. */
  private pendingCompactionSummary: string | undefined;
  private currentTurnHasAssistantText = false;
  /** Set once this turn's failure has been shown, so `turn.ended` does not repeat it. */
  private turnErrorReported = false;
  private stepRetryAttemptTimer: ReturnType<typeof setTimeout> | undefined;

  resetRuntimeState(): void {
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subAgentEventHandler.resetRuntimeState();
    this.renderedSkillActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.lastGoal = null;
    this.goalCancelPending = false;
    this.pendingCompactionSummary = undefined;
    this.currentTurnHasAssistantText = false;
    this.turnErrorReported = false;
    this.clearStepRetryAttemptTimer();
    this.stopAllMcpServerStatusSpinners();
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const sessionId = session.id;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: HarnessSession): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      const views = session.mcp?.list() ?? [];
      servers = await Promise.all(
        views.map(async (view) => {
          let toolCount = 0;
          if (view.status === 'connected') {
            try {
              toolCount = (await session.mcp?.listTools(view.name) ?? []).length;
            } catch {
              toolCount = 0;
            }
          }
          return {
            name: view.name,
            transport: view.transport,
            status: view.status,
            toolCount,
            ...(view.error !== undefined ? { error: view.error } : {}),
          };
        }),
      );
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      host.showError(`Failed to sync MCP server status: ${formatErrorMessage(error)}`);
      return;
    }
    if (host.session !== session || host.state.appState.sessionId !== session.id) return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }
    this.mcpServers.clear();
    for (const server of servers) this.mcpServers.set(server.name, server);
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
    }
    const summary = formatMcpStartupStatusSummary(servers);
    host.setAppState({ mcpServersSummary: summary || null });
    // Servers still connecting report no event when they settle: poll them to a terminal state.
    if (servers.some((server) => server.status === 'pending')) {
      setTimeout(() => {
        if (host.session === session && !host.aborted) void this.syncMcpServerStatusSnapshot(session);
      }, 1500);
    }
  }

  handleEvent(event: AgentEvent, sendQueued: (item: QueuedMessage) => void): void {
    // Everything a subagent emits routes to its parent card; the main agent's events flow on.
    if (event.address !== MAIN_AGENT_ID && this.subAgentEventHandler.routeChildAgentEvent(event)) return;

    if ('turnId' in event && typeof event.turnId === 'string' && event.address === MAIN_AGENT_ID) {
      this.host.streamingUI.setTurnId(event.turnId);
    }

    switch (event.type) {
      case 'turn.started': this.handleTurnBegin(event); break;
      case 'turn.ended': this.handleTurnEnd(event, sendQueued); break;
      case 'turn.step.started': this.handleStepBegin(event); break;
      case 'turn.step.interrupted': this.handleStepInterrupted(event); break;
      case 'turn.step.completed': this.handleStepCompleted(event); break;
      case 'turn.step.retrying': this.handleStepRetrying(event); break;
      case 'turn.step.reset': this.handleStepReset(event); break;
      case 'turn.paused': this.handleTurnPaused(event); break;
      case 'tool.progress': this.handleToolProgress(event); break;
      case 'assistant.delta': this.handleAssistantDelta(event); break;
      case 'thinking.delta': this.handleThinkingDelta(event); break;
      case 'tool.call.started': this.handleToolCall(event); break;
      case 'tool.call.delta': this.handleToolCallDelta(event); break;
      case 'tool.detachable': this.handleToolDetachable(event); break;
      case 'tool.suspended': this.handleToolSuspended(event); break;
      case 'tool.result': this.handleToolResult(event); break;
      case 'message.appended': this.handleMessageAppended(event); break;
      case 'goal.updated': this.handleGoalUpdated(event); break;
      case 'plan.updated': this.handlePlanUpdated(event); break;
      case 'skill.activated': this.handleSkillActivated(event); break;
      case 'usage.updated': this.handleUsageUpdated(event); break;
      case 'error': this.handleSessionError(event); break;
      case 'warning': this.handleSessionWarning(event); break;
      case 'guardrail.blocked': this.handleGuardrailBlocked(event); break;
      case 'compaction.started': this.handleCompactionBegin(event); break;
      case 'history.compacted': this.pendingCompactionSummary = event.summary; break;
      case 'compaction.completed': this.handleCompactionEnd(event, sendQueued); break;
      case 'agent.started':
      case 'agent.ended':
        // The main agent's own lifecycle: nothing to render beyond the turn events.
        break;
      case 'agent.handoff': this.handleHandoff(event); break;
      case 'background.task.started':
      case 'background.task.terminated':
        this.handleBackgroundTaskEvent(event); break;
      case 'workflow.progress': this.handleWorkflowProgress(event); break;
      case 'extension':
      case 'steer.queued':
      case 'history.replaced':
      case 'content.part':
      case 'model.request':
        break;
      default:
        break;
    }
  }

  stopAllMcpServerStatusSpinners(): void {
    for (const spinner of this.mcpServerStatusSpinners.values()) spinner.stop();
    this.mcpServerStatusSpinners.clear();
  }

  // ---------------------------------------------------------------------------
  // Turn / step lifecycle
  // ---------------------------------------------------------------------------

  private handleTurnBegin(event: EventOf<'turn.started'>): void {
    this.host.handleTurnStarted?.(event);
    this.currentTurnHasAssistantText = false;
    this.turnErrorReported = false;
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.setStep(0);
    this.host.patchLivePane({ mode: 'waiting', pendingApproval: null, pendingQuestion: null });
    this.host.setAppState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
  }

  private handleTurnEnd(event: EventOf<'turn.ended'>, sendQueued: (item: QueuedMessage) => void): void {
    this.host.handleTurnEnded?.(event);
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    if (event.reason === 'failed' && !this.turnErrorReported) {
      this.host.showStatus(
        event.error !== undefined && event.error.length > 0 ? `Turn failed: ${event.error}` : 'Turn failed.',
        'error',
      );
    }
    if (event.contextWindow !== undefined && event.contextWindow > 0) {
      this.host.setAppState({ maxContextTokens: event.contextWindow });
    }
    this.refreshContextBreakdown();
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.currentTurnHasAssistantText = false;
  }

  /** A turn boundary is where the engine measures the context; read it for the footer gauge. */
  private refreshContextBreakdown(): void {
    const session = this.host.session;
    if (session === undefined) return;
    try {
      const breakdown = session.getContextBreakdown();
      if (breakdown === undefined) return;
      this.host.setAppState({
        contextTokens: breakdown.used,
        maxContextTokens: breakdown.contextWindow,
        contextUsage: breakdown.contextWindow > 0 ? breakdown.used / breakdown.contextWindow : 0,
      });
    } catch {
      // Best-effort: the gauge keeps its last reading.
    }
  }

  private handleStepBegin(event: EventOf<'turn.step.started'>): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.setStep(event.step);
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.patchLivePane({ mode: 'waiting', pendingApproval: null, pendingQuestion: null });
    this.host.setAppState({ streamingPhase: 'waiting', streamingStartTime: Date.now() });
  }

  private handleStepCompleted(event: EventOf<'turn.step.completed'>): void {
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    if (event.usage !== undefined) {
      // The prompt side of the step's usage is the context the model saw this step.
      const contextTokens = event.usage.input + event.usage.cacheRead + event.usage.cacheWrite;
      const max = event.contextWindow !== undefined && event.contextWindow > 0 ? event.contextWindow : this.host.state.appState.maxContextTokens;
      this.host.setAppState({
        contextTokens,
        ...(event.contextWindow !== undefined && event.contextWindow > 0 ? { maxContextTokens: event.contextWindow } : {}),
        contextUsage: max > 0 ? contextTokens / max : 0,
      });
    }
    if (event.finishReason !== 'length') return;
    const truncatedCount = this.host.streamingUI.markStepTruncated(event.turnId, event.step);
    this.host.showNotice(
      truncatedCount > 0
        ? 'Model hit its output limit — a tool call was truncated before it could run.'
        : 'Model hit its output limit — the reply was cut short.',
    );
  }

  private handleStepRetrying(event: EventOf<'turn.step.retrying'>): void {
    // The failure may arrive mid-stream: drive the pane back to waiting so the retry label renders.
    this.host.patchLivePane({ mode: 'waiting' });
    this.host.setAppState({
      streamingPhase: 'waiting',
      stepRetry: {
        nextAttempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: 'Retrying',
        errorMessage: event.reason ?? '',
        phase: 'backoff',
      },
    });
    this.clearStepRetryAttemptTimer();
    this.stepRetryAttemptTimer = setTimeout(() => {
      this.stepRetryAttemptTimer = undefined;
      const retry = this.host.state.appState.stepRetry;
      if (retry === null) return;
      this.host.setAppState({ stepRetry: { ...retry, phase: 'attempt' } });
    }, event.delayMs);
  }

  /** A provisional step was discarded (an optimistic guardrail, a mid-step failure): drop what it streamed. */
  private handleStepReset(event: EventOf<'turn.step.reset'>): void {
    this.host.streamingUI.discardPending();
    this.host.streamingUI.dropStreamedStep();
    this.host.streamingUI.resetToolUi();
    this.host.patchLivePane({ mode: 'waiting' });
    if (event.reason !== undefined && event.reason.length > 0) {
      this.host.showStatus(`Retrying step: ${event.reason}`, 'warning');
    }
  }

  private handleTurnPaused(event: EventOf<'turn.paused'>): void {
    this.host.streamingUI.flushNow();
    this.host.showNotice(
      `Run paused for ${String(event.pending.length)} pending response(s).`,
      'The session was interrupted durably. Use /continue to answer and resume it.',
    );
  }

  private clearStepRetry(): void {
    this.clearStepRetryAttemptTimer();
    if (this.host.state.appState.stepRetry === null) return;
    this.host.setAppState({ stepRetry: null });
  }

  clearStepRetryAttemptTimer(): void {
    if (this.stepRetryAttemptTimer !== undefined) {
      clearTimeout(this.stepRetryAttemptTimer);
      this.stepRetryAttemptTimer = undefined;
    }
  }

  private handleStepInterrupted(event: EventOf<'turn.step.interrupted'>): void {
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    const reason = event.reason;
    if (reason === 'error') return;
    if (USER_ABORT_REASONS.has(reason)) {
      if (event.message === undefined || event.message === '') {
        this.host.showStatus('Interrupted by user', 'error');
      } else {
        this.host.showError(event.message);
      }
      return;
    }
    this.host.showError(reason === 'max_steps' ? 'reached per-turn step limit (max_steps)' : `step interrupted (${reason})`);
  }

  // ---------------------------------------------------------------------------
  // Streamed content
  // ---------------------------------------------------------------------------

  private handleThinkingDelta(event: EventOf<'thinking.delta'>): void {
    const { state, streamingUI } = this.host;
    // Redacted or whitespace-only thinking carries nothing to render: keep the spinner up.
    if (event.delta.trim().length === 0 && !streamingUI.hasThinkingDraft()) return;
    streamingUI.appendThinkingDelta(event.delta);
    this.host.patchLivePane({ mode: 'idle' });
    if (state.appState.streamingPhase !== 'thinking') {
      this.host.setAppState({ streamingPhase: 'thinking', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleAssistantDelta(event: EventOf<'assistant.delta'>): void {
    const { state, streamingUI } = this.host;
    if (streamingUI.hasThinkingDraft()) streamingUI.flushThinkingToTranscript('idle');
    if (event.delta.trim().length > 0) this.currentTurnHasAssistantText = true;
    streamingUI.appendAssistantDelta(event.delta);
    this.host.patchLivePane({ mode: 'idle', pendingApproval: null, pendingQuestion: null });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  private handleToolCall(event: EventOf<'tool.call.started'>): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    // A nested call (a Code Mode program calling a tool) is a line on its parent's card.
    if (event.parentToolCallId !== undefined) {
      streamingUI.getToolComponent(event.parentToolCallId)?.appendSubToolCall({
        id: event.toolCallId,
        name: event.toolName,
        args: argsRecord(event.args),
      });
      return;
    }
    const { turnId, step } = streamingUI.getTurnContext();
    const args = argsRecord(event.args);
    const description = typeof args['description'] === 'string' ? args['description'] : undefined;
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.toolName,
      args,
      ...(description !== undefined ? { description } : {}),
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    this.host.patchLivePane({ mode: 'tool', pendingApproval: null, pendingQuestion: null });
  }

  private handleToolCallDelta(event: EventOf<'tool.call.delta'>): void {
    if (event.toolCallId.length === 0) return;
    const { state, streamingUI } = this.host;
    streamingUI.accumulateToolCallDelta(event.toolCallId, event.toolName, event.argumentsPart);
    this.host.patchLivePane({ mode: 'tool', pendingApproval: null, pendingQuestion: null });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleToolProgress(event: EventOf<'tool.progress'>): void {
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    if (event.parentToolCallId !== undefined) {
      const parent = this.host.streamingUI.getToolComponent(event.parentToolCallId);
      if (parent !== undefined && (event.update.kind === 'stdout' || event.update.kind === 'stderr' || event.update.kind === 'status')) {
        parent.appendSubToolLiveOutput(event.toolCallId, text, { replace: event.update.kind === 'status' });
      }
      return;
    }
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (tc === undefined) return;
    if (event.update.kind === 'status' || event.update.kind === 'progress') {
      const label = event.update.percent !== undefined ? `${text} (${String(Math.round(event.update.percent))}%)` : text;
      tc.appendProgress(label, { replace: true });
      return;
    }
    if (event.update.kind === 'stdout' || event.update.kind === 'stderr') {
      tc.appendLiveOutput(text);
    }
  }

  private handleToolDetachable(event: EventOf<'tool.detachable'>): void {
    const call = this.host.streamingUI.getActiveToolCall(event.toolCallId);
    if (call !== undefined) call.detachable = true;
    this.host.streamingUI.getToolComponent(event.toolCallId)?.appendProgress('detachable — ctrl+b moves it to the background', { replace: true });
  }

  private handleToolSuspended(event: EventOf<'tool.suspended'>): void {
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    const kind = event.request?.kind ?? 'input';
    tc?.appendProgress(`waiting for ${kind}`, { replace: true });
  }

  private handleToolResult(event: EventOf<'tool.result'>): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    this.clearStepRetry();
    const output = serializeToolResultOutput(event.result.content);
    if (event.parentToolCallId !== undefined) {
      streamingUI.getToolComponent(event.parentToolCallId)?.finishSubToolCall({
        tool_call_id: event.toolCallId,
        output,
        is_error: event.isError,
      });
      return;
    }
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output,
      is_error: event.isError,
      details: event.result.details,
    };
    const matchedCall = streamingUI.completeToolResult(event.toolCallId, resultData);
    if (matchedCall !== undefined && !event.isError) this.applyToolResultDetails(matchedCall, event.result.details);
    this.host.patchLivePane({ mode: 'waiting' });
  }

  /** Capability state rides tool results: the todo list, the goal record, plan-mode flags. */
  private applyToolResultDetails(call: ToolCallBlockData, details: unknown): void {
    const record = argsRecord(details);
    const rawTodos = record['todos'];
    if (call.name === 'TodoList' && Array.isArray(rawTodos)) {
      const sanitized = rawTodos.filter(isTodoItemShape).map((t) => ({ title: t.title, status: t.status }));
      this.host.streamingUI.setTodoList(sanitized);
    }
    if ('planActive' in record && typeof record['planActive'] === 'boolean') {
      this.host.setAppState({ planMode: record['planActive'] });
    }
    const goal = argsRecord(record['goal']);
    if ((call.name === 'UpdateGoal' || call.name === 'SetGoalBudget') && goal['status'] === 'complete' && this.lastGoal !== null) {
      // The model marked the goal complete: the completion card uses the last live figures.
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'assistant',
        renderMode: 'markdown',
        content: buildGoalCompletionMessage({
          ...this.lastGoal,
          terminalReason: typeof goal['terminalReason'] === 'string' ? goal['terminalReason'] : this.lastGoal.terminalReason,
        }),
      });
      this.lastGoal = null;
      this.goalCancelPending = true; // the engine's follow-up `goal.updated: null` is not a second card
    }
  }

  // ---------------------------------------------------------------------------
  // Journaled messages the TUI did not author itself
  // ---------------------------------------------------------------------------

  private handleMessageAppended(event: EventOf<'message.appended'>): void {
    const { message, origin } = event;
    if (message.role === 'assistant') {
      if (message.stopReason !== 'error') return;
      const reason = message.errorMessage ?? 'the provider rejected the request';
      this.host.streamingUI.flushNow();
      this.host.showError(reason);
      this.turnErrorReported = true;
      return;
    }
    if (message.role !== 'user' || origin === undefined) return;
    switch (origin.kind) {
      case 'cron_job':
        this.host.streamingUI.flushNow();
        this.host.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'cron',
          turnId: this.host.streamingUI.getTurnContext().turnId,
          renderMode: 'plain',
          content: userMessageText(message),
          cronData: {
            jobId: origin.jobId,
            cron: origin.cron,
            recurring: origin.recurring,
            coalescedCount: origin.coalescedCount,
            stale: origin.stale,
          },
        });
        return;
      case 'cron_missed':
        this.host.streamingUI.flushNow();
        this.host.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'cron',
          turnId: this.host.streamingUI.getTurnContext().turnId,
          renderMode: 'plain',
          content: userMessageText(message),
          cronData: { missedCount: origin.count },
        });
        return;
      case 'external':
      case 'extension':
      case 'user_follow_up':
        // Delivered from outside this editor (a peer, an extension, the follow-up channel): show
        // it as a user turn so the transcript matches what the model saw.
        if (origin.kind === 'extension' && origin.extensionId === 'cron') return;
        this.host.streamingUI.flushNow();
        this.host.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'user',
          turnId: undefined,
          renderMode: 'plain',
          content: userMessageText(message),
          bullet: originBullet(origin),
        });
        return;
      default:
        // Our own prompts (rendered at submit), injections, summaries and task notices (rendered
        // from their lifecycle events) stay silent here.
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Capability state
  // ---------------------------------------------------------------------------

  private handleGoalUpdated(event: EventOf<'goal.updated'>): void {
    const snapshot = (event.snapshot ?? null) as GoalSnapshot | null;
    const previous = this.lastGoal;
    this.lastGoal = snapshot;
    this.host.setAppState({ goal: snapshot });
    const change = goalChangeBetween(previous, snapshot, this.goalCancelPending);
    this.goalCancelPending = false;
    if (change === undefined) return;
    if (change.kind === 'completion') {
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'goal',
        renderMode: 'plain',
        content: 'Goal cancelled',
        goalData: { kind: 'lifecycle', change: { kind: 'lifecycle', status: 'paused', reason: 'Goal cancelled', actor: 'user' } },
      });
      return;
    }
    const marker = buildGoalMarker(change, this.host.state.toolOutputExpanded, change.actor);
    if (marker !== null) {
      this.host.state.transcriptContainer.addChild(marker);
      this.host.state.ui.requestRender();
    }
  }

  private handlePlanUpdated(event: EventOf<'plan.updated'>): void {
    const snapshot = event.snapshot as null | { readonly id: string; readonly content: string; readonly path: string };
    this.host.setAppState({ planMode: snapshot !== null && snapshot !== undefined });
  }

  private handleUsageUpdated(event: EventOf<'usage.updated'>): void {
    this.host.setAppState({ cumulativeTokens: sumTokenUsage(event.usage) });
  }

  private handleSessionError(event: EventOf<'error'>): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    this.host.showError(event.message);
    this.turnErrorReported = true;
  }

  private handleSessionWarning(event: EventOf<'warning'>): void {
    this.host.showStatus(`Warning: ${event.message}`, 'warning');
  }

  private handleGuardrailBlocked(event: EventOf<'guardrail.blocked'>): void {
    this.host.streamingUI.flushNow();
    if (event.stage === 'output') this.host.streamingUI.dropStreamedStep();
    this.host.showStatus(`Blocked by ${event.guardrail} (${event.stage}): ${event.message}`, 'error');
  }

  private handleHandoff(event: EventOf<'agent.handoff'>): void {
    this.host.streamingUI.flushNow();
    this.host.showNotice(`Handoff: ${event.from} → ${event.to}`);
  }

  private handleWorkflowProgress(event: EventOf<'workflow.progress'>): void {
    const progress = event.progress;
    switch (progress.type) {
      case 'started':
        this.host.showStatus(`Workflow "${progress.name}" started (${event.runId})`, 'textMuted');
        return;
      case 'phase':
        this.host.showStatus(`Workflow phase ${String(progress.index + 1)}: ${progress.title}`, 'textMuted');
        return;
      case 'outcome':
        this.host.showStatus(
          `Workflow ${progress.status}${progress.error !== undefined ? `: ${progress.error}` : ''}`,
          progress.ok ? 'success' : 'error',
        );
        return;
      default:
        return;
    }
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([...this.mcpServers.values()]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    switch (server.status) {
      case 'connected': {
        const toolStr = `${String(server.toolCount)} tool${server.toolCount === 1 ? '' : 's'}`;
        this.finalizeMcpServerStatusRow(server.name, `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`, 'success');
        return;
      }
      case 'failed':
        this.finalizeMcpServerStatusRow(server.name, `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ''}`, 'error');
        return;
      case 'needs-auth':
        this.finalizeMcpServerStatusRow(server.name, `MCP server "${server.name}" needs authentication`, 'warning');
        return;
      case 'disabled':
        this.finalizeMcpServerStatusRow(server.name, `MCP server "${server.name}" disabled`, 'textMuted');
        return;
      case 'pending':
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const { state } = this.host;
    const label = `MCP server "${name}" connecting…`;
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => currentTheme.fg('textMuted', s);
    const spinner = new MoonLoader(state.ui, 'braille', tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(name: string, message: string, color: ColorToken): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, color);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) children[idx] = status;
    else state.transcriptContainer.addChild(status);
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  private handleSkillActivated(event: EventOf<'skill.activated'>): void {
    if (this.renderedSkillActivationIds.has(event.activationId)) return;
    this.renderedSkillActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: `Activated skill: ${event.skillName}`,
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      skillTrigger: event.trigger,
    });
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  private handleCompactionBegin(event: EventOf<'compaction.started'>): void {
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.setAppState({ isCompacting: true, streamingPhase: 'waiting', streamingStartTime: Date.now() });
    this.host.streamingUI.beginCompaction(event.instruction);
  }

  private handleCompactionEnd(event: EventOf<'compaction.completed'>, sendQueued: (item: QueuedMessage) => void): void {
    this.host.streamingUI.endCompaction(event.tokensBefore, event.tokensAfter, this.pendingCompactionSummary);
    this.pendingCompactionSummary = undefined;
    this.refreshContextBreakdown();
    this.finishCompaction(sendQueued);
  }

  /** `/compact` was withdrawn before it ran (`cancelCompaction`): the block closes as cancelled. */
  noteCompactionCancelled(sendQueued: (item: QueuedMessage) => void): void {
    this.host.streamingUI.cancelCompaction();
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) this.host.state.queuedMessageDispatchPending = true;
      this.host.setAppState({ isCompacting: false, streamingPhase: 'idle' });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          this.host.state.queuedMessageDispatchPending = false;
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Background task lifecycle
  // ---------------------------------------------------------------------------

  private handleBackgroundTaskEvent(event: EventOf<'background.task.started'> | EventOf<'background.task.terminated'>): void {
    const { state } = this.host;
    const info = event.info as BackgroundTaskInfo;
    if (typeof info?.taskId !== 'string') return;
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    const viewer = state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.host.tasksBrowserController.refreshOutputViewer({ silent: true });
    }

    if (event.type === 'background.task.started') {
      if (info.kind === 'agent') {
        // A foreground subagent detached (Ctrl+B) or a run_in_background spawn: its card reads
        // `◐ backgrounded` instead of looking finished.
        this.host.streamingUI.markSubagentBackgrounded(info.agentId);
        this.subAgentEventHandler.noteBackgroundAgent(info);
        this.syncBackgroundTaskBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (isTerminalBackgroundTask(info)) {
      if (info.kind === 'agent') {
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status === 'running' || info.status === 'paused' ? 'failed' : info.status,
        });
        this.subAgentEventHandler.noteBackgroundAgentTerminal(info);
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        this.appendBackgroundTaskEntry(info);
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) this.syncBackgroundTaskBadge();
    this.host.tasksBrowserController.repaint();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    });
  }

  syncBackgroundTaskBadge(): void {
    const { state } = this.host;
    let bashTasks = 0;
    let agentTasks = 0;
    for (const info of this.backgroundTasks.values()) {
      if (isTerminalBackgroundTask(info)) continue;
      if (info.kind === 'agent') agentTasks += 1;
      else bashTasks += 1;
    }
    state.footer.setBackgroundCounts({ bashTasks, agentTasks });
    state.ui.requestRender();
  }
}

/**
 * Turn two consecutive goal snapshots into the lifecycle change the transcript marks. The
 * engine broadcasts state, so pause / resume / block are read off the status transition; a
 * snapshot that vanished is a cancel (or the tail of a completion already rendered).
 */
export function goalChangeBetween(
  previous: GoalSnapshot | null,
  next: GoalSnapshot | null,
  cancelPending: boolean,
): GoalChange | undefined {
  if (next === null) {
    if (previous === null || cancelPending) return undefined;
    return { kind: 'completion', status: 'complete', actor: 'user' };
  }
  if (previous === null) return undefined; // creation: the /goal command renders its own card
  if (previous.status === next.status) return undefined;
  return { kind: 'lifecycle', status: next.status, reason: next.terminalReason, actor: undefined };
}

function originBullet(origin: PromptOrigin): string | undefined {
  switch (origin.kind) {
    case 'external':
      return `${origin.actor ?? origin.source} ›`;
    case 'extension':
      return `${origin.extensionId} ›`;
    default:
      return undefined;
  }
}

/** The text of a journaled message, for callers that only have the `Message`. */
export function messageText(message: Message): string {
  if (message.role === 'user') return userMessageText(message);
  if (message.role === 'assistant') {
    return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return serializeToolResultOutput(message.content);
}

export type { Usage };
