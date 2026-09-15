import type { ApprovalRequest, ApprovalResponse } from 'operon-agents';

import type { ApprovalPanelResponse } from '../../components/dialogs/approval-panel.ts';
import { goalStartOptions } from '../../components/dialogs/goal-start-permission-prompt.ts';
import type { ApprovalPanelChoice, ApprovalPanelData, DisplayBlock } from '../types.ts';

const DEFAULT_APPROVAL_CHOICES: ApprovalPanelChoice[] = [
  { label: 'Approve once', response: 'approved' },
  { label: 'Approve for this session', response: 'approved_for_session' },
  { label: 'Reject', response: 'rejected' },
  { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
];

const PLAN_REJECT_CHOICES: ApprovalPanelChoice[] = [
  { label: 'Reject', response: 'rejected', selected_label: 'Reject' },
  { label: 'Revise', response: 'rejected', selected_label: 'Revise', requires_feedback: true },
];

/**
 * The engine's `ApprovalRequest.display` is the tool's own `ToolDisplay`: a `title`, an optional
 * `detail`, and whatever tool-specific fields the tool attached (Bash: `command` + `warning`;
 * Edit: `path` + `before`/`after`; Write: `path` + `content`; Read/Glob/Grep: `path`/`pattern`;
 * FetchURL: `url`; WebSearch: `query`; ExitPlanMode: `kind: "plan_review"` + `plan`; a goal
 * start: `kind: "goal_start"`). This adapter reads those fields structurally.
 */
export function adaptApprovalRequest(request: ApprovalRequest): ApprovalPanelData {
  const display = asRecord(request.display);
  const resolved = resolveDisplay(request.toolName, display);
  return {
    id: request.toolCallId,
    tool_call_id: request.toolCallId,
    tool_name: request.toolName,
    action: request.approvalRule,
    description: resolved.description,
    display: resolved.blocks,
    choices: adaptChoices(request.toolName, display),
  };
}

interface ResolvedDisplay {
  blocks: DisplayBlock[];
  description: string;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveDisplay(toolName: string, display: Record<string, unknown>): ResolvedDisplay {
  const kind = stringField(display, 'kind');
  const title = stringField(display, 'title');
  const detail = stringField(display, 'detail');

  if (kind === 'plan_review') return { blocks: [], description: '' };
  if (kind === 'goal_start') {
    const lines = [`Start goal: ${stringField(display, 'objective') ?? ''}`];
    const criterion = stringField(display, 'completionCriterion');
    if (criterion !== undefined && criterion.length > 0) lines.push(`Done when: ${criterion}`);
    return { blocks: [{ type: 'brief', text: lines.join('\n') }], description: 'Start a goal?' };
  }

  const command = stringField(display, 'command');
  if (command !== undefined) {
    const description = stringField(display, 'description');
    return {
      blocks: [
        {
          type: 'shell',
          language: stringField(display, 'language') ?? 'bash',
          command,
          cwd: stringField(display, 'cwd'),
          description,
          danger: stringField(display, 'warning') ?? detectDanger(command),
        },
      ],
      description: description ?? '',
    };
  }

  const path = stringField(display, 'path');
  const before = stringField(display, 'before');
  const after = stringField(display, 'after');
  if (before !== undefined && after !== undefined) {
    return { blocks: [{ type: 'diff', path: path ?? '', old_text: before, new_text: after }], description: '' };
  }

  const content = stringField(display, 'content');
  if (path !== undefined && content !== undefined) {
    return { blocks: [{ type: 'file_content', path, content }], description: '' };
  }

  const url = stringField(display, 'url');
  if (url !== undefined) {
    return { blocks: [{ type: 'url_fetch', url, method: stringField(display, 'method') }], description: '' };
  }

  const query = stringField(display, 'query');
  if (query !== undefined) {
    return { blocks: [{ type: 'search', query }], description: '' };
  }

  const pattern = stringField(display, 'pattern');
  if (pattern !== undefined) {
    return { blocks: [{ type: 'search', query: pattern, scope: path }], description: '' };
  }

  if (path !== undefined) {
    return { blocks: [{ type: 'file_op', operation: inferFileOp(toolName), path, detail }], description: '' };
  }

  const text = detail ?? title;
  return { blocks: text === undefined ? [] : [{ type: 'brief', text }], description: title ?? '' };
}

function inferFileOp(toolName: string): 'read' | 'write' | 'edit' | 'glob' | 'grep' {
  const lower = toolName.toLowerCase();
  if (lower.includes('glob')) return 'glob';
  if (lower.includes('grep')) return 'grep';
  if (lower.includes('edit')) return 'edit';
  if (lower.includes('write')) return 'write';
  return 'read';
}

export function adaptPanelResponse(response: ApprovalPanelResponse): ApprovalResponse {
  if (response.response === 'approved_for_session') {
    return { decision: 'approved', scope: 'session', feedback: response.feedback };
  }
  return {
    decision: response.response === 'approved' ? 'approved' : response.response === 'rejected' ? 'rejected' : 'cancelled',
    // A plan review's chosen option (a plan approach, or "Revise") rides the feedback text: the
    // engine's `ApprovalResponse` has no selected-label slot of its own.
    feedback: response.feedback ?? response.selected_label,
  };
}

const DANGER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)/i, label: 'recursive delete' },
  { pattern: /\bsudo\b/i, label: 'sudo' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, label: 'pipe to shell' },
  { pattern: /\bdd\b[^|]*\bof=/i, label: 'dd write' },
  { pattern: /\bmkfs\b/i, label: 'mkfs' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, label: 'write to raw device' },
  { pattern: /\bchmod\s+-R?\s*777\b/i, label: 'chmod 777' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/i, label: 'fork bomb' },
];

function detectDanger(command: string): string | undefined {
  for (const { pattern, label } of DANGER_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return undefined;
}

function adaptChoices(toolName: string, display: Record<string, unknown>): ApprovalPanelChoice[] {
  const kind = stringField(display, 'kind');
  if (toolName === 'ExitPlanMode' || kind === 'plan_review') return adaptPlanReviewChoices(display);
  if (kind === 'goal_start') return adaptGoalStartChoices(display);
  return DEFAULT_APPROVAL_CHOICES.map((choice) => ({ ...choice }));
}

function adaptGoalStartChoices(display: Record<string, unknown>): ApprovalPanelChoice[] {
  const mode = stringField(display, 'mode');
  return goalStartOptions(mode === 'yolo' ? 'yolo' : 'manual').map((option) =>
    option.value === 'cancel'
      ? { label: option.label, response: 'cancelled', selected_label: 'cancel', description: option.description }
      : { label: option.label, response: 'approved', selected_label: option.value, description: option.description },
  );
}

function adaptPlanReviewChoices(display: Record<string, unknown>): ApprovalPanelChoice[] {
  const rawOptions = display['options'];
  const options = Array.isArray(rawOptions)
    ? rawOptions
        .map((option) => asRecord(option))
        .map((option) => stringField(option, 'label'))
        .filter((label): label is string => label !== undefined)
    : [];
  const optionChoices =
    options.length >= 2
      ? options.map((label) => ({ label, response: 'approved' as const, selected_label: label }))
      : [{ label: 'Approve', response: 'approved' as const, selected_label: 'Approve' }];
  return [...optionChoices, ...PLAN_REJECT_CHOICES].map((choice) => ({ ...choice }));
}
