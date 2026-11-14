import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../../protocol/index.ts";
import type { Tool } from "../../tool/types.ts";
import { permissionDenialOf } from "../denial.ts";

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

/** Keys the transcript format gives a meaning of its own. A tool that happens to bear one is
 *  printed bracketed, so `{"user": …}` can only ever be a real user turn. */
const RESERVED_KEYS = new Set(["user", "assistant", "outcome", "id", "meta", "tool_result", "omitted"]);

export function transcriptKey(toolName: string): string {
  return RESERVED_KEYS.has(toolName.trim().toLowerCase()) ? `[${toolName}]` : toolName;
}

/** The short id a call and its outcome line share (the tail of the provider's call id). */
export function shortCallId(id: string): string {
  return id.slice(-6).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** One JSONL line. JSON-encoding keeps hostile content inside its string (a newline becomes
 *  `\n`, so it can't open a forged line); U+2028/2029/0085 are escaped too, since some readers
 *  treat them as line breaks that JSON.stringify leaves raw. */
function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value).replace(/[\u2028\u2029\u0085]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

/** The JSONL line for a tool call — `{"<name>": <projection>, "id": "<short id>"}` — or `""` when
 *  the tool declares no security relevance. */
export function serializeToolCall(name: string, args: unknown, tool: Tool | undefined, lookup: ToolLookup, id?: string): string {
  const projected = projectToolCall(name, args, tool, lookup);
  if (projected === "") return "";
  return serializeProjectedCall(name, projected, id);
}

export function serializeProjectedCall(name: string, projected: unknown, id?: string): string {
  return line({ [transcriptKey(name)]: projected, ...(id !== undefined ? { id: shortCallId(id) } : {}) });
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

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function resultText(message: ToolResultMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** The assistant prose a user reply answers — the proposal is usually at its end. */
const MAX_ASSISTANT_CHARS = 3_000;

function clipTail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/** The user's picks from an AskUserQuestion result, or undefined when nothing was answered. */
function askUserAnswer(message: ToolResultMessage): string | undefined {
  if (message.isError) return undefined;
  const text = resultText(message);
  try {
    const parsed = JSON.parse(text) as { answers?: unknown };
    const answers = parsed.answers;
    if (typeof answers !== "object" || answers === null || Object.keys(answers).length === 0) return undefined;
    return JSON.stringify(answers);
  } catch {
    return undefined;
  }
}

function outcomeOf(message: ToolResultMessage): string {
  return permissionDenialOf(message.details) ?? (message.isError ? "error" : "ok");
}

/**
 * Build the compact transcript the classifier reads as context, one JSONL line per entry:
 *
 * - `{"user": …}` — the user's own text.
 * - `{"assistant": …}` — the agent's latest prose before a user message: what a terse "yes" in
 *   that message is replying to. Only prose a user then answered is included; the agent's narration
 *   since the last user message (the part that sits next to the action under review) never is.
 * - `{"<tool>": <projection>, "id": …}` — the agent's tool calls, projected.
 * - `{"outcome": "ok|error|rejected-by-user|blocked-by-permissions|automode-blocked|automode-unavailable", "id": …}`
 *   — how each earlier call ended. Tool result *content* stays out: it is where injected text lives.
 * - `{"user": "[User answered AskUserQuestion]: …"}` — the user's picks, which are user intent.
 *
 * `excludeToolCallId` drops the action under review (the caller appends it as the final entry).
 */
export function buildTranscriptText(
  messages: readonly Message[],
  lookup: ToolLookup,
  excludeToolCallId?: string,
): string {
  let out = "";
  let pendingAssistant: string | undefined;
  const emitted = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const text = userText(message);
      if (text.length === 0) continue;
      if (pendingAssistant !== undefined) out += line({ assistant: clipTail(pendingAssistant, MAX_ASSISTANT_CHARS) });
      pendingAssistant = undefined;
      out += line({ user: text });
    } else if (message.role === "assistant") {
      const prose = assistantText(message);
      if (prose.length > 0) pendingAssistant = prose;
      for (const call of toolCalls(message)) {
        if (call.id === excludeToolCallId) continue;
        const serialized = serializeToolCall(call.name, call.arguments, undefined, lookup, call.id);
        if (serialized === "") continue;
        out += serialized;
        emitted.add(call.id);
      }
    } else if (message.role === "toolResult") {
      if (!emitted.has(message.toolCallId)) continue;
      out += line({ outcome: outcomeOf(message), id: shortCallId(message.toolCallId) });
      if (message.toolName === "AskUserQuestion") {
        const answer = askUserAnswer(message);
        if (answer !== undefined) out += line({ user: `[User answered AskUserQuestion]: ${answer}` });
      }
    }
  }
  return out;
}
