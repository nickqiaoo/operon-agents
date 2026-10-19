export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * JSON Schema of the tool's machine-readable result ({@link ToolResult.structured}), when it
   * has one (an MCP tool that declares `outputSchema`). Never sent to the model: it is the
   * contract for a program calling the tool (Code Mode), which receives the value instead of text.
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}
