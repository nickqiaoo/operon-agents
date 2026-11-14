// A stdio MCP server that reports what a workspace-aware server sees of its client: whether the
// client declared `roots`, what `roots/list` answers, and the cwd it was started in.
// Spawned by e2e-mcp-roots.ts.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "roots-probe", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  const declared = server.getClientCapabilities()?.roots !== undefined;
  let roots: unknown = null;
  let rootsError: string | null = null;
  try {
    roots = (await server.listRoots()).roots;
  } catch (error) {
    rootsError = error instanceof Error ? error.message : String(error);
  }
  const report = { declared, roots, rootsError, cwd: process.cwd() };
  return { content: [{ type: "text" as const, text: JSON.stringify(report) }] };
});

await server.connect(new StdioServerTransport());
