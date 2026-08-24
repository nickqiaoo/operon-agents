import {
  LocalMachine,
  ListenerSink,
  SteerBus,
  type SessionContext,
} from "../index.ts";
import {
  mcpServersCapability,
  type McpServersHandle,
  type McpTimer,
  type MCPPingOptions,
  type MCPTransport,
  type MCPTool,
  type MCPToolResult,
} from "../mcp/index.ts";
import type { McpServerConfig } from "../config/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class PingTransport implements MCPTransport {
  readonly name: string;
  pingShouldFail = false;
  pingCalls = 0;
  pingTimeouts: Array<number | undefined> = [];
  closeCalls = 0;
  private open = false;

  constructor(name: string) {
    this.name = name;
  }

  async connect(): Promise<void> {
    this.open = true;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.open = false;
  }

  async ping(options?: MCPPingOptions): Promise<void> {
    if (!this.open) throw new Error("not open");
    this.pingCalls += 1;
    this.pingTimeouts.push(options?.timeoutMs);
    if (this.pingShouldFail) throw new Error("ping timeout");
  }

  async listTools(): Promise<readonly MCPTool[]> {
    return [{ name: "tool", inputSchema: { type: "object" } }];
  }

  async callTool(): Promise<MCPToolResult> {
    return { content: [] };
  }
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

  const built: PingTransport[] = [];
  const factory = (name: string): MCPTransport => {
    const t = new PingTransport(name);
    built.push(t);
    return t;
  };
  const current = (): PingTransport => built[built.length - 1]!;

  const { timer, pending, fire } = makeTimer();
  const configs: Record<string, McpServerConfig> = {
    srv: { transport: "http", url: "http://srv.example", keepAliveIntervalMs: 50, keepAliveTimeoutMs: 7 },
  };
  const cap = mcpServersCapability(configs, {
    transportFactory: factory,
    reconnectPolicy: { maxRetries: 1, initialDelayMs: 100, maxDelayMs: 100, factor: 2 },
    timer,
  });
  const handle = cap.service as McpServersHandle;

  await cap.openSession?.(sessionCtx);
  check("heartbeat: connected server schedules the first ping", handle.list()[0]?.status === "connected" && pending.length === 1 && pending[0]!.ms === 50);

  const firstDelay = fire();
  await flush();
  check("heartbeat: timer fires MCP ping", firstDelay === 50 && current().pingCalls === 1);
  check("heartbeat: keepAliveTimeoutMs is passed to ping", current().pingTimeouts[0] === 7);
  check("heartbeat: successful ping schedules the next interval", pending.length === 1 && pending[0]!.ms === 50);

  current().pingShouldFail = true;
  const failingTransport = current();
  fire();
  await flush();
  check("heartbeat failure: status flips to failed", handle.list()[0]?.status === "failed");
  check("heartbeat failure: transport is closed", failingTransport.closeCalls === 1);
  check("heartbeat failure: warning is emitted", warnings.some((m) => m.includes("keep-alive ping failed") && m.includes("ping timeout")));
  check("heartbeat failure: reconnect backoff is scheduled", pending.length === 1 && pending[0]!.ms === 100);

  fire();
  await flush();
  check("heartbeat reconnect: recovered to connected", handle.list()[0]?.status === "connected" && built.length === 2);
  check("heartbeat reconnect: heartbeat restarts after reconnect", pending.length === 1 && pending[0]!.ms === 50);

  await handle.shutdown();
  await handle.shutdown();
  check("heartbeat shutdown: cancels pending heartbeat and is idempotent", pending.length === 0);

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP KEEPALIVE E2E PASS — ping loop + failure → reconnect + shutdown cleanup");
  } else {
    console.log("❌ MCP KEEPALIVE E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MCP KEEPALIVE E2E ERROR:", error);
  process.exit(1);
});
