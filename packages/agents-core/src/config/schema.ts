import { z } from "zod";

export const ProviderTypeSchema = z.enum([
  "anthropic",
  "openai",
  "kimi",
  "google-genai",
  "openai_responses",
  "vertexai",
]);

export const ProviderOAuthSchema = z.object({
  storage: z.enum(["file", "keyring"]),
  key: z.string(),
  oauthHost: z.string().optional(),
});

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: ProviderOAuthSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  customHeaders: z.record(z.string(), z.string()).optional(),
});

export const ModelAliasSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().positive(),
  maxOutputSize: z.number().int().positive().optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
});

/**
 * Persistent model-provider credentials. A configured path selects Operon's
 * FileCredentialStore; deployments may still inject a different store
 * directly into ProviderManager.
 */
export const ModelCredentialsSchema = z.object({
  path: z.string().trim().min(1),
});

export const PermissionRuleScopeSchema = z.enum(["turn-override", "session-runtime", "project", "user"]);

export const PermissionRuleConfigSchema = z.object({
  decision: z.enum(["allow", "deny", "ask"]),
  scope: PermissionRuleScopeSchema,
  pattern: z.string(),
  reason: z.string().optional(),
});

// `auto`-mode judge tuning: extra allow/deny/environment sections injected into the classifier
// prompt (user values replace the template defaults), plus which classifier stages to run.
export const AutoApprovalConfigSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  environment: z.array(z.string()).default([]),
  twoStageMode: z.enum(["both", "fast", "thinking"]).optional(),
});

export const PermissionConfigSchema = z.object({
  mode: z.enum(["manual", "workspace", "yolo", "auto"]).optional(),
  rules: z.array(PermissionRuleConfigSchema).default([]),
  autoApproval: AutoApprovalConfigSchema.optional(),
});

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().positive().optional(),
  maxRetriesPerStep: z.number().int().nonnegative().optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const ThinkingConfigSchema = z.object({
  mode: z.enum(["auto", "on", "off"]),
  effort: z.enum(["low", "medium", "high"]).optional(),
});

export const McpServerConfigSchema = z.object({
  // spelling. Accept both, but normalise output to `transport`.
  type: z.enum(["stdio", "http"]).optional(),
  transport: z.enum(["stdio", "http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  blockedTools: z.array(z.string()).optional(),
  // env, and opt-in keep-alive ping.
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1).optional(),
  toolTimeoutMs: z.number().int().min(1).optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  keepAliveIntervalMs: z.number().int().min(1).optional(),
  keepAliveTimeoutMs: z.number().int().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.type !== undefined && value.transport !== undefined && value.type !== value.transport) {
    ctx.addIssue({
      code: "custom",
      path: ["transport"],
      message: '`transport` must match `type` when both are provided',
    });
  }
}).transform(({ type, transport, ...rest }) => ({
  ...rest,
  transport: transport ?? type ?? "stdio",
}));

export const HookDefConfigSchema = z.object({
  event: z.string(),
  matcher: z.string().optional(),
  command: z.string(),
  timeout: z.number().int().positive().optional(),
});

export const PluginRefSchema = z.object({
  source: z.enum(["local-path", "zip-url", "github"]),
  ref: z.string(),
  enabled: z.boolean().default(true),
});

export const AgentFrameworkConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  models: z.record(z.string(), ModelAliasSchema).default({}),
  defaultModel: z.string().optional(),
  modelCredentials: ModelCredentialsSchema.optional(),
  permission: PermissionConfigSchema.default({ rules: [] }),
  loopControl: LoopControlSchema.default({}),
  thinking: ThinkingConfigSchema.optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
  hooks: z.array(HookDefConfigSchema).default([]),
  plugins: z.array(PluginRefSchema).default([]),
  // Plugin marketplace registries (https/file URLs or local paths) to browse for installable
  // plugins. The framework provides the loader; the product/UI chooses the registries.
  pluginMarketplaces: z.array(z.string()).default([]),
  flags: z.record(z.string(), z.boolean()).default({}),
});

export type ProviderType = z.infer<typeof ProviderTypeSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelAlias = z.infer<typeof ModelAliasSchema>;
export type ModelCredentialsConfig = z.infer<typeof ModelCredentialsSchema>;
export type PermissionRuleScope = z.infer<typeof PermissionRuleScopeSchema>;
export type PermissionRuleConfig = z.infer<typeof PermissionRuleConfigSchema>;
export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;
export type LoopControl = z.infer<typeof LoopControlSchema>;
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type HookDefConfig = z.infer<typeof HookDefConfigSchema>;
export type PluginRef = z.infer<typeof PluginRefSchema>;
export type AgentFrameworkConfig = z.infer<typeof AgentFrameworkConfigSchema>;

export function parseConfig(input: unknown): AgentFrameworkConfig {
  return AgentFrameworkConfigSchema.parse(input ?? {});
}
