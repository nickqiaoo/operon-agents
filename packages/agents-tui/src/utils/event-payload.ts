import type { Message, TextContent, ImageContent } from 'operon-agents';

import { STREAMING_ARGS_FIELD_RE, STREAMING_ARGS_PREVIEW_MAX_CHARS } from '../constant/streaming.ts';

export function appendStreamingArgsPreview(current: string | undefined, next: string | null | undefined): string {
  const existing = (current ?? '').slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  if (next === null || next === undefined || next.length === 0) return existing;
  const remaining = STREAMING_ARGS_PREVIEW_MAX_CHARS - existing.length;
  if (remaining <= 0) return existing;
  return `${existing}${next.slice(0, remaining)}`;
}

function unescapeJsonString(s: string): string {
  return s.replaceAll(/\\(["\\/bfnrt])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return ch;
    }
  });
}

export function parseStreamingArgs(argumentsText: string): Record<string, unknown> {
  const previewText = argumentsText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  if (previewText.trim().length === 0) return {};
  if (argumentsText.length <= STREAMING_ARGS_PREVIEW_MAX_CHARS && previewText.trimEnd().endsWith('}')) {
    try {
      const parsed = JSON.parse(previewText) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to partial scan
    }
  }
  const result: Record<string, unknown> = {};
  for (const match of previewText.matchAll(STREAMING_ARGS_FIELD_RE)) {
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    if (!(key in result)) result[key] = unescapeJsonString(rawValue);
  }
  return result;
}

export function argsRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** Text view of a tool result's content parts: text verbatim, an image as a placeholder. */
export function toolResultText(content: readonly (TextContent | ImageContent)[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : `[image ${part.mimeType}]`)).join('');
}

export function serializeToolResultOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return toolResultText(output as (TextContent | ImageContent)[]);
  return JSON.stringify(output, null, 2);
}

/** Text of a user message, whether it was a plain string or content parts. */
export function userMessageText(message: Extract<Message, { role: 'user' }>): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : `[image ${part.mimeType}]`)).join('');
}

export function isTodoItemShape(value: unknown): value is { title: string; status: 'pending' | 'in_progress' | 'done' } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as { title?: unknown; status?: unknown };
  if (typeof rec.title !== 'string' || rec.title.length === 0) return false;
  return rec.status === 'pending' || rec.status === 'in_progress' || rec.status === 'done';
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
