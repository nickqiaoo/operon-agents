/**
 * Session-private MCP servers (`createSession({ mcpServers })`) layered OVER the shared set's
 * shared connections: they connect and shut down with the session, a name they reuse shadows the
 * workspace server of that name for this session only, and the workspace connection underneath
 * keeps running for everyone else.
 *
 * Then the opt-out: `mcpServersCapability({ shareWorkspace: false })` pins a session to its own
 * servers. The workspace set is unaffected — it still connects, still serves every other session,
 * and still comes down when the last of them leaves; this one simply never sees it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type Context, offeredToolNames } from "./faux.ts";
import { createHarness, createLocalHarness, createMcpServers, defaultCapabilities, mcpServersCapability, type HarnessParts, type McpServersHandle } from "../src/index.ts";

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
        offered = offeredToolNames(context);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);

    const ws = { connects: 0, closes: 0 };
    const own = { connects: 0, closes: 0 };
    let wsShutdowns = 0;
    let shared: McpServersHandle | undefined;

    const harness = createHarness({
      model,
      workDir: dir,
      permission: { mode: "yolo" },
      harness: async () => {
        const servers = createMcpServers(
          { ws: { transport: "http", url: "http://ws.example" }, dup: { transport: "http", url: "http://dup.example" } },
          { transportFactory: transport("ws_tool", ws) },
        );
        await servers.connect({ sessionId: "" });
        shared = servers;
        return { mcpServers: servers, close: async () => { wsShutdowns += 1; await servers.shutdown(); } };
      },
      // What `localHarnessOptions` wires, minus the transport injection tests need.
      session: (ctx) => [
        ...defaultCapabilities({ shared: shared !== undefined ? { mcpServers: shared } : {} }).filter((c) => c.name !== "mcp"),
        mcpServersCapability(ctx.mcpServers ?? {}, {
          transportFactory: transport("own_tool", own),
          ...(shared !== undefined ? { sharedServers: shared } : {}),
        }),
      ],
    });

    // ── a session with no servers of its own: the shared view, unchanged ──
    const plain = await harness.createSession({ workDir: dir });
    check("view: a session without its own servers sees exactly the shared set's", (plain.mcp?.list() ?? []).map((v) => v.name).sort().join(",") === "dup,ws");
    check("view: an unshadowed name resolves to the shared server", (await plain.mcp?.listTools("dup") ?? []).some((t) => t.name === "ws_tool"));
    await plain.prompt("hi");
    check("view: the model is offered the workspace tools", offered.includes("mcp__ws__ws_tool") && offered.includes("mcp__dup__ws_tool"));

    // ── a session that brings its own, one of them shadowing a workspace name ──
    const wsConnectsBefore = ws.connects;
    const overlay = await harness.createSession({
      workDir: dir,
      mcpServers: { own: { transport: "http", url: "http://own.example" }, dup: { transport: "http", url: "http://own-dup.example" } },
    });
    check("overlay: the session's own servers connect for this session", own.connects === 2 && own.closes === 0);
    check("overlay: the shared servers are not reconnected for it", ws.connects === wsConnectsBefore);
    check("overlay: listMcpServers merges both tiers, each name once", (overlay.mcp?.list() ?? []).map((v) => v.name).sort().join(",") === "dup,own,ws");
    check("overlay: every merged server reads as connected", (overlay.mcp?.list() ?? []).every((v) => v.status === "connected"));
    check("shadow: a reused name resolves to the session's server", (await overlay.mcp?.listTools("dup") ?? []).some((t) => t.name === "own_tool"));

    faux.setResponses([
      (context: Context) => {
        offered = offeredToolNames(context);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    await overlay.prompt("hi");
    check("shadow: the shadowed workspace tools never reach the model", !offered.includes("mcp__dup__ws_tool"));
    check("shadow: the session's tools take that name instead", offered.includes("mcp__dup__own_tool"));
    check("overlay: unshadowed tools from both tiers reach the model", offered.includes("mcp__ws__ws_tool") && offered.includes("mcp__own__own_tool"));

    const ownConnectsBefore = own.connects;
    await overlay.core.requireService("mcp").reconnect("dup");
    check("shadow: reconnect hits the session's server, not the shared set's", own.connects === ownConnectsBefore + 1 && ws.connects === wsConnectsBefore);

    // ── teardown: the overlay is the session's to close, the shared set's is not ──
    // (`reconnect` above already closed one transport, hence the delta rather than a total.)
    const ownClosesBefore = own.closes;
    await overlay.close();
    check("lifecycle: closing the session shuts its own servers down", own.closes === ownClosesBefore + 2);
    check("lifecycle: the workspace connections survive it", wsShutdowns === 0 && ws.closes === 0);
    check("lifecycle: the other session still sees the shared servers", (plain.mcp?.list() ?? []).length === 2);
    await plain.close();
    check("lifecycle: the shared set outlives every session — the harness owns it", wsShutdowns === 0);
    await harness.close();
    check("lifecycle: closing the harness takes the shared set down", wsShutdowns === 1);

    // ── shareWorkspace: false — the shared set's set runs on; this session just cannot see it ──
    const pinWs = { connects: 0, closes: 0 };
    const pinOwn = { connects: 0, closes: 0 };
    let pinWsShutdowns = 0;
    let pinShared: McpServersHandle | undefined;
    const pinnedParts = async (): Promise<HarnessParts> => {
      const servers = createMcpServers(
        { ws: { transport: "http", url: "http://ws.example" } },
        { transportFactory: transport("ws_tool", pinWs) },
      );
      await servers.connect({ sessionId: "" });
      pinShared = servers;
      return { mcpServers: servers, close: async () => { pinWsShutdowns += 1; await servers.shutdown(); } };
    };

    const pinned = createHarness({
      model,
      workDir: dir,
      permission: { mode: "yolo" },
      harness: pinnedParts,
      // No `sharedServers` passed: this session is pinned to its own, and must not be backfilled.
      session: (ctx) => [
        ...defaultCapabilities({ shared: {} }).filter((c) => c.name !== "mcp"),
        mcpServersCapability(ctx.mcpServers ?? {}, { transportFactory: transport("own_tool", pinOwn) }),
      ],
    });
    const pinnedSession = await pinned.createSession({
      workDir: dir,
      mcpServers: { own: { transport: "http", url: "http://own.example" } },
    });
    check("pin: the session lists only its own servers", (pinnedSession.mcp?.list() ?? []).map((v) => v.name).join(",") === "own");
    check("pin: the shared set connected anyway — it is the harness's, not this session's to skip", pinWs.connects === 1);

    faux.setResponses([
      (context: Context) => {
        offered = offeredToolNames(context);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);
    await pinnedSession.prompt("hi");
    check("pin: no shared tool reaches the model", !offered.some((name) => name.startsWith("mcp__ws__")));
    check("pin: its own tools still do", offered.includes("mcp__own__own_tool"));

    await pinnedSession.close();
    check("pin: closing the session leaves the harness's set alone", pinWsShutdowns === 0);
    await pinned.close();
    check("pin: the harness takes it down", pinWsShutdowns === 1);

    // Pinned to its own servers and given none: a misassembly that must name its reason rather
    // than quietly resolving the very set it was told to ignore.
    const misassemblyLogs: string[] = [];
    const misassembled = createHarness({
      model,
      workDir: dir,
      permission: { mode: "yolo" },
      harness: () => ({ logger: { log: (_level, message, fields) => misassemblyLogs.push(`${message} ${JSON.stringify(fields ?? {})}`) } }),
      session: () => [
        ...defaultCapabilities({ shared: {} }).filter((c) => c.name !== "mcp"),
        mcpServersCapability({}),
      ],
    });
    const misassembled2 = await misassembled.createSession({ workDir: dir });
    // A failed provision is fault-isolated: the capability is simply absent for this session.
    // What must NOT happen is the fallback resolving the workspace set we were told to ignore.
    check("pin: with nothing of its own and nothing shared, the capability is absent", (misassembled2.mcp?.list() ?? []).length === 0);
    check("pin: and the diagnostic names the reason", misassemblyLogs.some((line) => line.includes("no servers of its own")));
    await misassembled2.close();
    await misassembled.close();

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
    check("preset: createLocalHarness lists workspace + session servers together", (session.mcp?.list() ?? []).map((v) => v.name).sort().join(",") === "sessdown,wsdown");
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
    console.log("✅ MCP-SESSION-OVERLAY E2E PASS — session-private servers layer over the shared set's, shadow by name, and close with the session");
  } else {
    console.log("❌ MCP-SESSION-OVERLAY E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
