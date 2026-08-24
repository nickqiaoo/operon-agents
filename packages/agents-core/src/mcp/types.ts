export interface MCPTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface MCPContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly resource?: {
    readonly uri?: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly blob?: string;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface MCPToolResult {
  readonly content: readonly MCPContentBlock[];
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface MCPResource {
  readonly uri: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly [key: string]: unknown;
}

export interface MCPListResourcesResult {
  readonly resources: readonly MCPResource[];
  readonly nextCursor?: string;
}

export interface MCPResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface MCPReadResourceResult {
  readonly contents: readonly MCPResourceContent[];
}

export interface MCPCallToolOptions {
  readonly signal?: AbortSignal;
  readonly meta?: Record<string, unknown> | null;
}

export interface MCPPingOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

export interface MCPTransport {
  readonly name: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  ping?(options?: MCPPingOptions): Promise<void>;
  listTools(): Promise<readonly MCPTool[]>;
  callTool(toolName: string, args: Record<string, unknown> | null, options?: MCPCallToolOptions): Promise<MCPToolResult>;
  listResources?(params?: { cursor?: string }): Promise<MCPListResourcesResult>;
  readResource?(uri: string): Promise<MCPReadResourceResult>;
  onUnexpectedClose?(listener: UnexpectedCloseListener): void;
  stderrSnapshot?(): string;
}
