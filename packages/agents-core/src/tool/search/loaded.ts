import type { Message } from "../../protocol/index.ts";
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
    let entries: readonly LoadedToolSchema[] = [];
    if (message.role === "user") {
      const origin = history.originOf(message);
      if (origin?.kind === "compaction_summary" && origin.loadedTools !== undefined) {
        entries = origin.loadedTools.filter(isLoadedSchema);
      }
    } else if (message.role === "toolResult" && message.toolName === SEARCH_TOOL_NAME && !message.isError) {
      const details = message.details as { deferredToolSchemas?: unknown } | undefined;
      if (Array.isArray(details?.deferredToolSchemas)) {
        const selected = new Set(message.addedToolNames ?? []);
        entries = details.deferredToolSchemas.filter(isLoadedSchema).filter((entry) => selected.has(entry.schema.name));
      }
    }
    for (const entry of entries) if (!loaded.has(entry.schema.name)) loaded.set(entry.schema.name, entry);
  }
  return loaded;
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
