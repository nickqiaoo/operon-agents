import { testRunner, openTestSession } from "./faux.ts";
// The MCP capability is reachable through ergonomic Session methods (listMcpServers /
// reconnectMcpServer), not only the raw capability service. With no MCP capability open, listing
// is empty and reconnect is a clear error.
import { ListenerSink, LocalMachine, Session } from "../index.ts";
import { mcpServersCapability, MockMCPTransport } from "../mcp/index.ts";
import type { McpTransportFactory } from "../mcp/index.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function okTransport(name: string): MockMCPTransport {
  return new MockMCPTransport({
    name,
    tools: [{ name: "echo", inputSchema: { type: "object" } }],
    call: async () => ({ content: [{ type: "text", text: "hi" }] }),
  });
}

async function main(): Promise<void> {
  const machine = new LocalMachine(process.cwd());

  // ── with an MCP capability open ──
  {
    const factory: McpTransportFactory = (name) => okTransport(name);
    const cap = mcpServersCapability({ good: { transport: "http", url: "http://good.example" } }, { transportFactory: factory });
    const session = await openTestSession({ machine, events: new ListenerSink(), capabilities: [cap] });
    try {
      const servers = session.listMcpServers();
      check("session.listMcpServers returns the connected server", servers.length === 1 && servers[0]!.name === "good" && servers[0]!.status === "connected");

      await session.reconnectMcpServer("good");
      check("session.reconnectMcpServer succeeds + stays connected", session.listMcpServers()[0]!.status === "connected");

      let threw = false;
      try {
        await session.reconnectMcpServer("nope");
      } catch {
        threw = true;
      }
      check("session.reconnectMcpServer rejects an unknown server", threw);
    } finally {
      await session.close();
    }
  }

  // ── with no MCP capability ──
  {
    const session = await openTestSession({ machine });
    try {
      check("session.listMcpServers is empty when no MCP capability is open", session.listMcpServers().length === 0);
      let threw = false;
      try {
        await session.reconnectMcpServer("good");
      } catch {
        threw = true;
      }
      check("session.reconnectMcpServer errors when no MCP capability is open", threw);
    } finally {
      await session.close();
    }
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ MCP-SESSION E2E FAIL");
    process.exit(1);
  }
  console.log("✅ MCP-SESSION E2E PASS — listMcpServers + reconnectMcpServer surfaced on Session");
}

main().catch((error) => {
  console.error("❌ MCP-SESSION E2E ERROR:", error);
  process.exit(1);
});
