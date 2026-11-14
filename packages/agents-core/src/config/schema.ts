import { z } from "zod";

export const PermissionRuleScopeSchema = z.enum(["turn-override", "session-runtime", "project", "user"]);

export const PermissionRuleConfigSchema = z.object({
  decision: z.enum(["allow", "deny", "ask"]),
  scope: PermissionRuleScopeSchema,
  pattern: z.string(),
  reason: z.string().optional(),
});

// `auto`-mode judge tuning: the classifier's rule sections (each one, when set, replaces the
// built-in list — a `"$defaults"` entry splices the built-in list back in), plus which classifier
// stages to run. Honoured from the user tier only: the project and local tiers live in the
// repository, and a repository must not get to tell the judge what is safe (see resolveFromFiles).
export const AutoApprovalConfigSchema = z.object({
  allow: z.array(z.string()).default([]),
  softDeny: z.array(z.string()).default([]),
  hardDeny: z.array(z.string()).default([]),
  /** @deprecated read as `softDeny`. */
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
  // Hosts and other agents' config formats offer a separate "sse" type; here every URL-based
  // server goes through the one http transport.
  for (const key of ["type", "transport"]) {
    if (out[key] === "sse") out[key] = "http";
  }
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
  // A bare `{ url }` can only be a network server; everything else keeps the stdio default.
  transport: transport ?? type ?? (rest.command === undefined && rest.url !== undefined ? "http" : "stdio"),
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

// ── Session-overridable pieces shared by the harness file and `SessionConfig` ──────────────

/** `false` turns skills off for the session; an object is handed to the skills capability. */
export const SkillsConfigSchema = z.union([
  z.literal(false),
  z.strictObject({ roots: z.array(z.string()).optional(), includeDefaultRoots: z.boolean().optional() }),
]);

/** `false` turns subagents (and the Agent/Workflow tools) off for the session. */
export const SubagentsConfigSchema = z.union([
  z.literal(false),
  z.strictObject({ workflowTool: z.boolean().optional(), maxConcurrent: z.number().int().positive().optional() }),
]);

/**
 * What no session configuration can override: the host's statement about every session it opens.
 * Lives on the harness (`HarnessConfig.policy`), never on a session.
 */
export const SessionPolicySchema = z.strictObject({
  /** Every session is one tenant's among many: nothing process-shared reaches it, MCP over http only,
   *  and it must bring its own environment. */
  strictIsolation: z.boolean().optional(),
  allowedMcpTransports: z.array(z.enum(["stdio", "http"])).optional(),
  /** Let a session's stored configuration carry inline MCP secrets (`headers`, `env`,
   *  `oauth.clientSecret`). Off by default; ignored under `strictIsolation`. */
  allowInlineMcpSecrets: z.boolean().optional(),
  permission: z
    .strictObject({
      /** Modes a session may run in. A mode outside the list is refused, never downgraded. */
      allowedModes: z.array(z.enum(["manual", "workspace", "yolo", "auto"])).optional(),
      /** Rules in force for every session, appended after the session's own. */
      rules: z.array(PermissionRuleConfigSchema).optional(),
    })
    .optional(),
});

export const AgentFrameworkConfigSchema = z.object({
  /** Default model for sessions that name none: a `provider/model` id. */
  model: z.string().min(1).optional(),
  /** Name of a registered agent sessions run by default. */
  agent: z.string().min(1).optional(),
  /** Names of the registered tools the default agent may draw on by default (see `SessionConfig.tools`). */
  tools: z.array(z.string().min(1)).optional(),
  appendSystemPrompt: z.string().optional(),
  /** Per-extension session parameters by extension id; `false` skips that extension. */
  extensions: z.record(z.string(), z.unknown()).optional(),
  skills: SkillsConfigSchema.optional(),
  subagents: SubagentsConfigSchema.optional(),
  policy: SessionPolicySchema.optional(),
  eventPublication: z.enum(["immediate", "committed"]).optional(),
  /** Default working directory for new sessions. */
  workDir: z.string().min(1).optional(),
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
export type SessionPolicy = z.infer<typeof SessionPolicySchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
export type SubagentsConfig = z.infer<typeof SubagentsConfigSchema>;

export function parseConfig(input: unknown): AgentFrameworkConfig {
  return AgentFrameworkConfigSchema.parse(input ?? {});
}
