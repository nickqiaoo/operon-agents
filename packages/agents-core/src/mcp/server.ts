import type { MCPListResourcesResult, MCPReadResourceResult, MCPTool, MCPToolResult, MCPTransport, MCPCallToolOptions, MCPPingOptions, UnexpectedCloseListener, UnexpectedCloseReason } from "./types.ts";
import type { MCPToolFilter } from "./filter.ts";

export type MCPToolErrorFunction = (args: { error: unknown; toolName: string; serverName: string }) => string | Promise<string>;

export interface MCPServer {
  readonly name: string;
  cacheToolsList: boolean;
  toolFilter?: MCPToolFilter;
  errorFunction?: MCPToolErrorFunction | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  ping(options?: MCPPingOptions): Promise<void>;
  listTools(): Promise<readonly MCPTool[]>;
  callTool(toolName: string, args: Record<string, unknown> | null, options?: MCPCallToolOptions): Promise<MCPToolResult>;
  invalidateToolsCache(): Promise<void>;
  readonly connected: boolean;
  onUnexpectedClose?(listener: UnexpectedCloseListener): void;
  stderrSnapshot?(): string;
}

export interface MCPServerWithResources extends MCPServer {
  listResources(params?: { cursor?: string }): Promise<MCPListResourcesResult>;
  readResource(uri: string): Promise<MCPReadResourceResult>;
}

export interface MCPServerOptions {
  readonly name: string;
  readonly transport: MCPTransport;
  /**
   * Cache the tool list instead of re-listing on every use. Default true, matching
   * `serverFromConfig`/`mcpServersCapability` (the path real deployments load servers
   * through): the toolset is rebuilt once per turn, so an uncached server pays a round trip
   * per turn in the critical path ahead of the model request.
   *
   * Refresh is manual — `invalidateToolsCache()`. Nothing listens for
   * `notifications/tools/list_changed` yet, so a server that adds tools mid-session needs
   * that call (or `cacheToolsList: false`) to be noticed.
   */
  readonly cacheToolsList?: boolean;
  readonly toolFilter?: MCPToolFilter;
  readonly errorFunction?: MCPToolErrorFunction | null;
  readonly startupTimeoutMs?: number;
}

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;

export function hasResources(server: MCPServer): server is MCPServerWithResources {
  const t = server as Partial<MCPServerWithResources>;
  return typeof t.listResources === "function" && typeof t.readResource === "function";
}

export class TransportMCPServer implements MCPServerWithResources {
  readonly name: string;
  cacheToolsList: boolean;
  toolFilter?: MCPToolFilter;
  errorFunction?: MCPToolErrorFunction | null;

  private readonly transport: MCPTransport;
  private readonly startupTimeoutMs: number;
  private cachedTools: readonly MCPTool[] | undefined;
  private isConnected = false;
  private readonly closeListeners = new Set<UnexpectedCloseListener>();
  private transportWatchInstalled = false;

  constructor(options: MCPServerOptions) {
    this.name = options.name;
    this.transport = options.transport;
    this.cacheToolsList = options.cacheToolsList ?? true;
    this.toolFilter = options.toolFilter;
    this.errorFunction = options.errorFunction;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    // Own the transport's single close listener and re-broadcast: a self-drop flips us to
    // disconnected (so `listTools` throws → tools absent) AND notifies the capability.
    if (!this.transportWatchInstalled && this.transport.onUnexpectedClose) {
      this.transportWatchInstalled = true;
      this.transport.onUnexpectedClose((reason) => this.onTransportDrop(reason));
    }
    // Bound the handshake: a hung connect must machine as a failure, not stall the session.
    await withTimeout(this.transport.connect(), this.startupTimeoutMs, this.name, () => {
      void this.transport.close().catch(() => undefined);
    });
    this.isConnected = true;
  }

  private onTransportDrop(reason: UnexpectedCloseReason): void {
    this.isConnected = false;
    this.cachedTools = undefined;
    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch {
        // a subscriber fault must not break the drop fan-out
      }
    }
  }

  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.closeListeners.add(listener);
  }

  stderrSnapshot(): string {
    return this.transport.stderrSnapshot?.() ?? "";
  }

  async close(): Promise<void> {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.cachedTools = undefined;
    await this.transport.close();
  }

  async ping(options?: MCPPingOptions): Promise<void> {
    if (!this.isConnected) throw new Error(`MCP server "${this.name}" is not connected.`);
    if (!this.transport.ping) return;
    await this.transport.ping(options);
  }

  async listTools(): Promise<readonly MCPTool[]> {
    if (!this.isConnected) throw new Error(`MCP server "${this.name}" is not connected.`);
    if (this.cacheToolsList && this.cachedTools !== undefined) return this.cachedTools;
    const tools = await this.transport.listTools();
    if (this.cacheToolsList) this.cachedTools = tools;
    return tools;
  }

  async callTool(toolName: string, args: Record<string, unknown> | null, options?: MCPCallToolOptions): Promise<MCPToolResult> {
    if (!this.isConnected) throw new Error(`MCP server "${this.name}" is not connected.`);
    return this.transport.callTool(toolName, args, options);
  }

  async invalidateToolsCache(): Promise<void> {
    this.cachedTools = undefined;
  }

  async listResources(params?: { cursor?: string }): Promise<MCPListResourcesResult> {
    if (!this.transport.listResources) throw new Error(`MCP server "${this.name}" does not expose resources.`);
    return this.transport.listResources(params);
  }

  async readResource(uri: string): Promise<MCPReadResourceResult> {
    if (!this.transport.readResource) throw new Error(`MCP server "${this.name}" does not expose resources.`);
    return this.transport.readResource(uri);
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`MCP server "${label}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
