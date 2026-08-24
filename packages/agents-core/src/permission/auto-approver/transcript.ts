import type { AssistantMessage, Message, ToolCall } from "../../protocol/index.ts";
import type { Tool } from "../../tool/types.ts";

export type ToolLookup = ReadonlyMap<string, Tool>;

export function buildToolLookup(tools: readonly Tool[] | undefined): ToolLookup {
  const map = new Map<string, Tool>();
  for (const tool of tools ?? []) map.set(tool.schema.name, tool);
  return map;
}

/**
 * Project a tool call to its compact, security-relevant form. Uses the tool's
 * `toAutoApprovalInput` when available; on a throw (history args may be malformed) or when the
 * tool is unknown, falls back to the raw arguments object. Returns `""` when the tool declares
 * no security relevance (caller skips the block / allows the action).
 */
export function projectToolCall(name: string, args: unknown, tool: Tool | undefined, lookup: ToolLookup): unknown {
  const resolved = tool ?? lookup.get(name);
  const project = resolved?.toAutoApprovalInput?.bind(resolved);
  if (project === undefined) return args ?? {};
  try {
    const out = project(args ?? {});
    return out ?? args ?? {};
  } catch {
    return args ?? {};
  }
}

/** One JSONL transcript line: `{"<name>": <projection>}` for a call, or `""` to skip. */
export function serializeToolCall(name: string, args: unknown, tool: Tool | undefined, lookup: ToolLookup): string {
  const projected = projectToolCall(name, args, tool, lookup);
  if (projected === "") return "";
  // JSON-encode so hostile content can't break out of its string context to forge a
  // `{"user": ...}` line — newlines become `\n` inside the value.
  return `${JSON.stringify({ [name]: projected })}\n`;
}

function userText(message: Message): string {
  if (message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((c): c is ToolCall => c.type === "toolCall");
}

/**
 * Build the compact transcript string the classifier reads as context: user text plus the
 * agent's prior tool calls (projected), one JSONL line each. Assistant prose and tool results
 * are deliberately excluded — model-authored text could be crafted to steer the judge, and the
 * threat model only needs what the agent *did*, not what it said. `excludeToolCallId` drops the
 * action under review so it isn't duplicated (the caller appends it as the final action block).
 */
export function buildTranscriptText(
  messages: readonly Message[],
  lookup: ToolLookup,
  excludeToolCallId?: string,
): string {
  let out = "";
  for (const message of messages) {
    if (message.role === "user") {
      const text = userText(message);
      if (text.length > 0) out += `${JSON.stringify({ user: text })}\n`;
    } else if (message.role === "assistant") {
      for (const call of toolCalls(message)) {
        if (call.id === excludeToolCallId) continue;
        out += serializeToolCall(call.name, call.arguments, undefined, lookup);
      }
    }
    // toolResult messages are intentionally skipped.
  }
  return out;
}
