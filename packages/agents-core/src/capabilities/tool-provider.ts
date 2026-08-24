import type { Tool } from "../tool/types.ts";
import type { CapabilityContext } from "./capability.ts";

export interface ToolProvider {
  readonly id: string;
  listTools(ctx: CapabilityContext): Promise<readonly Tool[]> | readonly Tool[];
  start?(ctx: CapabilityContext): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export function staticToolProvider(id: string, tools: readonly Tool[]): ToolProvider {
  return { id, listTools: () => tools };
}

/**
 * Provenance for dynamically contributed tools, kept off the `Tool` itself so the tool shape
 * stays a plain value. Toolset assembly reads it to name the culprit when a contributed tool
 * collides with one the agent already owns — without that, a provider's tool would either
 * silently lose or silently win.
 *
 * Tagging is optional: an untagged tool is treated as trusted (agent-owned or first-party) and
 * keeps its name.
 */
const toolSources = new WeakMap<Tool, string>();

export function tagToolSource(tool: Tool, source: string): void {
  toolSources.set(tool, source);
}

export function toolSource(tool: Tool): string | undefined {
  return toolSources.get(tool);
}
