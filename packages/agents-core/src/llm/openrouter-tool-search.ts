import type { Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Api } from "../protocol/index.ts";

/**
 * OpenRouter's server-side tool search. Every deferred function tool is sent with
 * `defer_loading: true` next to `{ type: "openrouter:tool_search" }`; OpenRouter withholds
 * those definitions from the upstream prompt and lets the model regex-search them, on any
 * model. Measured on deepseek-v4-flash (2026-09-29): 31 tools 14.8k → 6.1k input tokens,
 * and adding a deferred tool mid-conversation keeps the cached prefix. What the search
 * revealed need not be replayed: a stripped history still calls the discovered tool.
 *
 * Responses API only — OpenRouter rejects it on Chat Completions (400), and its Messages
 * API is reached here only by Claude models, which take the native `tool_addition` path.
 */
export const OPENROUTER_TOOL_SEARCH = "openrouter:tool_search";

export function supportsOpenRouterToolSearch(model: Model<Api>): boolean {
  return model.api === "openai-responses" && isOpenRouter(model.baseUrl);
}

function isOpenRouter(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/** Mark `deferred` function tools and add the search tool at pi's public payload seam. */
export function withOpenRouterToolSearch(
  options: ModelsSimpleStreamOptions,
  deferred: ReadonlySet<string>,
): ModelsSimpleStreamOptions {
  const inspect = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let next = payload;
      if (payload !== null && typeof payload === "object" && "tools" in payload && Array.isArray(payload.tools)) {
        let marked = false;
        const tools = payload.tools.map((tool: unknown) => {
          if (tool === null || typeof tool !== "object" || !("name" in tool) || typeof tool.name !== "string") return tool;
          if (!deferred.has(tool.name)) return tool;
          marked = true;
          return { ...tool, defer_loading: true };
        });
        // OpenRouter rejects a deferred tool without the search tool, and the search tool
        // with nothing to search is only noise.
        if (marked) next = { ...payload, tools: [{ type: OPENROUTER_TOOL_SEARCH }, ...tools] };
      }
      return (await inspect?.(next, model)) ?? next;
    },
  };
}
