import { TransportMCPServer } from "./server.ts";
import { mcpStdioTransport, mcpStreamableHttpTransport } from "./sdk-transport.ts";
import { mcpToolProvider } from "./provider.ts";
import { qualifyMcpToolName } from "./tool-naming.ts";
import { createMcpAuthTool } from "./auth-tool.ts";
import type { MCPTool, MCPTransport } from "./types.ts";
import type { MCPToolFilterStatic } from "./filter.ts";
import type { McpOAuthService } from "./oauth/index.ts";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Capability, SessionContext, CapabilityContext, Tool, ToolProvider } from "../index.ts";
import type { McpServerConfig } from "../config/schema.ts";

export type McpServerStatus = "pending" | "connected" | "failed" | "disabled" | "needs-auth";

export interface McpServerView {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly status: McpServerStatus;
  readonly error?: string;
}

export type McpStatusListener = (view: McpServerView) => void;

export interface ReconnectPolicy {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  factor: 2,
};

export interface KeepAlivePolicy {
  readonly intervalMs: number;
  readonly timeoutMs?: number;
}

export interface McpTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMER: McpTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_CACHE_TOOLS = true;

export type McpTransportFactory = (name: string, config: McpServerConfig) => MCPTransport;

export interface ServerFromConfigOptions {
  readonly oauthService?: McpOAuthService;
  readonly cacheToolsList?: boolean;
  readonly transport?: MCPTransport;
}

export function serverFromConfig(name: string, config: McpServerConfig, opts: ServerFromConfigOptions = {}): TransportMCPServer {
  const transport = opts.transport ?? transportFromConfig(name, config, opts.oauthService);
  const filter = staticFilterFromConfig(config);
  return new TransportMCPServer({
    name,
    transport,
    cacheToolsList: opts.cacheToolsList ?? DEFAULT_CACHE_TOOLS,
    ...(filter !== undefined ? { toolFilter: filter } : {}),
    ...(config.startupTimeoutMs !== undefined ? { startupTimeoutMs: config.startupTimeoutMs } : {}),
  });
}

function staticFilterFromConfig(config: McpServerConfig): MCPToolFilterStatic | undefined {
  const allowed = config.allowedTools;
  const blocked = config.blockedTools;
  if (allowed === undefined && blocked === undefined) return undefined;
  return {
    ...(allowed !== undefined ? { allowedToolNames: allowed } : {}),
    ...(blocked !== undefined ? { blockedToolNames: blocked } : {}),
  };
}

function transportFromConfig(name: string, config: McpServerConfig, oauthService?: McpOAuthService): MCPTransport {
  if (config.transport === "stdio") {
    if (config.command === undefined) throw new Error(`MCP server "${name}": stdio transport requires "command".`);
    return mcpStdioTransport({
      name,
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
    });
  }
  if (config.url === undefined) throw new Error(`MCP server "${name}": http transport requires "url".`);
  const oauthProvider = resolveOAuthProvider(name, config, oauthService);
  return mcpStreamableHttpTransport({
    name,
    url: config.url,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.bearerTokenEnvVar !== undefined ? { bearerTokenEnvVar: config.bearerTokenEnvVar } : {}),
    ...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
    ...(oauthProvider !== undefined ? { oauthProvider } : {}),
  });
}

function resolveOAuthProvider(name: string, config: McpServerConfig, oauthService?: McpOAuthService): OAuthClientProvider | undefined {
  if (oauthService === undefined) return undefined;
  if (config.transport !== "http") return undefined;
  if (config.bearerTokenEnvVar !== undefined) return undefined;
  if (config.headers !== undefined) return undefined;
  if (config.url === undefined) return undefined;
  if (!oauthService.hasTokens(name, config.url)) return undefined;
  return oauthService.getProvider(name, config.url);
}

function isUnauthorizedLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "UnauthorizedError") return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" && code === 401) return true;
  if (typeof code === "string" && code === "401") return true;
  return /\b401\b/.test(error.message) || /unauthorized/i.test(error.message);
}

interface ControllerOptions {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly oauthService?: McpOAuthService;
  readonly cacheToolsList: boolean;
  readonly transportFactory?: McpTransportFactory;
  readonly onStatusChange?: McpStatusListener;
  readonly reconnectPolicy?: ReconnectPolicy;
  readonly keepAlivePolicy?: KeepAlivePolicy;
  readonly timer: McpTimer;
}

class McpServerController {
  readonly name: string;
  private readonly config: McpServerConfig;
  private readonly oauthService: McpOAuthService | undefined;
  private readonly cacheToolsList: boolean;
  private readonly transportFactory: McpTransportFactory | undefined;
  private readonly onStatusChange: McpStatusListener | undefined;
  private readonly reconnectPolicy: ReconnectPolicy | undefined;
  private readonly keepAlivePolicy: KeepAlivePolicy | undefined;
  private readonly timer: McpTimer;
  private server: TransportMCPServer | undefined;
  private authTool: Tool | undefined;
  private ctx: SessionContext | undefined;
  private _status: McpServerStatus = "pending";
  private _error: string | undefined;
  private reconnectAttempts = 0;
  private reconnectHandle: unknown;
  private keepAliveHandle: unknown;
  private disposed = false;

  constructor(opts: ControllerOptions) {
    this.name = opts.name;
    this.config = opts.config;
    this.oauthService = opts.oauthService;
    this.cacheToolsList = opts.cacheToolsList;
    this.transportFactory = opts.transportFactory;
    this.onStatusChange = opts.onStatusChange;
    this.reconnectPolicy = opts.reconnectPolicy;
    this.keepAlivePolicy = opts.keepAlivePolicy;
    this.timer = opts.timer;
  }

  view(): McpServerView {
    return {
      name: this.name,
      transport: this.config.transport,
      status: this._status,
      ...(this._error !== undefined ? { error: this._error } : {}),
    };
  }

  private setStatus(status: McpServerStatus, error?: string): void {
    if (status === this._status && error === this._error) return;
    this._status = status;
    this._error = error;
    this.onStatusChange?.(this.view());
  }

  async connect(ctx: SessionContext): Promise<void> {
    if (this.disposed) return;
    this.ctx = ctx;
    if (this.config.enabled === false) {
      this.setStatus("disabled");
      return;
    }
    await this.attempt();
  }

  private async attempt(): Promise<McpServerStatus> {
    // Attempts can overlap: a manual reconnect() can fire while an in-flight attempt is still
    // awaiting connect(). Every mutation of the shared `this.server` slot is therefore guarded
    // by identity — an attempt only ever publishes/retracts the server IT created, never a
    // sibling's. Without this, a losing attempt's cleanup would tear down the winner's live
    // connection (and a stale connect() success would leak an orphaned server/child process).
    let server: TransportMCPServer | undefined;
    try {
      server = serverFromConfig(this.name, this.config, {
        ...(this.oauthService !== undefined ? { oauthService: this.oauthService } : {}),
        cacheToolsList: this.cacheToolsList,
        ...(this.transportFactory !== undefined ? { transport: this.transportFactory(this.name, this.config) } : {}),
      });
      const mine = server;
      this.server = mine;
      // Guard the drop callback by identity (mirrors runKeepAlivePing): a stale close from
      // THIS server must not null out a newer server that has since replaced it.
      mine.onUnexpectedClose?.((reason) => {
        if (this.server === mine) this.onDrop(reason);
      });
      await mine.connect();
      if (this.server !== mine) {
        // A newer attempt superseded us mid-connect — don't leak this now-orphaned connection.
        await mine.close().catch(() => undefined);
        return this._status;
      }
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.scheduleKeepAlive();
    } catch (error) {
      // React only if we're still the current attempt; a superseding attempt owns the state.
      const current = this.server === server || this.server === undefined;
      if (current) {
        this.cancelKeepAlive();
        if (this.shouldMarkNeedsAuth(error)) {
          this.setStatus("needs-auth", `${this.name} requires OAuth — call the "${qualifyMcpToolName(this.name, "authenticate")}" tool`);
        } else {
          const tail = server?.stderrSnapshot?.().trimEnd();
          const base = error instanceof Error ? error.message : String(error);
          this.setStatus("failed", tail ? `${base}\nstderr: ${tail}` : base);
          this.emitWarning(`MCP server "${this.name}" failed to connect: ${this._error}`);
        }
      }
      // Close the server WE created (not this.server, which may be a newer winner), and only
      // release the shared slot when it still points at ours.
      await server?.close().catch(() => undefined);
      if (this.server === server) this.server = undefined;
    }
    return this._status;
  }

  async reconnect(): Promise<void> {
    if (this.disposed) throw new Error(`MCP server "${this.name}" has been shut down.`);
    this.cancelScheduledReconnect();
    this.cancelKeepAlive();
    this.reconnectAttempts = 0;
    await this.server?.close().catch(() => undefined);
    this.server = undefined;
    this.setStatus("pending");
    const status = await this.attempt();
    if (status !== "connected") {
      throw new Error(this._error ?? `MCP server "${this.name}" failed to reconnect.`);
    }
  }

  async close(): Promise<void> {
    this.cancelScheduledReconnect();
    this.cancelKeepAlive();
    await this.server?.close().catch(() => undefined);
    this.server = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.close();
  }

  /**
   * What this server offers, for a host that wants to SHOW it rather than call it.
   *
   * Separate from `toolProvider().listTools`, which exists to hand the model runnable
   * tools: that one substitutes an auth tool while a server is stuck on OAuth, and it
   * namespaces every name. This returns the server's own list, unwrapped, and an empty
   * one whenever the server is not connected — a disconnected server has no tools to
   * describe, and asking is not worth an exception.
   */
  async listTools(): Promise<readonly MCPTool[]> {
    if (this._status !== "connected" || this.server === undefined) return [];
    return await this.server.listTools().catch(() => []);
  }

  toolProvider(): ToolProvider {
    return {
      id: `mcp:${this.name}`,
      listTools: async (ctx: CapabilityContext): Promise<readonly Tool[]> => {
        if (this._status === "needs-auth") return [this.authToolInstance()];
        if (this._status !== "connected" || this.server === undefined) return [];
        return mcpToolProvider(this.server).listTools(ctx);
      },
    };
  }

  private shouldMarkNeedsAuth(error: unknown): boolean {
    if (this.oauthService === undefined) return false;
    if (this.config.transport !== "http") return false;
    if (this.config.bearerTokenEnvVar !== undefined) return false;
    if (this.config.headers !== undefined) return false;
    return isUnauthorizedLikeError(error);
  }

  private authToolInstance(): Tool {
    if (this.authTool === undefined) {
      if (this.oauthService === undefined || this.config.url === undefined) {
        throw new Error(`MCP server "${this.name}" is in needs-auth without an OAuth service / url.`);
      }
      this.authTool = createMcpAuthTool({
        serverName: this.name,
        serverUrl: this.config.url,
        oauthService: this.oauthService,
        reconnect: () => this.reconnect(),
      });
    }
    return this.authTool;
  }

  private onDrop(reason: { error?: Error; stderr?: string }): void {
    this.cancelKeepAlive();
    const parts = [`MCP server "${this.name}" closed unexpectedly`];
    if (reason.error !== undefined) parts.push(reason.error.message);
    if (reason.stderr !== undefined && reason.stderr.length > 0) parts.push(`stderr: ${reason.stderr.trimEnd()}`);
    this.setStatus("failed", parts.join("\n"));
    this.emitWarning(this._error);
    this.server = undefined;
    this.scheduleReconnect();
  }

  private scheduleKeepAlive(): void {
    this.cancelKeepAlive();
    const policy = this.keepAlivePolicy;
    if (policy === undefined || this.disposed) return;
    if (this.server === undefined || this._status !== "connected") return;
    this.keepAliveHandle = this.timer.setTimeout(() => {
      this.keepAliveHandle = undefined;
      void this.runKeepAlivePing();
    }, policy.intervalMs);
  }

  private async runKeepAlivePing(): Promise<void> {
    const server = this.server;
    const policy = this.keepAlivePolicy;
    if (this.disposed || policy === undefined || server === undefined || this._status !== "connected") return;

    try {
      await server.ping({ timeoutMs: policy.timeoutMs });
    } catch (error) {
      if (this.disposed || this.server !== server) return;
      const base = error instanceof Error ? error.message : String(error);
      const message = `MCP server "${this.name}" keep-alive ping failed: ${base}`;
      this.setStatus("failed", message);
      this.emitWarning(message);
      await server.close().catch(() => undefined);
      if (this.server === server) this.server = undefined;
      this.scheduleReconnect();
      return;
    }

    if (!this.disposed && this.server === server && this._status === "connected") this.scheduleKeepAlive();
  }

  private cancelKeepAlive(): void {
    if (this.keepAliveHandle !== undefined) {
      this.timer.clearTimeout(this.keepAliveHandle);
      this.keepAliveHandle = undefined;
    }
  }

  private scheduleReconnect(): void {
    const policy = this.reconnectPolicy;
    if (policy === undefined || this.disposed) return;
    if (this.reconnectAttempts >= policy.maxRetries) {
      this.emitWarning(`MCP server "${this.name}" gave up reconnecting after ${policy.maxRetries} attempts.`);
      return;
    }
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.factor ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.cancelScheduledReconnect();
    this.reconnectHandle = this.timer.setTimeout(() => {
      this.reconnectHandle = undefined;
      void this.runScheduledReconnect();
    }, delay);
  }

  private async runScheduledReconnect(): Promise<void> {
    if (this.disposed) return;
    this.setStatus("pending");
    const status = await this.attempt();
    // attempt() resets the counter + clears reconnect on success; on failure, back off again.
    if (status !== "connected" && !this.disposed) this.scheduleReconnect();
  }

  private cancelScheduledReconnect(): void {
    if (this.reconnectHandle !== undefined) {
      this.timer.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
  }

  private emitWarning(message: string | undefined): void {
    if (message === undefined) return;
    this.ctx?.events.emit({ type: "warning", address: "main", sessionId: this.ctx.sessionId, message });
  }
}

export interface McpServersCapabilityOptions {
  readonly oauthService?: McpOAuthService;
  readonly cacheToolsList?: boolean;
  readonly transportFactory?: McpTransportFactory;
  readonly reconnectPolicy?: ReconnectPolicy;
  readonly keepAlive?: KeepAlivePolicy;
  readonly timer?: McpTimer;
}

export interface McpServersHandle {
  list(): readonly McpServerView[];
  /** Tools a connected server exposes. Empty for an unknown or disconnected server. */
  listTools(name: string): Promise<readonly MCPTool[]>;
  reconnect(name: string): Promise<void>;
  onStatusChange(listener: McpStatusListener): () => void;
  shutdown(): Promise<void>;
}

function keepAliveOptions(
  config: McpServerConfig,
  defaults: KeepAlivePolicy | undefined,
): { keepAlivePolicy?: KeepAlivePolicy } {
  const intervalMs = config.keepAliveIntervalMs ?? defaults?.intervalMs;
  if (intervalMs === undefined) return {};
  const timeoutMs = config.keepAliveTimeoutMs ?? defaults?.timeoutMs;
  return { keepAlivePolicy: timeoutMs === undefined ? { intervalMs } : { intervalMs, timeoutMs } };
}

export function mcpServersCapability(
  configs: Record<string, McpServerConfig>,
  options: McpServersCapabilityOptions = {},
): Capability {
  const listeners = new Set<McpStatusListener>();
  const notify: McpStatusListener = (view) => {
    for (const listener of listeners) listener(view);
  };

  const controllers = Object.entries(configs).map(
    ([name, config]) =>
      new McpServerController({
        name,
        config,
        ...(options.oauthService !== undefined ? { oauthService: options.oauthService } : {}),
        cacheToolsList: options.cacheToolsList ?? DEFAULT_CACHE_TOOLS,
        ...(options.transportFactory !== undefined ? { transportFactory: options.transportFactory } : {}),
        ...(options.reconnectPolicy !== undefined ? { reconnectPolicy: options.reconnectPolicy } : {}),
        ...keepAliveOptions(config, options.keepAlive),
        onStatusChange: notify,
        timer: options.timer ?? REAL_TIMER,
      }),
  );
  const byName = new Map(controllers.map((c) => [c.name, c]));
  let shuttingDown: Promise<void> | undefined;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown;
    shuttingDown = (async () => {
      for (const c of [...controllers].reverse()) await c.dispose();
      listeners.clear();
    })();
    return shuttingDown;
  };

  const handle: McpServersHandle = {
    list: () => controllers.map((c) => c.view()),
    listTools: async (name) => (await byName.get(name)?.listTools()) ?? [],
    reconnect: async (name) => {
      const controller = byName.get(name);
      if (controller === undefined) throw new Error(`Unknown MCP server: ${name}`);
      await controller.reconnect();
    },
    onStatusChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shutdown,
  };

  return {
    name: "mcp",
    toolProviders: controllers.map((c) => c.toolProvider()),
    service: handle,
    // Session-tier: connect all servers in parallel, fault-isolated (attempt() never throws).
    openSession: async (ctx: SessionContext) => {
      await Promise.all(controllers.map((c) => c.connect(ctx)));
    },
    closeSession: shutdown,
  };
}
