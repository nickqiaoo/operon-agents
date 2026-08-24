import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMachine } from "../index.ts";
import {
  loadProjectMcpServers,
  TransportMCPServer,
  type MCPTransport,
  type MCPTool,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from "../mcp/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function testLoader(machine: LocalMachine): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-mcp-proj-"));
  mkdirSync(join(root, ".git"));
  const sub = join(root, "packages", "x");
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(root, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fs: { command: "base-fs" },
        base: { type: "http", url: "https://base.example.com/mcp", keepAliveIntervalMs: 1000 },
      },
    }),
  );
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        fs: { command: "mcp-fs", args: ["--root", "."], cwd: "data" },
        api: { transport: "http", url: "https://mcp.example.com/sse", bearerTokenEnvVar: "API_TOKEN" },
      },
    }),
  );

  // Loaded from a nested cwd → still finds the project root via `.git`.
  const servers = await loadProjectMcpServers(machine, sub);
  check("loader: servers loaded from project-root mcp.json + .mcp.json", Object.keys(servers).sort().join(",") === "api,base,fs");
  check("loader: .mcp.json overrides same-named mcp.json servers", servers["fs"]?.command === "mcp-fs");
  check("loader: `type` alias normalised to transport", servers["base"]?.transport === "http" && servers["base"]?.keepAliveIntervalMs === 1000);
  check("loader: stdio transport defaulted", servers["fs"]?.transport === "stdio");
  check("loader: stdio cwd normalised to <root>/data", servers["fs"]?.cwd === join(root, "data"));
  check("loader: http fields preserved", servers["api"]?.transport === "http" && servers["api"]?.bearerTokenEnvVar === "API_TOKEN");

  const empty = await loadProjectMcpServers(machine, mkdtempSync(join(tmpdir(), "af-mcp-none-")));
  check("loader: missing .mcp.json → {}", Object.keys(empty).length === 0);
}

class HangingTransport implements MCPTransport {
  readonly name = "hang";
  async connect(): Promise<void> {
    await new Promise<void>(() => {}); // never resolves
  }
  async close(): Promise<void> {}
  async listTools(): Promise<readonly MCPTool[]> {
    return [];
  }
  async callTool(): Promise<{ content: [] }> {
    return { content: [] };
  }
}

async function testTimeout(): Promise<void> {
  const server = new TransportMCPServer({ name: "hang", transport: new HangingTransport(), startupTimeoutMs: 50 });
  const started = Date.now();
  let message = "";
  try {
    await server.connect();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  const elapsed = Date.now() - started;
  check("timeout: hung connect rejects with a timeout message", message.includes("timed out after 50ms"));
  check("timeout: failed fast (< 2s)", elapsed < 2000);
  check("timeout: server left disconnected", server.connected === false);
}

class ClosableTransport implements MCPTransport {
  readonly name = "closable";
  private listener: UnexpectedCloseListener | undefined;
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async listTools(): Promise<readonly MCPTool[]> {
    return [{ name: "t", inputSchema: { type: "object" } }];
  }
  async callTool(): Promise<{ content: [] }> {
    return { content: [] };
  }
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.listener = listener;
  }
  fireDrop(reason: UnexpectedCloseReason): void {
    this.listener?.(reason);
  }
}

async function testUnexpectedClose(): Promise<void> {
  const transport = new ClosableTransport();
  const server = new TransportMCPServer({ name: "closable", transport, cacheToolsList: true });
  await server.connect();
  await server.listTools(); // warm the cache

  let received: UnexpectedCloseReason | undefined;
  server.onUnexpectedClose?.((reason) => {
    received = reason;
  });

  transport.fireDrop({ error: new Error("boom"), stderr: "kaboom" });

  check("drop: server flips to disconnected", server.connected === false);
  check("drop: subscriber got the reason (error + stderr)", received?.error?.message === "boom" && received?.stderr === "kaboom");

  let threw = false;
  try {
    await server.listTools();
  } catch {
    threw = true;
  }
  check("drop: listTools throws after a drop (tools absent)", threw);
}

async function main(): Promise<void> {
  const machine = new LocalMachine(process.cwd());
  await testLoader(machine);
  await testTimeout();
  await testUnexpectedClose();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP RUNTIME E2E PASS — loader + timeout + unexpected-close");
  } else {
    console.log("❌ MCP RUNTIME E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MCP RUNTIME E2E ERROR:", error);
  process.exit(1);
});
