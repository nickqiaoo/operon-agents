import type { AgentEvent, BackgroundTaskInfo } from 'operon-agents';

import { MAIN_AGENT_ID } from '../constant/tui.ts';
import type { BackgroundAgentMetadata, ToolCallBlockData, ToolResultBlockData, TranscriptEntry } from '../types.ts';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status.ts';
import { argsRecord, serializeToolResultOutput } from '../utils/event-payload.ts';
import { nextTranscriptId } from '../utils/transcript-id.ts';
import type { SessionEventHost } from './session-event-handler.ts';
import { SubagentActivityStore } from './subagent-activity-store.ts';

export interface SubagentInfo {
  /** The subagent's conversation address (`main/<agentId>`). */
  readonly address: string;
  readonly agentId: string;
  readonly parentToolCallId: string;
  /** The agent type (`Agent.subagent_type`), the engine's `agent.started.agent`. */
  readonly name: string;
  readonly runInBackground: boolean;
}

export interface SubAgentEventHandlerDependencies {
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly backgroundTaskTranscriptedTerminal: Set<string>;
  readonly syncBackgroundAgentBadge: () => void;
}

/** `main/agent_x` → `agent_x`: the last address segment is the subagent's id. */
export function agentIdFromAddress(address: string): string {
  const slash = address.lastIndexOf('/');
  return slash < 0 ? address : address.slice(slash + 1);
}

/**
 * Routes every event a subagent emits (its `address` is not `main`) onto the parent `Agent`
 * tool call's card: text and thinking stream into the card's subagent section, its tool calls
 * become sub-rows, and `agent.started` / `agent.ended` drive the card's phase. Background
 * subagents (spawned with `run_in_background`) get transcript status lines instead.
 */
export class SubAgentEventHandler {
  /** Keyed by address. */
  readonly subagentInfo: Map<string, SubagentInfo> = new Map();
  /** Keyed by agentId. */
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata> = new Map();
  /** Bounded per-agent activity fold feeding the background-agent detail view. */
  readonly activityStore = new SubagentActivityStore();
  /** Streamed reply text per child address, the completion summary when `agent.ended` lands. */
  private readonly replyText: Map<string, string> = new Map();

  constructor(
    private readonly host: SessionEventHost,
    private readonly deps: SubAgentEventHandlerDependencies,
  ) {}

  resetRuntimeState(): void {
    this.subagentInfo.clear();
    this.backgroundAgentMetadata.clear();
    this.activityStore.clear();
    this.replyText.clear();
  }

  /** Returns true when the event belonged to a subagent and was consumed. */
  routeChildAgentEvent(event: AgentEvent): boolean {
    if (event.address === MAIN_AGENT_ID) return false;
    const agentId = agentIdFromAddress(event.address);

    if (event.type === 'agent.started') {
      this.handleSpawned(event.address, agentId, event.agent, event.parentToolCallId);
      return true;
    }

    // Tee every child-agent event into the activity store before routing swallows events whose
    // parent card is gone (Ctrl+B) or never existed (run_in_background).
    this.activityStore.applyEvent(agentId, event);

    if (event.type === 'agent.ended') {
      this.handleEnded(event.address, agentId);
      return true;
    }
    if (event.type === 'turn.ended' && event.reason === 'failed') {
      this.handleFailed(event.address, agentId, event.error ?? 'subagent failed');
      return true;
    }

    const info = this.subagentInfo.get(event.address);
    if (info === undefined || info.parentToolCallId.length === 0) return true;

    const toolCall = this.host.streamingUI.getToolComponent(info.parentToolCallId);
    if (toolCall === undefined) return true;
    toolCall.setSubagentMeta(agentId, info.name);

    switch (event.type) {
      case 'assistant.delta':
        this.replyText.set(event.address, (this.replyText.get(event.address) ?? '') + event.delta);
        toolCall.appendSubagentText(event.delta, 'text');
        break;
      case 'thinking.delta':
        toolCall.appendSubagentText(event.delta, 'thinking');
        break;
      case 'tool.call.started':
        toolCall.appendSubToolCall({ id: `${agentId}:${event.toolCallId}`, name: event.toolName, args: argsRecord(event.args) });
        break;
      case 'tool.call.delta':
        toolCall.appendSubToolCallDelta({
          id: `${agentId}:${event.toolCallId}`,
          name: event.toolName,
          argumentsPart: event.argumentsPart,
        });
        break;
      case 'tool.progress':
        if ((event.update.kind === 'stdout' || event.update.kind === 'stderr' || event.update.kind === 'status') && event.update.text !== undefined) {
          toolCall.appendSubToolLiveOutput(`${agentId}:${event.toolCallId}`, event.update.text, {
            replace: event.update.kind === 'status',
          });
        }
        break;
      case 'tool.result':
        toolCall.finishSubToolCall({
          tool_call_id: `${agentId}:${event.toolCallId}`,
          output: serializeToolResultOutput(event.result.content),
          is_error: event.isError,
        });
        break;
      case 'turn.step.completed':
        if (event.usage !== undefined) {
          toolCall.updateSubagentMetrics({
            contextTokens: event.usage.input + event.usage.cacheRead + event.usage.cacheWrite,
            usage: event.usage,
          });
        }
        break;
      default:
        break;
    }
    this.host.state.ui.requestRender();
    return true;
  }

  /** A `background.task.started` for an agent task: remember its metadata for the terminal notice. */
  noteBackgroundAgent(info: Extract<BackgroundTaskInfo, { kind: 'agent' }>): void {
    const agentId = info.agentId;
    if (agentId === undefined) return;
    const existing = this.backgroundAgentMetadata.get(agentId);
    const agentName = info.subagentType ?? existing?.agentName;
    const meta: BackgroundAgentMetadata = {
      agentId,
      parentToolCallId: info.toolCallId ?? existing?.parentToolCallId ?? '',
      ...(agentName !== undefined ? { agentName } : {}),
      description: info.description,
    };
    if (existing === undefined) {
      this.backgroundAgentMetadata.set(agentId, meta);
      this.appendBackgroundAgentEntry('started', meta);
      // A subagent that started in the foreground and was detached: its address entry flips.
      for (const [address, subagent] of this.subagentInfo) {
        if (subagent.agentId === agentId && !subagent.runInBackground) {
          this.subagentInfo.set(address, { ...subagent, runInBackground: true });
        }
      }
    }
    this.activityStore.ensureRecord({
      agentId,
      agentName: meta.agentName,
      description: meta.description,
      parentToolCallId: meta.parentToolCallId,
    });
  }

  /** A background agent task reached a terminal status. */
  noteBackgroundAgentTerminal(info: Extract<BackgroundTaskInfo, { kind: 'agent' }>): void {
    const agentId = info.agentId;
    if (agentId === undefined) return;
    const record = this.activityStore.get(agentId);
    if (record !== undefined && record.status === 'running') {
      if (info.status === 'completed') this.activityStore.markCompleted(agentId);
      else this.activityStore.markFailed(agentId, info.stopReason);
    }
    const meta = this.backgroundAgentMetadata.get(agentId);
    if (meta === undefined) return;
    this.backgroundAgentMetadata.delete(agentId);
    this.deps.syncBackgroundAgentBadge();
    if (this.deps.backgroundTaskTranscriptedTerminal.has(info.taskId)) return;
    this.deps.backgroundTaskTranscriptedTerminal.add(info.taskId);
    if (info.status === 'completed') {
      this.appendBackgroundAgentEntry('completed', meta);
    } else {
      this.appendBackgroundAgentEntry('failed', meta, { error: info.stopReason ?? info.status });
    }
  }

  private handleSpawned(address: string, agentId: string, name: string, parentToolCallId: string | undefined): void {
    const parent = parentToolCallId === undefined ? undefined : this.host.streamingUI.getActiveToolCall(parentToolCallId);
    const runInBackground =
      parent?.args['run_in_background'] === true ||
      this.backgroundAgentMetadata.has(agentId) ||
      [...this.deps.backgroundTasks.values()].some((task) => task.kind === 'agent' && task.agentId === agentId);
    const description = typeof parent?.args['description'] === 'string' ? (parent.args['description'] as string) : undefined;
    this.subagentInfo.set(address, {
      address,
      agentId,
      parentToolCallId: parentToolCallId ?? '',
      name,
      runInBackground,
    });
    this.replyText.delete(address);
    this.activityStore.ensureRecord({
      agentId,
      agentName: name,
      description,
      parentToolCallId: parentToolCallId ?? '',
    });

    if (runInBackground) {
      if (!this.backgroundAgentMetadata.has(agentId)) {
        const meta: BackgroundAgentMetadata = {
          agentId,
          parentToolCallId: parentToolCallId ?? '',
          agentName: name,
          ...(description !== undefined ? { description } : {}),
        };
        this.backgroundAgentMetadata.set(agentId, meta);
        this.appendBackgroundAgentEntry('started', meta);
        this.deps.syncBackgroundAgentBadge();
      }
      return;
    }

    if (parentToolCallId === undefined) return;
    let tc = this.getOrActivateToolComponent(parentToolCallId);
    tc ??= this.createStandaloneSubagentToolCall(parentToolCallId, name, description);
    if (tc === undefined) return;
    tc.onSubagentSpawned({ agentId, agentName: name, runInBackground: false });
    tc.onSubagentStarted({ agentId, agentName: name, runInBackground: false });
  }

  private handleEnded(address: string, agentId: string): void {
    const summary = this.replyText.get(address)?.trim();
    this.replyText.delete(address);
    this.activityStore.markCompleted(agentId, summary);
    const info = this.subagentInfo.get(address);
    if (info === undefined || info.runInBackground) {
      this.pruneForegroundOnlyRecord(agentId);
      return;
    }
    const tc = this.host.streamingUI.getToolComponent(info.parentToolCallId);
    if (tc !== undefined) {
      tc.onSubagentCompleted({ resultSummary: summary });
      this.host.streamingUI.removeToolComponentIfInactive(info.parentToolCallId);
    }
    this.pruneForegroundOnlyRecord(agentId);
  }

  private handleFailed(address: string, agentId: string, error: string): void {
    this.activityStore.markFailed(agentId, error);
    const info = this.subagentInfo.get(address);
    if (info === undefined) return;
    if (info.runInBackground) {
      this.host.streamingUI.applyBackgroundTaskTerminalStatus({
        agentId,
        description: info.name,
        status: 'failed',
        errorText: error,
      });
      return;
    }
    const tc = this.host.streamingUI.getToolComponent(info.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentFailed({ error });
    this.host.streamingUI.removeToolComponentIfInactive(info.parentToolCallId);
  }

  /** A subagent that never became a background task can never appear in /tasks: drop its record. */
  private pruneForegroundOnlyRecord(agentId: string): void {
    if (this.backgroundAgentMetadata.has(agentId)) return;
    for (const info of this.deps.backgroundTasks.values()) {
      if (info.kind === 'agent' && info.agentId === agentId) return;
    }
    this.activityStore.drop(agentId);
  }

  dropForegroundOnlyActivityRecords(): void {
    for (const agentId of this.activityStore.agentIds()) this.pruneForegroundOnlyRecord(agentId);
  }

  private appendBackgroundAgentEntry(
    phase: 'started' | 'completed' | 'failed',
    meta: BackgroundAgentMetadata,
    extras: { resultSummary?: string; error?: string } | undefined = undefined,
  ): void {
    const status = formatBackgroundAgentTranscript(phase, meta, extras);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private getOrActivateToolComponent(parentToolCallId: string) {
    let component = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (component !== undefined) return component;
    const toolCall = this.host.streamingUI.getActiveToolCall(parentToolCallId);
    if (toolCall === undefined) return undefined;
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(parentToolCallId);
  }

  private createStandaloneSubagentToolCall(parentToolCallId: string, name: string, description: string | undefined) {
    const label = description ?? `Run ${name} agent`;
    const { turnId, step } = this.host.streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: parentToolCallId,
      name: 'Agent',
      args: { description: label, subagent_type: name },
      description: label,
      step,
      turnId,
    };
    this.host.streamingUI.setActiveToolCall(toolCall.id, toolCall);
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(parentToolCallId);
  }
}

export type { ToolResultBlockData };
