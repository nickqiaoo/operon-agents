import { ToolAccesses, type CapabilityContext, type Tool, type ToolPlan, type ToolResult } from "../index.ts";
import type { MCPServer } from "./server.ts";
import { applyMcpToolFilter } from "./filter.ts";
import type { ToolProvider } from "../index.ts";
import { qualifyMcpToolName } from "./tool-naming.ts";
import { mcpResultToContent } from "./output.ts";
import type { MCPTool } from "./types.ts";

function asArgs(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

async function defaultErrorText(server: MCPServer, toolName: string, error: unknown): Promise<string> {
  if (server.errorFunction === null) throw error;
  if (server.errorFunction) return server.errorFunction({ error, toolName, serverName: server.name });
  return `MCP tool "${toolName}" on server "${server.name}" failed: ${error instanceof Error ? error.message : String(error)}`;
}

export function wrapMcpTool(server: MCPServer, def: MCPTool): Tool {
  const qualifiedName = qualifyMcpToolName(server.name, def.name);
  const rawName = def.name;
  return {
    schema: {
      name: qualifiedName,
      description: def.description ?? `MCP tool "${rawName}" from server "${server.name}".`,
      parameters: (def.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
    resolve: (rawArgs): ToolPlan => {
      const args = asArgs(rawArgs);
      return {
        approvalRule: qualifiedName,
        // MCP side effects are opaque → serialize against everything (conservative).
        accesses: ToolAccesses.all(),
        display: { kind: "mcp_call", title: qualifiedName, detail: def.description },
        run: async (ctx): Promise<ToolResult> => {
          try {
            const result = await server.callTool(rawName, args, { signal: ctx.signal });
            const { content, isError } = mcpResultToContent(result, qualifiedName);
            return { content, isError };
          } catch (error) {
            const text = await defaultErrorText(server, rawName, error);
            return { content: [{ type: "text", text }], isError: true };
          }
        },
      };
    },
  };
}

export function mcpToolProvider(server: MCPServer): ToolProvider {
  return {
    id: `mcp:${server.name}`,
    listTools: async (ctx: CapabilityContext): Promise<readonly Tool[]> => {
      const raw = await server.listTools();
      const filtered = await applyMcpToolFilter(server.toolFilter, raw, { serverName: server.name, ctx });
      return filtered.map((def) => wrapMcpTool(server, def));
    },
  };
}
