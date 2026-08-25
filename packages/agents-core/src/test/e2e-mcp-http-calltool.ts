// A tool call over a real streamable-HTTP MCP server must survive the server's JSON-RPC schema
// validation. Regression: we used to send `arguments: null` / `_meta: null`, but both fields are
// `.optional()` (not nullable) in the MCP schemas, so a real server rejected every tools/call with
// `-32700 Parse error: Invalid JSON-RPC message` before the tool ran. A mock transport cannot
// catch this — only a server that actually parses the wire message can.
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mcpStreamableHttpTransport } from "../mcp/sdk-transport.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new Server({ name: "node_repl", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "js", inputSchema: { type: "object", properties: { code: { type: "string" } } } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text" as const, text: `args=${JSON.stringify(req.params.arguments ?? null)}` }],
  }));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const http: HttpServer = createServer((req, res) => {
    transport.handleRequest(req, res).catch((error) => {
      console.error("server handleRequest error:", error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await server.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function textOf(result: { content?: readonly unknown[] }): string {
  const first = result.content?.[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" ? (first.text ?? "") : "";
}

async function main(): Promise<void> {
  const server = await startServer();
  const transport = mcpStreamableHttpTransport({ name: "node_repl", url: server.url });
  try {
    await transport.connect();
    const tools = await transport.listTools();
    check("listTools reaches the http server", tools.length === 1 && tools[0]!.name === "js");

    const withArgs = await transport.callTool("js", { code: "1+1" });
    check("callTool with arguments is not rejected as a parse error", withArgs.isError !== true);
    check("server received the arguments verbatim", textOf(withArgs) === 'args={"code":"1+1"}');

    // `null` args must be omitted from the wire message, not sent as an explicit null.
    const noArgs = await transport.callTool("js", null);
    check("callTool with null arguments is not rejected as a parse error", noArgs.isError !== true);
    check("server saw no arguments rather than a null", textOf(noArgs) === "args=null");

    const withMeta = await transport.callTool("js", { code: "2" }, { meta: { progressToken: "t" } });
    check("callTool forwards a real _meta", withMeta.isError !== true);
  } finally {
    await transport.close();
    await server.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ MCP-HTTP-CALLTOOL E2E FAIL");
    process.exit(1);
  }
  console.log("✅ MCP-HTTP-CALLTOOL E2E PASS — tools/call passes server-side JSON-RPC validation");
}

main().catch((error) => {
  console.error("❌ MCP-HTTP-CALLTOOL E2E ERROR:", error);
  process.exit(1);
});
