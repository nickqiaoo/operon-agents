export * as protocol from "./protocol/index.ts";
export type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ToolCall,
  TextContent,
  ImageContent,
  Usage,
  Context,
  Model,
  Api,
  KnownApi,
  Provider,
  KnownProvider,
  ThinkingLevel,
  ToolSchema,
  PiTool,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "./protocol/index.ts";
export * from "./llm/index.ts";
export * from "./tool/index.ts";
export * from "./loop/index.ts";
export * from "./permission/index.ts";
export * from "./events/index.ts";
export * from "./store/index.ts";
export * from "./logging/index.ts";
export * from "./net/index.ts";
export * from "./tracing/index.ts";
export * from "./agent/index.ts";
export * from "./capabilities/index.ts";
export * from "./config/index.ts";
export * from "./commands/index.ts";
// Plugin marketplace loader (stateless utility) + the plugin manager/capability, exposed so an
// embedder (e.g. operon) can run a single global PluginManager and wire it into its harnesses.
export {
  loadMarketplace,
  parseMarketplace,
  loadMarketplaceEntryDetails,
  parseGithubMarketplaceSource,
  materializeGithubRepo,
} from "./plugins/marketplace.ts";
export type {
  Marketplace,
  MarketplaceEntry,
  LoadMarketplaceOptions,
  MarketplaceEntryDetails,
} from "./plugins/marketplace.ts";
export {
  PluginManager,
  pluginsCapability,
  parseHooksDocument,
  hookDefsFromConfig,
} from "./plugins/index.ts";
export type {
  PluginManagerOptions,
  SessionStartSkillResolver,
  PluginSummary,
  PluginInfo,
  PluginSource,
  ParsedPluginHooks,
} from "./plugins/index.ts";
// The per-workspace MCP capability, exposed so `defaultCapabilities` can build it from
// workspace + plugin servers (it lives under the ./mcp subtree, not the main capabilities barrel).
export { mcpServersCapability, McpOAuthService, JsonFileStore, MemoryMcpCredentialStore } from "./mcp/index.ts";
export type { McpServersCapabilityOptions, McpOAuthServiceOptions, McpCredentialStore } from "./mcp/index.ts";
