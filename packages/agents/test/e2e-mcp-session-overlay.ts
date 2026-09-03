/**
 * Session-private MCP servers (`createSession({ mcpServers })`) layered OVER the workspace's
 * shared connections: they connect and shut down with the session, a name they reuse shadows the
 * workspace server of that name for this session only, and the workspace connection underneath
 * keeps running for everyone else.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type Context } from "./faux.ts";
import { createHarness, createLocalHarness, createMcpServers, defaultCapabilities, mcpSessionCapability, T } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** A transport whose single tool is named per server, so a tool name says which tier served it. */
function transport(toolName: string, counters: { connects: number; closes: number }) {
  return (name: string) => ({
    name,
    async connect() { counters.connects += 1; },
    async close() { counters.closes += 1; },
    async listTools() { return [{ name: toolName, description: toolName, inputSchema: { type: "object", properties: {} } }]; },
    async callTool() { return { content: [{ type: "text", text: "hi" }] }; },
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-overlay-"));
  const homeDir = mkdtempSync(join(tmpdir(), "mcp-overlay-home-"));
  try {
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    // Every prompt records the tool names the model was actually offered.
    let offered: string[] = [];
    faux.setResponses([
      (context: Context) => {
        offered = (context.tools ?? []).map((t) => t.name);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);

    const ws = { connects: 0, closes: 0 };
    const own = { connects: 0, closes: 0 };
    let wsShutdowns = 0;

    const harness = createHarness({
      model,
      workDir: dir,
      permission: { mode: "yolo" },
      workspace: async (scope) => {
        const servers = createMcpServers(
          { ws: { transport: "http", url: "http://ws.example" }, dup: { transport: "http", url: "http://dup.example" } },
          { transportFactory: transport("ws_tool", ws) },
        );
        await servers.connect({ scope, sessionId: "" });
        scope.register(T.McpServers, servers, { dispose: async () => { wsShutdowns += 1; await servers.shutdown(); } });
      },
      // What `localHarnessOptions` wires, minus the transport injection tests need.
      session: (scope, ctx) => [
        ...defaultCapabilities({ scope }).filter((c) => c.name !== "mcp"),
        mcpSessionCapability(ctx.mcpServers ?? {}, { transportFactory: transport("own_tool", own) }),
      ],
    });

    // ── a session with no servers of its own: the workspace view, unchanged ──
    const plain = await harness.createSession({ workDir: dir });
    check("view: a session without its own servers sees exactly the workspace's", plain.listMcpServers().map((v) => v.name).sort().join(",") === "dup,ws");
    check("view: an unshadowed name resolves to the workspace server", (await plain.listMcpTools("dup")).some((t) => t.name === "ws_tool"));
    await plain.prompt("hi");
    check("view: the model is offered the workspace tools", offered.includes("mcp__ws__ws_tool") && offered.includes("mcp__dup__ws_tool"));

    // ── a session that brings its own, one of them shadowing a workspace name ──
    const wsConnectsBefore = ws.connects;
    const overlay = await harness.createSession({
      workDir: dir,
      mcpServers: { own: { transport: "http", url: "http://own.example" }, dup: { transport: "http", url: "http://own-dup.example" } },
    });
    check("overlay: the session's own servers connect for this session", own.connects === 2 && own.closes === 0);
    check("overlay: the workspace servers are not reconnected for it", ws.connects === wsConnectsBefore);
    check("overlay: listMcpServers merges both tiers, each name once", overlay.listMcpServers().map((v) => v.name).sort().join(",") === "dup,own,ws");
    check("overlay: every merged server reads as connected", overlay.listMcpServers().every((v) => v.status === "connected"));
    check("shadow: a reused name resolves to the session's server", (await overlay.listMcpTools("dup")).some((t) => t.name === "own_tool"));

    faux.setResponses([
      (context: Context) => {
        offered = (context.tools ?? []).map((t) => t.name);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    await overlay.prompt("hi");
    check("shadow: the shadowed workspace tools never reach the model", !offered.includes("mcp__dup__ws_tool"));
    check("shadow: the session's tools take that name instead", offered.includes("mcp__dup__own_tool"));
    check("overlay: unshadowed tools from both tiers reach the model", offered.includes("mcp__ws__ws_tool") && offered.includes("mcp__own__own_tool"));

    const ownConnectsBefore = own.connects;
    await overlay.reconnectMcpServer("dup");
    check("shadow: reconnect hits the session's server, not the workspace's", own.connects === ownConnectsBefore + 1 && ws.connects === wsConnectsBefore);

    // ── teardown: the overlay is the session's to close, the workspace's is not ──
    // (`reconnect` above already closed one transport, hence the delta rather than a total.)
    const ownClosesBefore = own.closes;
    await overlay.close();
    check("lifecycle: closing the session shuts its own servers down", own.closes === ownClosesBefore + 2);
    check("lifecycle: the workspace connections survive it", wsShutdowns === 0 && ws.closes === 0);
    check("lifecycle: the other session still sees the workspace servers", plain.listMcpServers().length === 2);
    await plain.close();
    check("lifecycle: the last session out takes the workspace down", wsShutdowns === 1);
    await harness.close();

    // ── the default local preset actually consumes `createSession({ mcpServers })` ──
    const local = await createLocalHarness({
      model,
      workDir: dir,
      homeDir,
      permission: { mode: "yolo" },
      loadDiskProfiles: false,
      mcpServers: { wsdown: { transport: "http", url: "http://127.0.0.1:1/ws" } },
    });
    const session = await local.createSession({ workDir: dir, mcpServers: { sessdown: { transport: "http", url: "http://127.0.0.1:1/sess" } } });
    // Both are unreachable; what matters is that both TIERS are represented, i.e. the preset's
    // session factory read `ctx.mcpServers` at all.
    check("preset: createLocalHarness lists workspace + session servers together", session.listMcpServers().map((v) => v.name).sort().join(",") === "sessdown,wsdown");
    await session.close();
    await local.close();

    faux.unregister();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP-SESSION-OVERLAY E2E PASS — session-private servers layer over the workspace's, shadow by name, and close with the session");
  } else {
    console.log("❌ MCP-SESSION-OVERLAY E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
