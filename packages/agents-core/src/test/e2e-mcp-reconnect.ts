import {
  LocalMachine,
  ListenerSink,
  SteerBus,
  type SessionContext,
} from "../index.ts";
import {
  mcpServersCapability,
  type McpServersHandle,
  type McpServerView,
  type McpTimer,
  type MCPTransport,
  type MCPTool,
  type MCPToolResult,
} from "../mcp/index.ts";
import type { UnexpectedCloseListener } from "../mcp/types.ts";
import type { McpServerConfig } from "../config/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class ControlledTransport implements MCPTransport {
  readonly name: string;
  connectShouldFail = false;
  private open = false;
  private closeListener: UnexpectedCloseListener | undefined;
  constructor(name: string) {
    this.name = name;
  }
  async connect(): Promise<void> {
    if (this.connectShouldFail) throw new Error(`connect refused for ${this.name}`);
    this.open = true;
  }
  async close(): Promise<void> {
    this.open = false;
  }
  async listTools(): Promise<readonly MCPTool[]> {
    if (!this.open) throw new Error("not open");
    return [{ name: "tool", inputSchema: { type: "object" } }];
  }
  async callTool(): Promise<MCPToolResult> {
    return { content: [] };
  }
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.closeListener = listener;
  }
  drop(): void {
    this.open = false;
    this.closeListener?.({ error: new Error("socket closed") });
  }
}

// A transport whose connect() can be held open, then released or failed on command —
// lets a test overlap two in-flight attempts deterministically.
class GatedTransport implements MCPTransport {
  readonly name: string;
  open = false;
  private closeListener: UnexpectedCloseListener | undefined;
  private gate: { resolve: () => void; reject: (e: Error) => void } | undefined;
  private readonly autoConnect: boolean;
  constructor(name: string, autoConnect: boolean) {
    this.name = name;
    this.autoConnect = autoConnect;
  }
  connect(): Promise<void> {
    if (this.autoConnect) {
      this.open = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.gate = {
        resolve: () => {
          this.open = true;
          resolve();
        },
        reject,
      };
    });
  }
  release(): void {
    this.gate?.resolve();
  }
  fail(): void {
    this.gate?.reject(new Error(`connect failed for ${this.name}`));
  }
  async close(): Promise<void> {
    this.open = false;
  }
  async listTools(): Promise<readonly MCPTool[]> {
    if (!this.open) throw new Error("not open");
    return [{ name: "tool", inputSchema: { type: "object" } }];
  }
  async callTool(): Promise<MCPToolResult> {
    return { content: [] };
  }
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.closeListener = listener;
  }
  drop(): void {
    this.open = false;
    this.closeListener?.({ error: new Error("dropped") });
  }
}

// A manual reconnect() firing while a scheduled attempt is still awaiting connect() used
// to let the loser's cleanup tear down the winner's live connection (and leak the loser's).
// Identity-guarded attempt() must keep the winner connected and close only the loser.
async function testSupersededAttempt(baseCtx: SessionContext): Promise<void> {
  const built: GatedTransport[] = [];
  let gated = false;
  const factory = (name: string): MCPTransport => {
    const t = new GatedTransport(name, !gated);
    built.push(t);
    return t;
  };
  const { timer, fire } = makeTimer();
  const configs: Record<string, McpServerConfig> = { srv: { transport: "http", url: "http://srv.example" } };
  const cap = mcpServersCapability(configs, {
    transportFactory: factory,
    reconnectPolicy: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, factor: 2 },
    timer,
  });
  const handle = cap.service as McpServersHandle;
  await cap.openSession?.(baseCtx); // t0 auto-connects
  const t0 = built[0]!;

  gated = true; // subsequent connects are held open until released/failed
  t0.drop(); // schedules a reconnect
  fire(); // runScheduledReconnect → attempt A, now parked on t1.connect()
  await flush();
  const t1 = built[1]!;

  const reconnecting = handle.reconnect("srv"); // closes t1, starts attempt B parked on t2.connect()
  await flush();
  const t2 = built[2]!;

  t2.release(); // attempt B (the intended winner) connects
  await flush();
  await reconnecting;
  t1.fail(); // attempt A's connect finally rejects → its catch runs LAST
  await flush();

  check(
    "superseded: winner stays connected — the losing attempt's catch did not tear it down",
    handle.list()[0]?.status === "connected" && t2.open === true,
  );
  check("superseded: the superseded attempt's transport is closed, not leaked", t1.open === false);
  await handle.shutdown();
}

function makeTimer(): { timer: McpTimer; pending: Array<{ fn: () => void; ms: number }>; fire(): number } {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timer: McpTimer = {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms };
      pending.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const i = pending.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return {
    timer,
    pending,
    fire: () => {
      const next = pending.shift();
      if (next === undefined) throw new Error("no pending timer");
      next.fn();
      return next.ms;
    },
  };
}

async function main(): Promise<void> {
  const machine = new LocalMachine(process.cwd());
  const events = new ListenerSink();
  const warnings: string[] = [];
  events.subscribe((e) => {
    if (e.type === "warning") warnings.push(e.message);
  });
  const sessionCtx: SessionContext = { sessionId: "s", machine, events, signal: new AbortController().signal, steer: new SteerBus() };

  const built: ControlledTransport[] = [];
  let failNextConnects = 0;
  const factory = (name: string): MCPTransport => {
    const t = new ControlledTransport(name);
    if (failNextConnects > 0) {
      t.connectShouldFail = true;
      failNextConnects -= 1;
    }
    built.push(t);
    return t;
  };
  const current = (): ControlledTransport => built[built.length - 1]!;

  const { timer, pending, fire } = makeTimer();
  const configs: Record<string, McpServerConfig> = { srv: { transport: "http", url: "http://srv.example" } };
  const cap = mcpServersCapability(configs, {
    transportFactory: factory,
    reconnectPolicy: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, factor: 2 },
    timer,
  });
  const handle = cap.service as McpServersHandle;

  // Subscribe BEFORE connecting so we see the initial transition.
  const transitions: McpServerView[] = [];
  const unsub = handle.onStatusChange((v) => transitions.push(v));

  await cap.openSession?.(sessionCtx);
  check("status: initial connect → connected", handle.list()[0]?.status === "connected");
  check("onStatusChange: fired connected transition", transitions.some((t) => t.status === "connected"));

  // 1. Drop → schedule reconnect (delay = initial 100). Reconnect succeeds.
  current().drop();
  check("drop: status flips to failed", handle.list()[0]?.status === "failed");
  check("drop: a reconnect timer is scheduled at the initial delay", pending.length === 1 && pending[0]!.ms === 100);
  const d0 = fire();
  await flush();
  check("reconnect: recovered to connected after backoff", d0 === 100 && handle.list()[0]?.status === "connected");

  // 2. Backoff growth: next two reconnect attempts fail, the third succeeds → delays 100,200,400.
  const delays: number[] = [];
  failNextConnects = 2;
  current().drop();
  delays.push(fire()); // 100 → attempt fails → reschedule
  await flush();
  delays.push(fire()); // 200 → attempt fails → reschedule
  await flush();
  delays.push(fire()); // 400 → attempt succeeds
  await flush();
  check("backoff: delays grow initial·factor^n (100,200,400)", delays.join(",") === "100,200,400");
  check("backoff: recovered to connected after the flaky retries", handle.list()[0]?.status === "connected");

  // 3. Give up after maxRetries (3) consecutive failures.
  warnings.length = 0;
  failNextConnects = 99; // every reconnect fails
  current().drop();
  fire(); await flush(); // attempt 1 fail
  fire(); await flush(); // attempt 2 fail
  fire(); await flush(); // attempt 3 fail → gave up (no further schedule)
  check("giveup: no further reconnect scheduled after maxRetries", pending.length === 0);
  check("giveup: stays failed", handle.list()[0]?.status === "failed");
  check("giveup: emitted a 'gave up' warning", warnings.some((m) => m.includes("gave up reconnecting")));

  // 4. Recover, then test unsubscribe + shutdown.
  failNextConnects = 0;
  await handle.reconnect("srv");
  check("manual reconnect: resets backoff and reconnects", handle.list()[0]?.status === "connected");

  const before = transitions.length;
  unsub();
  current().drop(); // a transition the unsubscribed listener must NOT see
  check("onStatusChange: unsubscribe stops notifications", transitions.length === before);
  // The drop above scheduled a reconnect; shutdown must cancel it.
  const pendingBeforeShutdown = pending.length;
  await handle.shutdown();
  await handle.shutdown(); // idempotent
  check("shutdown: cancels the pending reconnect timer", pendingBeforeShutdown === 1 && pending.length === 0);
  // Firing a stale timer (if any leaked) must not revive the server.
  check("shutdown: server stays down", handle.list()[0]?.status === "failed");

  await testSupersededAttempt(sessionCtx);

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP RECONNECT E2E PASS — onStatusChange + backoff (grow/giveup) + unsubscribe + shutdown");
  } else {
    console.log("❌ MCP RECONNECT E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MCP RECONNECT E2E ERROR:", error);
  process.exit(1);
});
