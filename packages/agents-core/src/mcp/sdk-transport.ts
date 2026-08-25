import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  MCPCallToolOptions,
  MCPListResourcesResult,
  MCPPingOptions,
  MCPReadResourceResult,
  MCPTool,
  MCPToolResult,
  MCPTransport,
  UnexpectedCloseListener,
  UnexpectedCloseReason,
} from "./types.ts";

const CLIENT_INFO = { name: "agent-framework-mcp", version: "0.0.0" };

const STDERR_BUFFER_CAPACITY = 4 * 1024;

interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface SdkClient {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  ping(options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
  listTools(): Promise<{ tools: MCPTool[] }>;
  callTool(
    params: CallToolParams,
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<MCPToolResult>;
  listResources(params?: { cursor?: string }): Promise<MCPListResourcesResult>;
  readResource(params: { uri: string }): Promise<MCPReadResourceResult>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
}

interface SdkTransportConfig {
  readonly name: string;
  readonly makeSdkTransport: () => unknown;
  readonly toolTimeoutMs?: number;
  readonly captureStderr: boolean;
  readonly isTerminalError?: (error: Error) => boolean;
}

class SdkMcpTransport implements MCPTransport {
  readonly name: string;
  private readonly cfg: SdkTransportConfig;

  private client: SdkClient | undefined;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  // Flips true only after `connect()` resolves AND the caller has not torn down mid-startup;
  // the hooks gate on it so a handshake-phase death rides `connect()` rejecting instead.
  private ready = false;
  private hooksInstalled = false;
  private listener: UnexpectedCloseListener | undefined;
  private lastError: Error | undefined;
  // Buffered when the transport drops before a listener registers; replayed on registration.
  private pending: UnexpectedCloseReason | undefined;
  // Latch so `onerror` + `onclose` for the same failure don't double-fire the listener.
  private fired = false;

  constructor(cfg: SdkTransportConfig) {
    this.name = cfg.name;
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error(`MCP transport "${this.name}" is closed.`);
    if (this.started) return;
    this.started = true;

    const sdkTransport = this.cfg.makeSdkTransport();
    if (this.cfg.captureStderr) this.attachStderr(sdkTransport);

    const client = new Client(CLIENT_INFO, { capabilities: {} }) as unknown as SdkClient;
    this.client = client;
    // Hooks BEFORE the handshake so an onclose firing between handshake completion and our
    // wiring is never lost; the hooks themselves gate on `ready`.
    this.installHooks(client);
    try {
      await client.connect(sdkTransport);
    } catch (error) {
      await this.closeStarted();
      throw error;
    }
    if (this.closed) {
      await this.closeStarted();
      throw new Error(`MCP transport "${this.name}" was closed during startup.`);
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStarted();
  }

  async listTools(): Promise<readonly MCPTool[]> {
    const res = await this.requireClient().listTools();
    return res.tools;
  }

  async ping(options?: MCPPingOptions): Promise<void> {
    await this.requireClient().ping(buildRequestOptions(options?.timeoutMs, options?.signal));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    options?: MCPCallToolOptions,
  ): Promise<MCPToolResult> {
    // `arguments` and `_meta` are `.optional()` in the MCP schemas, which rejects an explicit
    // `null`. Sending one makes the server fail JSON-RPC validation (-32700 parse error) before
    // the tool ever runs, so omit the keys entirely instead.
    const params: CallToolParams = { name: toolName };
    if (args !== null) params.arguments = args;
    if (options?.meta != null) params._meta = options.meta;
    return this.requireClient().callTool(
      params,
      undefined,
      buildRequestOptions(this.cfg.toolTimeoutMs, options?.signal),
    );
  }

  async listResources(params?: { cursor?: string }): Promise<MCPListResourcesResult> {
    return this.requireClient().listResources(params);
  }

  async readResource(uri: string): Promise<MCPReadResourceResult> {
    return this.requireClient().readResource({ uri });
  }

  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.listener = listener;
    const pending = this.pending;
    if (pending !== undefined) {
      this.pending = undefined;
      listener(pending);
    }
  }

  stderrSnapshot(): string {
    return this.stderrBuffer.snapshot();
  }

  private requireClient(): SdkClient {
    if (!this.client) throw new Error(`MCP transport "${this.name}" is not connected.`);
    return this.client;
  }

  private async closeStarted(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const c = this.client;
    this.client = undefined;
    await c?.close();
  }

  private attachStderr(sdkTransport: unknown): void {
    // `stderr:'pipe'` returns a PassThrough immediately (SDK), so this drain is wired before
    // the child spawns. We MUST drain it — an undrained full pipe can block the child.
    const stderr = (sdkTransport as { stderr?: NodeJS.ReadableStream | null }).stderr;
    stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrBuffer.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
  }

  private installHooks(client: SdkClient): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    client.onclose = () => {
      if (this.closed) return; // intentional close
      if (!this.ready) return; // handshake-phase death → connect() rejects
      const stderr = this.stderrBuffer.snapshot();
      this.fireUnexpectedClose({ error: this.lastError, stderr: stderr.length > 0 ? stderr : undefined });
    };
    client.onerror = (error: Error) => {
      // Errors are informational on their own; `onclose` is what says the transport is gone.
      // For http there is no onclose for remote drops, so a terminal error stands in.
      this.lastError = error;
      if (this.closed) return;
      if (!this.ready) return;
      if (this.cfg.isTerminalError?.(error)) this.fireUnexpectedClose({ error });
    };
  }

  private fireUnexpectedClose(reason: UnexpectedCloseReason): void {
    if (this.fired) return;
    this.fired = true;
    if (this.listener !== undefined) this.listener(reason);
    else this.pending = reason;
  }
}

class BoundedTail {
  private buffer = "";
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
  }
  snapshot(): string {
    return this.buffer;
  }
}

function buildRequestOptions(
  toolTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): { signal?: AbortSignal; timeout?: number } | undefined {
  if (toolTimeoutMs === undefined && signal === undefined) return undefined;
  const out: { signal?: AbortSignal; timeout?: number } = {};
  if (toolTimeoutMs !== undefined) out.timeout = toolTimeoutMs;
  if (signal !== undefined) out.signal = signal;
  return out;
}

export interface MCPStdioConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly toolTimeoutMs?: number;
}

export function mcpStdioTransport(config: MCPStdioConfig): MCPTransport {
  return new SdkMcpTransport({
    name: config.name,
    captureStderr: true,
    ...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
    makeSdkTransport: () =>
      new StdioClientTransport({
        command: config.command,
        ...(config.args !== undefined ? { args: [...config.args] } : {}),
        env: mergeStdioEnv(config.env),
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        stderr: "pipe",
      }),
  });
}

export function mergeStdioEnv(configEnv?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  if (configEnv !== undefined) Object.assign(merged, configEnv);
  return merged;
}

export interface MCPHttpConfig {
  readonly name: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly bearerTokenEnvVar?: string;
  readonly toolTimeoutMs?: number;
  readonly oauthProvider?: OAuthClientProvider;
  readonly envLookup?: (name: string) => string | undefined;
}

export function mcpStreamableHttpTransport(config: MCPHttpConfig): MCPTransport {
  const envLookup = config.envLookup ?? ((name) => process.env[name]);
  const headers = buildMcpHttpHeaders(config, envLookup);
  return new SdkMcpTransport({
    name: config.name,
    captureStderr: false,
    isTerminalError: isTerminalTransportError,
    ...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
    makeSdkTransport: () =>
      new StreamableHTTPClientTransport(new URL(config.url), {
        ...(headers !== undefined ? { requestInit: { headers } } : {}),
        ...(config.oauthProvider !== undefined ? { authProvider: config.oauthProvider } : {}),
      }),
  });
}

export function isTerminalTransportError(error: Error): boolean {
  if (error.name === "UnauthorizedError") return true;
  if (/Maximum reconnection attempts/i.test(error.message)) return true;
  return false;
}

export function buildMcpHttpHeaders(
  config: MCPHttpConfig,
  envLookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...config.headers };
  if (config.bearerTokenEnvVar !== undefined) {
    const token = envLookup(config.bearerTokenEnvVar);
    if (token === undefined || token.length === 0) {
      throw new Error(`MCP HTTP bearer token env var "${config.bearerTokenEnvVar}" is not set or is empty.`);
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") delete headers[key];
    }
    headers["Authorization"] = `Bearer ${token}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
