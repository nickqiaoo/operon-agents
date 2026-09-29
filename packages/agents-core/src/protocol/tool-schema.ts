export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * Withheld by the provider until its own server-side tool search reveals it
   * (`ChatModel.serverToolSearch`). Only the request's top-level list carries it.
   */
  readonly deferLoading?: boolean;
}
