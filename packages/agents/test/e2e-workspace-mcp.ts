/**
 * Per-directory MCP sharing (`WorkspaceMcpPool` + `defaultCapabilities({ workspaceMcp })`).
 *
 * The desktop shape: one harness, many sessions, several of them in one folder. Sessions in the
 * same directory (by real path) run ONE set of connections; another directory runs its own; a
 * session's own `mcpServers` stay private and shadow by name. The set outlives its last session by
 * `idleMs` so the next chat reuses it, a changed configuration gets a new generation without
 * disturbing sessions on the old one, and a detach or a closed harness gives everything back.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type Context, offeredToolNames } from "./faux.ts";
import {
  createHarness,
  defaultCapabilities,
  McpTransportNotPermittedError,
  WorkspaceMcpPool,
  workspaceMcpCapability,
  type McpServerConfig,
} from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Connects / closes per server URL, so a count says which server and which generation. */
const connects = new Map<string, number>();
const closes = new Map<string, number>();
const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};
const count = (map: Map<string, number>, key: string): number => map.get(key) ?? 0;

/** Each transport offers one tool named after its server's URL host, e.g. `ws_tool`. */
const transportFactory = (name: string, config: McpServerConfig) => {
  const url = config.url ?? name;
  const tool = `${new URL(url).hostname.split(".")[0]}_tool`;
  return {
    name,
    async connect() { bump(connects, url); },
    async close() { bump(closes, url); },
    async listTools() { return [{ name: tool, description: tool, inputSchema: { type: "object", properties: {} } }]; },
    async callTool() { return { content: [{ type: "text", text: "hi" }] }; },
  };
};

const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workspace-mcp-"));
  const projA = join(root, "a");
  const projB = join(root, "b");
  mkdirSync(projA);
  mkdirSync(projB);
  const linkA = join(root, "link-to-a");
  symlinkSync(projA, linkA);
  try {
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    let offered: string[] = [];
    const record = () => faux.setResponses([
      (context: Context) => {
        offered = offeredToolNames(context);
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      },
    ]);

    const IDLE_MS = 40;
    const pool = new WorkspaceMcpPool({ transportFactory, idleMs: IDLE_MS });
    // What the desktop's `mcp.json` would say, per directory — mutable so a test can "edit" it.
    const dirServers: Record<string, Record<string, McpServerConfig>> = {
      [projA]: { ws: { transport: "http", url: "http://ws.example" } },
      [projB]: { ws: { transport: "http", url: "http://wsb.example" } },
    };
    const serversFor = (workDir: string) => dirServers[workDir === linkA ? projA : workDir] ?? {};
    let poolClosed = 0;
    const harness = createHarness({
      model,
      workDir: projA,
      permission: { mode: "yolo" },
      harness: () => ({ close: async () => { poolClosed += 1; await pool.close(); } }),
      session: (ctx) =>
        defaultCapabilities({
          workspaceMcp: { pool, workDir: ctx.workDir, servers: serversFor(ctx.workDir) },
          ...(ctx.mcpServers !== undefined ? { sessionMcpServers: ctx.mcpServers } : {}),
        }),
    });

    // ── two sessions, one directory: one connection ──
    const s1 = await harness.createSession({ workDir: projA });
    const s2 = await harness.createSession({ workDir: projA });
    check("share: two sessions in one directory connect the server once", count(connects, "http://ws.example") === 1);
    check("share: one directory holds one set", pool.size === 1);
    check("share: both sessions list the shared server", [s1, s2].every((s) => (s.mcp?.list() ?? []).map((v) => v.name).join(",") === "ws"));
    record();
    await s2.prompt("hi");
    check("share: the model is offered the shared tools", offered.includes("mcp__ws__ws_tool"));

    // ── the same directory through a symlink is the same directory ──
    const viaLink = await harness.createSession({ workDir: linkA });
    check("key: a symlink to the directory shares its set", count(connects, "http://ws.example") === 1 && pool.size === 1);

    // ── another directory: its own set ──
    const b1 = await harness.createSession({ workDir: projB });
    check("isolate: another directory connects its own servers", count(connects, "http://wsb.example") === 1 && pool.size === 2);
    check("isolate: and sees only those", (b1.mcp?.list() ?? []).length === 1 && (await b1.mcp?.listTools("ws") ?? []).some((t) => t.name === "wsb_tool"));

    // ── a session's own servers stay private, and shadow by name ──
    const own = await harness.createSession({
      workDir: projA,
      mcpServers: { own: { transport: "http", url: "http://127.0.0.1:1/own" } },
    });
    // The overlay runs on the real transport (`defaultCapabilities` injects none), against a port
    // that refuses at once: what matters is that it is listed here, and only here.
    check("overlay: the session lists shared + own", (own.mcp?.list() ?? []).map((v) => v.name).sort().join(",") === "own,ws");
    check("overlay: other sessions in the directory never see it", (s1.mcp?.list() ?? []).map((v) => v.name).join(",") === "ws");
    check("overlay: the shared set was not reconnected for it", count(connects, "http://ws.example") === 1);
    await own.close();

    // ── closing sessions: the set stays while held, then idles, then closes ──
    await s1.close();
    await s2.close();
    check("lifetime: still held by one session → nothing closed", count(closes, "http://ws.example") === 0);
    await viaLink.close();
    check("lifetime: last session out → kept for the grace period", count(closes, "http://ws.example") === 0 && pool.size === 2);
    const back = await harness.createSession({ workDir: projA });
    check("lifetime: a session within the grace period reuses the set", count(connects, "http://ws.example") === 1);
    await back.close();
    await delay(IDLE_MS * 3);
    check("lifetime: after the grace period the set is closed", count(closes, "http://ws.example") === 1 && pool.size === 1);
    const fresh = await harness.createSession({ workDir: projA });
    check("lifetime: the next session builds a new one", count(connects, "http://ws.example") === 2);

    // ── a changed configuration: new generation for new sessions, old one kept by its holders ──
    dirServers[projA] = { ws: { transport: "http", url: "http://ws.example" }, extra: { transport: "http", url: "http://extra.example" } };
    const edited = await harness.createSession({ workDir: projA });
    check("generation: a new config builds a new set for the new session", count(connects, "http://extra.example") === 1 && (edited.mcp?.list() ?? []).length === 2);
    check("generation: the session on the old config keeps its set", (fresh.mcp?.list() ?? []).length === 1 && count(closes, "http://ws.example") === 1);
    await fresh.close();
    check("generation: the retired set closes when its last holder leaves — no grace", count(closes, "http://ws.example") === 2);
    check("generation: the current one is untouched", count(closes, "http://extra.example") === 0);

    // ── detaching the capability gives the lease back like a close does ──
    await edited.core.detachCapability("mcp");
    check("detach: the session no longer sees MCP", edited.mcp === undefined);
    await delay(IDLE_MS * 3);
    check("detach: its lease came back — the idle set closed", count(closes, "http://extra.example") === 1);
    await edited.close();

    // ── harness close: the host's `close` takes the pool down with it ──
    await harness.close();
    check("close: harness close closed the pool", poolClosed === 1 && pool.size === 0);
    check("close: every set is shut, held or idle", count(closes, "http://wsb.example") === 1);
    let refused = false;
    try {
      await pool.acquire(projA, { ws: { transport: "http", url: "http://ws.example" } });
    } catch {
      refused = true;
    }
    check("close: a closed pool refuses to lend", refused);

    // ── the pool on its own: concurrent borrows share one connect; release is idempotent ──
    const bare = new WorkspaceMcpPool({ transportFactory, idleMs: 0 });
    const cfg = { solo: { transport: "http" as const, url: "http://solo.example" } };
    const [l1, l2] = await Promise.all([bare.acquire(projB, cfg), bare.acquire(projB, cfg)]);
    check("pool: concurrent borrows of one directory connect once", count(connects, "http://solo.example") === 1 && l1.servers === l2.servers);
    await l1.release();
    await l1.release();
    check("pool: a double release does not drop the other borrower's hold", count(closes, "http://solo.example") === 0);
    await l2.release();
    check("pool: idleMs 0 closes on the last release", count(closes, "http://solo.example") === 1 && bare.size === 0);
    await bare.close();

    // ── the host's transport allow-list covers the shared servers too ──
    let blocked: unknown;
    try {
      workspaceMcpCapability({
        pool: bare,
        workDir: projA,
        servers: { local: { transport: "stdio", command: "nope" } },
        overlayOptions: { allowedTransports: ["http"] },
      });
    } catch (error) {
      blocked = error;
    }
    check("transports: a pooled stdio server on an http-only host is refused up front", blocked instanceof McpTransportNotPermittedError);

    faux.unregister();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ WORKSPACE-MCP E2E PASS — sessions in one directory share one set of MCP connections");
  } else {
    console.log("❌ WORKSPACE-MCP E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
