import type { Message } from "../../protocol/index.ts";
import type { Tool } from "../types.ts";

/**
 * Project a complete execution registry to the tools currently available to
 * the model. A load point is structural transcript state, not summary text:
 *
 * - `addedToolNames` activates newly searched tools.
 * - a surviving assistant tool call keeps an already-used tool immediate.
 * - full compaction unloads evidence removed with the compacted prefix.
 * - micro compaction keeps these fields while replacing only result content.
 *
 * `prepareToolCatalog` (catalog.ts) does not use this projection: it activates a catalog tool
 * only from recorded definitions (a SearchTool load point or a snapshot-carrying call), so a
 * guessed call to a never-loaded name is not evidence. This stays as the origin-free view.
 */
export function activeDeferredTools(
  tools: readonly Tool[],
  deferredToolNames: ReadonlySet<string>,
  messages: readonly Message[],
): Tool[] {
  if (deferredToolNames.size === 0) return [...tools];

  const activeDeferred = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall" && deferredToolNames.has(part.name)) {
          activeDeferred.add(part.name);
        }
      }
    } else if (message.role === "toolResult") {
      for (const name of message.addedToolNames ?? []) {
        if (deferredToolNames.has(name)) activeDeferred.add(name);
      }
    }
  }

  return tools.filter(
    (tool) => !deferredToolNames.has(tool.schema.name) || activeDeferred.has(tool.schema.name),
  );
}
