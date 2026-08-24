import type { Message, QuestionItem, ToolResult } from "operon-agents";

export function jsonPreview(value: unknown, maxLength = 180): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  text = text.replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "image") return `[image: ${part.mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function toolResultText(result: ToolResult, maxLength = 600): string {
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
    .join("\n")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function isQuestionDisplay(value: unknown): value is { readonly questions: readonly QuestionItem[] } {
  if (typeof value !== "object" || value === null || !("questions" in value)) return false;
  const questions = (value as { readonly questions?: unknown }).questions;
  return Array.isArray(questions) && questions.every(isQuestionItem);
}

function isQuestionItem(value: unknown): value is QuestionItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<QuestionItem>;
  return (
    typeof item.question === "string" &&
    typeof item.header === "string" &&
    typeof item.multiSelect === "boolean" &&
    Array.isArray(item.options)
  );
}

export interface ParsedSlashCommand {
  readonly name: string;
  readonly args: string;
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (!input.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (match === null) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}
