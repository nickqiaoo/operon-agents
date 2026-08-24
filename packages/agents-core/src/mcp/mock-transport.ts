import type {
  MCPListResourcesResult,
  MCPReadResourceResult,
  MCPTool,
  MCPToolResult,
  MCPTransport,
  MCPCallToolOptions,
  UnexpectedCloseListener,
} from "./types.ts";

export interface MockMCPResource {
  readonly uri: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface MockMCPFixture {
  readonly name?: string;
  readonly tools: readonly MCPTool[];
  readonly call: (toolName: string, args: Record<string, unknown> | null, options?: MCPCallToolOptions) => MCPToolResult | Promise<MCPToolResult>;
  readonly ping?: () => void | Promise<void>;
  readonly resources?: readonly MockMCPResource[];
}

export class MockMCPTransport implements MCPTransport {
  readonly name: string;
  listToolsCalls = 0;
  connectCalls = 0;
  closeCalls = 0;
  pingCalls = 0;

  private readonly fixture: MockMCPFixture;
  private open = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;

  constructor(fixture: MockMCPFixture) {
    this.fixture = fixture;
    this.name = fixture.name ?? "mock";
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.open = true;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.open = false;
  }

  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
  }

  triggerUnexpectedClose(reason: { error?: Error; stderr?: string } = {}): void {
    this.open = false;
    this.unexpectedCloseListener?.(reason);
  }

  async ping(): Promise<void> {
    this.assertOpen();
    this.pingCalls += 1;
    await this.fixture.ping?.();
  }

  async listTools(): Promise<readonly MCPTool[]> {
    this.assertOpen();
    this.listToolsCalls += 1;
    return this.fixture.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown> | null, options?: MCPCallToolOptions): Promise<MCPToolResult> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    return this.fixture.call(toolName, args, options);
  }

  async listResources(): Promise<MCPListResourcesResult> {
    this.assertOpen();
    const resources = (this.fixture.resources ?? []).map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType }));
    return { resources };
  }

  async readResource(uri: string): Promise<MCPReadResourceResult> {
    this.assertOpen();
    const found = (this.fixture.resources ?? []).find((r) => r.uri === uri);
    if (!found) throw new Error(`Mock MCP: resource not found: ${uri}`);
    const content: { uri: string; mimeType?: string; text?: string; blob?: string } = { uri: found.uri };
    if (found.mimeType !== undefined) content.mimeType = found.mimeType;
    if (found.text !== undefined) content.text = found.text;
    if (found.blob !== undefined) content.blob = found.blob;
    return { contents: [content] };
  }

  private assertOpen(): void {
    if (!this.open) throw new Error(`Mock MCP transport "${this.name}" is not connected.`);
  }
}
