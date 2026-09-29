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

// A pre-registered OAuth client for an MCP server (Codex `.mcp.json` `oauth` block). When set, the
// login flow uses this client instead of dynamic client registration — for providers that don't
// support DCR (GitHub, Slack) and publish a public client for local agents.
export const McpOAuthClientConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  // Fixed loopback port for the callback listener (the provider registered it). Random when unset.
  callbackPort: z.number().int().min(1).max(65535).optional(),
  // Exact redirect URI the provider registered; its port and path drive the callback listener.
  callbackUrl: z.string().url().optional(),
});

// Codex writes `.mcp.json` in snake_case (`bearer_token_env_var`, `oauth.client_id`, …). Rename
// those keys to the camelCase config spelling before validation so a plugin's server config keeps
// them instead of having zod strip them as unknown keys.
const MCP_SNAKE_CASE_KEYS: Readonly<Record<string, string>> = {
  bearer_token_env_var: "bearerTokenEnvVar",
  allowed_tools: "allowedTools",
  blocked_tools: "blockedTools",
  startup_timeout_ms: "startupTimeoutMs",
  tool_timeout_ms: "toolTimeoutMs",
};
const MCP_OAUTH_SNAKE_CASE_KEYS: Readonly<Record<string, string>> = {
  client_id: "clientId",
  client_secret: "clientSecret",
  callback_port: "callbackPort",
  callback_url: "callbackUrl",
};

function renameKeys(value: Record<string, unknown>, keys: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const renamed = keys[key];
    // An explicit camelCase key wins over its snake_case twin.
    if (renamed !== undefined && renamed in value) continue;
    out[renamed ?? key] = v;
  }
  return out;
}

function normalizeMcpServerKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out = renameKeys(value as Record<string, unknown>, MCP_SNAKE_CASE_KEYS);
  const oauth = out["oauth"];
  if (typeof oauth === "object" && oauth !== null && !Array.isArray(oauth)) {
    out["oauth"] = renameKeys(oauth as Record<string, unknown>, MCP_OAUTH_SNAKE_CASE_KEYS);
  }
  return out;
}

const McpServerConfigObjectSchema = z.object({
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
  oauth: McpOAuthClientConfigSchema.optional(),
  // OAuth scopes to request. Overrides what the server's protected-resource metadata advertises.
  scopes: z.array(z.string().min(1)).optional(),
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

export const McpServerConfigSchema = z.preprocess(normalizeMcpServerKeys, McpServerConfigObjectSchema);

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
export type McpOAuthClientConfig = z.infer<typeof McpOAuthClientConfigSchema>;
export type HookDefConfig = z.infer<typeof HookDefConfigSchema>;
export type PluginRef = z.infer<typeof PluginRefSchema>;
export type AgentFrameworkConfig = z.infer<typeof AgentFrameworkConfigSchema>;

export function parseConfig(input: unknown): AgentFrameworkConfig {
  return AgentFrameworkConfigSchema.parse(input ?? {});
}
