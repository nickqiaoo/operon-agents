import type { AgentRecord, Message, ToolCall } from 'operon-agents';

import { toolResultText, userMessageText } from './event-payload.ts';

export interface BuildExportMarkdownInput {
  readonly sessionId: string;
  readonly title: string | null;
  readonly workDir: string;
  readonly model: string;
  readonly records: readonly AgentRecord[];
}

const MAX_TOOL_OUTPUT_CHARS = 4000;

/** A short, single-line hint of what a tool call is about, for its heading. */
export function toolCallHint(toolCall: ToolCall): string {
  const args = toolCall.arguments;
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return collapse(value, 100);
  }
  return '';
}

function collapse(value: string, max: number): string {
  const oneLine = value.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function fence(body: string, lang = ''): string {
  const trimmed = body.trimEnd();
  const capped = trimmed.length > MAX_TOOL_OUTPUT_CHARS ? `${trimmed.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… [truncated]` : trimmed;
  return `\`\`\`${lang}\n${capped}\n\`\`\``;
}

function formatMessage(message: Message): string[] {
  switch (message.role) {
    case 'user':
      return ['## User', '', userMessageText(message).trim(), ''];
    case 'assistant': {
      const out: string[] = [];
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim();
      if (text.length > 0) out.push('## Assistant', '', text, '');
      for (const part of message.content) {
        if (part.type !== 'toolCall') continue;
        const hint = toolCallHint(part);
        out.push(`### ${part.name}${hint.length > 0 ? `: ${hint}` : ''}`, '', fence(JSON.stringify(part.arguments, null, 2), 'json'), '');
      }
      return out;
    }
    case 'toolResult':
      return [`#### ${message.toolName} result${message.isError ? ' (error)' : ''}`, '', fence(toolResultText(message.content)), ''];
    case 'system':
      // Request-only: tool declarations the loop projects for pi, never journaled.
      return [];
  }
}

/** Render a session's journal as a Markdown document. */
export function buildExportMarkdown(input: BuildExportMarkdownInput): string {
  const lines: string[] = [
    `# ${input.title ?? `Session ${input.sessionId}`}`,
    '',
    `- Session: \`${input.sessionId}\``,
    `- Workspace: \`${input.workDir}\``,
    `- Model: \`${input.model}\``,
    `- Exported: ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ];
  for (const record of input.records) {
    if (record.type === 'context.apply_compaction') {
      lines.push('## Compaction', '', record.summary.trim(), '');
      continue;
    }
    if (record.type !== 'context.append_message') continue;
    const origin = record.origin?.kind;
    // Framing the model saw but the user never wrote stays out of the export.
    if (origin === 'injection' || origin === 'compaction_summary' || origin === 'tool_catalog_delta') continue;
    lines.push(...formatMessage(record.message));
  }
  return lines.join('\n');
}
