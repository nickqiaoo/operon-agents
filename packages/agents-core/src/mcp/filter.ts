import type { CapabilityContext } from "../index.ts";
import type { MCPTool } from "./types.ts";

export interface MCPToolFilterStatic {
  readonly allowedToolNames?: readonly string[];
  readonly blockedToolNames?: readonly string[];
}

export interface MCPToolFilterContext {
  readonly serverName: string;
  readonly ctx: CapabilityContext;
}

export type MCPToolFilterCallable = (context: MCPToolFilterContext, tool: MCPTool) => boolean | Promise<boolean>;

export type MCPToolFilter = MCPToolFilterStatic | MCPToolFilterCallable;

export function createMCPToolStaticFilter(options?: {
  allowed?: readonly string[];
  blocked?: readonly string[];
}): MCPToolFilterStatic | undefined {
  if (!options?.allowed && !options?.blocked) return undefined;
  const filter: { allowedToolNames?: readonly string[]; blockedToolNames?: readonly string[] } = {};
  if (options.allowed) filter.allowedToolNames = options.allowed;
  if (options.blocked) filter.blockedToolNames = options.blocked;
  return filter;
}

function isCallable(filter: MCPToolFilter): filter is MCPToolFilterCallable {
  return typeof filter === "function";
}

export async function applyMcpToolFilter(
  filter: MCPToolFilter | undefined,
  tools: readonly MCPTool[],
  context: MCPToolFilterContext,
): Promise<MCPTool[]> {
  if (filter === undefined) return [...tools];

  if (isCallable(filter)) {
    const out: MCPTool[] = [];
    for (const tool of tools) {
      if (await filter(context, tool)) out.push(tool);
    }
    return out;
  }

  const allowed = filter.allowedToolNames;
  const blocked = filter.blockedToolNames;
  return tools.filter((tool) => {
    if (allowed && !allowed.includes(tool.name)) return false;
    if (blocked && blocked.includes(tool.name)) return false;
    return true;
  });
}
