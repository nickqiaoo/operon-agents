import type { Message, PiTool, SystemMessage } from "../../protocol/index.ts";
import type { LoadedToolSchema, PromptOrigin } from "../../store/origin.ts";
import { SEARCH_TOOL_NAME } from "./deferral.ts";

/** The slice of a conversation `loadedToolSchemas` reads: `ConversationContext` fits as is. */
export interface HistoryView {
  readonly messages: readonly Message[];
  originOf(message: Message): PromptOrigin | undefined;
}

export function isLoadedSchema(value: unknown): value is LoadedToolSchema {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<LoadedToolSchema>;
  return typeof entry.sourceName === "string" && typeof entry.schema?.name === "string"
    && typeof entry.schema.description === "string" && entry.schema.parameters !== null
    && typeof entry.schema.parameters === "object";
}

/**
 * Deferred-tool definitions this history holds, by wire name. Derived only from surviving
 * structured records — a SearchTool load point, or a compaction summary carrying the
 * definitions its removed prefix had loaded for calls the kept tail still makes — so full
 * compaction releases a load nothing after it depends on. First record wins.
 */
export function loadedToolSchemas(history: HistoryView): Map<string, LoadedToolSchema> {
  const loaded = new Map<string, LoadedToolSchema>();
  for (const message of history.messages) {
    for (const entry of loadPointEntries(history, message)) if (!loaded.has(entry.schema.name)) loaded.set(entry.schema.name, entry);
  }
  return loaded;
}

/** The definitions `message` records as loaded, if it is a load point. */
function loadPointEntries(history: HistoryView, message: Message): readonly LoadedToolSchema[] {
  if (message.role === "user") {
    const origin = history.originOf(message);
    return origin?.kind === "compaction_summary" && origin.loadedTools !== undefined ? origin.loadedTools.filter(isLoadedSchema) : [];
  }
  if (message.role === "toolResult" && message.toolName === SEARCH_TOOL_NAME && !message.isError) {
    const details = message.details as { deferredToolSchemas?: unknown } | undefined;
    return Array.isArray(details?.deferredToolSchemas) ? details.deferredToolSchemas.filter(isLoadedSchema) : [];
  }
  return [];
}

/**
 * The history as pi should see it: every load point followed by a system message whose
 * `toolsAdded` declares the definitions it loaded, so pi anchors them there (Anthropic
 * `tool_addition`, Responses `additional_tools` / client tool search, Kimi `tools` system
 * messages) instead of rewriting the top-level tool list. `declared` names the request's
 * top-level tools; a name is declared once, at its first surviving load point, which keeps
 * the projection of an unchanged prefix byte-identical as history grows. The declaration
 * lands after the load point's whole tool-result batch, since results must stay contiguous.
 */
export function withToolLoads(history: HistoryView, declared: ReadonlySet<string>): Message[] {
  const seen = new Set(declared);
  const out: Message[] = [];
  let pending: SystemMessage | undefined;
  const flush = (): void => {
    if (pending !== undefined) out.push(pending);
    pending = undefined;
  };
  for (const message of history.messages) {
    if (message.role !== "toolResult") flush();
    out.push(message);
    const fresh = loadPointEntries(history, message).filter((entry) => !seen.has(entry.schema.name));
    if (fresh.length === 0) continue;
    for (const entry of fresh) seen.add(entry.schema.name);
    pending ??= { role: "system", content: "", toolsAdded: [], timestamp: message.timestamp };
    pending.toolsAdded!.push(...fresh.map((entry) => toPiTool(entry.schema)));
  }
  flush();
  return out;
}

function toPiTool(schema: LoadedToolSchema["schema"]): PiTool {
  // Protocol-level parameters are a JSON Schema object; pi serializes it as the tool schema.
  return { name: schema.name, description: schema.description, parameters: schema.parameters as unknown as PiTool["parameters"] };
}

/**
 * What a compaction summary must carry: definitions loaded in the prefix being removed that
 * assistant messages in the kept tail still call. Anything else is released — the model is
 * re-told to search, and the definition reloads through a fresh load point.
 */
export function loadedToolsForCompaction(history: HistoryView, cutoff: number): LoadedToolSchema[] {
  const removed = history.messages.slice(0, cutoff);
  if (removed.length === 0) return [];
  const loaded = loadedToolSchemas({ messages: removed, originOf: (message) => history.originOf(message) });
  if (loaded.size === 0) return [];
  const called = new Set<string>();
  for (const message of history.messages.slice(cutoff)) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) if (block.type === "toolCall") called.add(block.name);
  }
  return [...loaded.values()].filter((entry) => called.has(entry.schema.name)).map((entry) => structuredClone(entry));
}
