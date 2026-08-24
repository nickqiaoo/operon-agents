export {
  AgentFrameworkConfigSchema,
  ModelCredentialsSchema,
  ModelAliasSchema,
  McpServerConfigSchema,
  PermissionRuleConfigSchema,
  ProviderConfigSchema,
  parseConfig,
} from "./schema.ts";
export type {
  AgentFrameworkConfig,
  HookDefConfig,
  LoopControl,
  McpServerConfig,
  ModelAlias,
  ModelCredentialsConfig,
  PermissionConfig,
  PermissionRuleConfig,
  PluginRef,
  ProviderConfig,
  ProviderType,
  ThinkingConfig,
} from "./schema.ts";

export { mergeConfigs } from "./merge.ts";
export { ModelCatalog } from "./model-catalog.ts";
export type { ModelCapabilityInfo } from "./model-catalog.ts";
export { ProviderManager } from "./provider-manager.ts";
export type {
  ResolvedModel,
  ResolvableAlias,
  ApiKeyResolver,
  ProviderManagerConfig,
  ProviderManagerOptions,
} from "./provider-manager.ts";
export { Flags, FLAG_DEFINITIONS } from "./flags.ts";
export type { FlagDefinition } from "./flags.ts";
export {
  objectResolver,
  layeredResolver,
  toCoreOptions,
  resolveCoreOptions,
} from "./resolver.ts";
export type { AutoApprovalOptions, ConfigResolver, CoreOptions } from "./resolver.ts";
export { resolveConfigLayers } from "./paths.ts";
export type { ConfigTier, ConfigLayer, ConfigLayerOptions, ConfigLayerPaths } from "./paths.ts";
export {
  tomlFormat,
  jsonFormat,
  ConfigError,
  formatConfigError,
  loadConfigFile,
  resolveFromFiles,
  fileResolver,
} from "./file-source.ts";
export type { ConfigFormat, FileResolverOptions, ResolvedLayer, ResolvedFromFiles } from "./file-source.ts";
export { ConfigStore } from "./config-store.ts";
