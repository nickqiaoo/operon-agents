/**
 * Format a `BackgroundTaskInfo` snapshot into the transcript card data consumed by
 * `BackgroundAgentStatusComponent`. Tasks have several statuses (running / completed / failed /
 * paused / timed_out / killed / lost) but the card renders three phases (started / completed /
 * failed); the extra nuance lands in the dim detail line.
 */

import type { BackgroundTaskInfo, BackgroundTaskStatus } from 'operon-agents';

import type { BackgroundAgentStatusData, BackgroundAgentStatusPhase } from '../types.ts';

const MAX_DETAIL_LENGTH = 240;

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, ' ');
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_DETAIL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'paused',
  'timed_out',
  'killed',
  'lost',
]);

export function isTerminalBackgroundTask(info: BackgroundTaskInfo): boolean {
  return TERMINAL_TASK_STATUSES.has(info.status);
}

function phaseFromStatus(status: BackgroundTaskStatus): BackgroundAgentStatusPhase {
  switch (status) {
    case 'running':
      return 'started';
    case 'completed':
      return 'completed';
    case 'paused':
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'failed';
  }
}

export function backgroundTaskSubject(info: BackgroundTaskInfo): string {
  switch (info.kind) {
    case 'agent':
      return 'agent task';
    case 'question':
      return 'question task';
    case 'workflow':
      return 'workflow task';
    case 'code':
      return 'code task';
    case 'process':
      return 'bash task';
  }
}

function headlineFor(info: BackgroundTaskInfo): string {
  const subject = backgroundTaskSubject(info);
  switch (info.status) {
    case 'running':
      return `${subject} started in background`;
    case 'completed':
      return `${subject} completed in background`;
    case 'failed':
      return `${subject} failed in background`;
    case 'paused':
      return `${subject} paused`;
    case 'timed_out':
      return `${subject} timed out`;
    case 'killed':
      return `${subject} stopped`;
    case 'lost':
      return `${subject} lost`;
  }
}

function detailFor(info: BackgroundTaskInfo): string | undefined {
  const parts: string[] = [];
  const description = truncate(info.description);
  if (description !== undefined) parts.push(description);

  if ((info.status === 'completed' || info.status === 'failed') && info.kind === 'process' && info.exitCode !== null) {
    parts.push(`exit ${String(info.exitCode)}`);
  }
  if (info.status === 'killed') {
    const reason = truncate(info.stopReason);
    parts.push(reason !== undefined ? `stopped — ${reason}` : 'stopped');
  }
  if (info.status === 'failed' || info.status === 'paused') {
    const reason = truncate(info.stopReason);
    if (reason !== undefined) parts.push(reason);
  }
  if (info.status === 'timed_out') parts.push('timed out');
  if (info.status === 'lost') parts.push('session restarted before completion');

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export function formatBackgroundTaskTranscript(info: BackgroundTaskInfo): BackgroundAgentStatusData {
  return { phase: phaseFromStatus(info.status), headline: headlineFor(info), detail: detailFor(info) };
}
