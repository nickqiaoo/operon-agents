import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMachine,
  ListenerSink,
  SteerBus,
  type AgentEvent,
  type SessionContext,
  type CapabilityContext,
  type Capability,
} from "../index.ts";
import {
  mcpServersCapability,
  MockMCPTransport,
  qualifyMcpToolName,
  type McpServersHandle,
  type McpTransportFactory,
  type MCPTransport,
  type MCPTool,
  McpOAuthService,
} from "../mcp/index.ts";
import type { McpServerConfig } from "../config/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

class FlakyTransport implements MCPTransport {
  readonly name: string;
  private readonly gate: () => boolean;
  private readonly tools: readonly MCPTool[];
  constructor(name: string, gate: () => boolean, tools: readonly MCPTool[]) {
    this.name = name;
    this.gate = gate;
    this.tools = tools;
  }
  async connect(): Promise<void> {
    if (!this.gate()) {
      const err = new Error("HTTP 401 Unauthorized");
      err.name = "UnauthorizedError";
      throw err;
    }
  }
  async close(): Promise<void> {}
  async listTools(): Promise<readonly MCPTool[]> {
    return this.tools;
  }
  async callTool(): Promise<{ content: { type: string; text: string }[] }> {
    return { content: [{ type: "text", text: "ok" }] };
  }
}

class DeadTransport implements MCPTransport {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async connect(): Promise<void> {
    throw new Error("connection refused");
  }
  async close(): Promise<void> {}
  async listTools(): Promise<readonly MCPTool[]> {
    return [];
  }
  async callTool(): Promise<{ content: [] }> {
    return { content: [] };
  }
}

function okTransport(name: string, tools: readonly MCPTool[]): MockMCPTransport {
  return new MockMCPTransport({
    name,
    tools: [...tools],
    call: async () => ({ content: [{ type: "text", text: "hi" }] }),
  });
}

function providerNames(cap: Capability, server: string, ctx: CapabilityContext): Promise<string[]> {
  const provider = (cap.toolProviders ?? []).find((p) => p.id === `mcp:${server}`);
  if (provider === undefined) return Promise.resolve([]);
  return Promise.resolve(provider.listTools(ctx)).then((tools) => tools.map((t) => t.schema.name));
}

async function main(): Promise<void> {
  const machine = new LocalMachine(process.cwd());
  const credentialsDir = mkdtempSync(join(tmpdir(), "af-mcp-mgr-"));
  const oauthService = new McpOAuthService({ homeDir: credentialsDir });

  let remoteAuthed = false;
  let goodBuilt = 0;
  let offBuilt = 0;

  const factory: McpTransportFactory = (name) => {
    if (name === "good") {
      goodBuilt += 1;
      return okTransport("good", [{ name: "echo", inputSchema: { type: "object" } }]);
    }
    if (name === "filtered") {
      return okTransport("filtered", [
        { name: "echo", inputSchema: { type: "object" } },
        { name: "danger", inputSchema: { type: "object" } },
      ]);
    }
    if (name === "remote") {
      return new FlakyTransport("remote", () => remoteAuthed, [{ name: "search", inputSchema: { type: "object" } }]);
    }
    if (name === "broken") return new DeadTransport("broken");
    if (name === "off") {
      offBuilt += 1;
      return okTransport("off", []);
    }
    throw new Error(`unexpected server ${name}`);
  };

  const configs: Record<string, McpServerConfig> = {
    good: { transport: "http", url: "http://good.example" },
    filtered: { transport: "http", url: "http://filtered.example", allowedTools: ["echo"] },
    remote: { transport: "http", url: "http://remote.example" },
    broken: { transport: "http", url: "http://broken.example" },
    off: { transport: "http", url: "http://off.example", enabled: false },
  };

  const cap = mcpServersCapability(configs, { oauthService, transportFactory: factory });

  const events = new ListenerSink();
  const warnings: string[] = [];
  events.subscribe((e: AgentEvent) => {
    if (e.type === "warning") warnings.push(e.message);
  });

  const sessionCtx: SessionContext = {
    sessionId: "s",
    machine,
    events,
    signal: new AbortController().signal,
    steer: new SteerBus(),
  };
  const capCtx: CapabilityContext = { sessionId: "s", machine, signal: new AbortController().signal };

  await cap.openSession?.(sessionCtx);

  const handle = cap.service as McpServersHandle;
  const status = (name: string): string => handle.list().find((v) => v.name === name)?.status ?? "missing";

  // 1. status machine
  check("status: healthy http server → connected", status("good") === "connected");
  check("status: enabled:false → disabled (transport never built)", status("off") === "disabled" && offBuilt === 0);
  check("status: generic connect failure → failed", status("broken") === "failed");
  check("status: 401 + oauth service → needs-auth", status("remote") === "needs-auth");

  // 2. tools machine by status
  check("tools: connected server exposes its real tool", (await providerNames(cap, "good", capCtx)).includes("mcp__good__echo"));
  check("tools: failed server exposes nothing", (await providerNames(cap, "broken", capCtx)).length === 0);
  check("tools: disabled server exposes nothing", (await providerNames(cap, "off", capCtx)).length === 0);

  // 3. per-server filter
  const filtered = await providerNames(cap, "filtered", capCtx);
  check("filter: allowedTools narrows to the listed tool", filtered.length === 1 && filtered[0] === "mcp__filtered__echo");

  // 4. needs-auth → synthetic authenticate tool, then reconnect swaps in real tools
  const beforeLogin = await providerNames(cap, "remote", capCtx);
  check(
    "needs-auth: exposes only the synthetic authenticate tool",
    beforeLogin.length === 1 && beforeLogin[0] === qualifyMcpToolName("remote", "authenticate"),
  );
  remoteAuthed = true; // simulate the user finishing the browser OAuth flow
  await handle.reconnect("remote");
  check("needs-auth: reconnect after login → connected", status("remote") === "connected");
  const afterLogin = await providerNames(cap, "remote", capCtx);
  check("needs-auth: real tools replace the synthetic tool after login", afterLogin.length === 1 && afterLogin[0] === "mcp__remote__search");

  // 5. warnings
  check("warning: generic failure emitted a warning", warnings.some((m) => m.includes("broken") && m.includes("connection refused")));
  check("warning: needs-auth did NOT emit a warning", !warnings.some((m) => m.includes("remote")));

  await cap.closeSession?.();
  check("lifecycle: closeSession resolves cleanly", true);

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP MANAGER E2E PASS — status machine + filter + needs-auth swap + reconnect + warnings");
  } else {
    console.log("❌ MCP MANAGER E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MCP MANAGER E2E ERROR:", error);
  process.exit(1);
});
