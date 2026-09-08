import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

export const DEFERRED_TOOL_PLACEHOLDER = "OperonDeferredToolPlaceholder";
const placeholder = {
  name: DEFERRED_TOOL_PLACEHOLDER,
  description: "Reserved placeholder that keeps deferred tool loading active. Never call this tool.",
  input_schema: { type: "object", properties: {} },
  defer_loading: true,
};

/** pi has no option to keep Anthropic's deferred-mode hint present before the first
 * search. Add only that inert marker at its public payload seam; leave native tool
 * loading and history serialization to pi. Keep it after real tools disconnect too. */
export function withAnthropicDeferredMode(options: ModelsSimpleStreamOptions): ModelsSimpleStreamOptions {
  const inspect = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let next = payload;
      if (payload !== null && typeof payload === "object" && "tools" in payload && Array.isArray(payload.tools)) {
        if (payload.tools.some((tool: unknown) => tool !== null && typeof tool === "object" && "name" in tool && tool.name === DEFERRED_TOOL_PLACEHOLDER)) {
          throw new Error(`Reserved deferred tool name: ${DEFERRED_TOOL_PLACEHOLDER}`);
        }
        next = { ...payload, tools: [...payload.tools, structuredClone(placeholder)] };
      }
      return (await inspect?.(next, model)) ?? next;
    },
  };
}
