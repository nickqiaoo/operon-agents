/**
 * The two serializable configurations a harness runs on, and how they combine.
 *
 * - `SessionConfig` — one session's setup: model, tool names, MCP servers, permission, extension
 *   parameters, limits. Every field is optional and carries NO default, so "not given" (inherit the
 *   harness's value), `false` (off) and an empty collection (none) stay three different things.
 * - `HarnessConfig` — the process's configuration. It embeds a `SessionConfig` as the defaults every
 *   session starts from, a `SessionPolicy` no session can override, and the process-only settings.
 *   This is what a `config.toml` describes: `normalizeHarnessConfig` turns the flat file shape into
 *   it, and a host that keeps configuration in a database or builds it in code produces the same
 *   object and hands it to the same `createHarness`.
 *
 * Two different rules combine configuration, at two different levels:
 *
 * - Several SOURCES of harness configuration (the user / project / local files) MERGE into one
 *   `HarnessConfig` — `mergeConfigs`, before the harness ever sees it.
 * - A session's configuration REPLACES the harness defaults field by field — `resolveSessionConfig`.
 *   Nothing deep-merges; a host that wants a union builds it and passes the result.
 */
import { z } from "zod";
import type { ThinkingLevel } from "../llm/model.ts";
import { ConfigError, type FileResolverOptions, formatConfigError, resolveFromFiles } from "./file-source.ts";
import {
  type AgentFrameworkConfig,
  HookDefConfigSchema,
  McpServerConfigSchema,
  type PluginRef,
  PermissionRuleConfigSchema,
  type SessionPolicy,
  SkillsConfigSchema,
  SubagentsConfigSchema,
  parseConfig,
} from "./schema.ts";

/** `false` gives the session no MCP at all; `servers` is the COMPLETE set it sees — not an overlay. */
export const SessionMcpConfigSchema = z.union([
  z.literal(false),
  z.strictObject({ servers: z.record(z.string(), McpServerConfigSchema) }),
]);

export const SessionPermissionConfigSchema = z.strictObject({
  mode: z.enum(["manual", "workspace", "yolo", "auto"]).optional(),
  autoApproval: z.strictObject({
    allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional(),
    environment: z.array(z.string()).optional(), twoStageMode: z.enum(["both", "fast", "thinking"]).optional(),
  }).optional(),
  rules: z.array(PermissionRuleConfigSchema).optional(),
});

export const SessionLimitsSchema = z.strictObject({
  maxTurns: z.number().int().positive().optional(),
  maxStepsPerTurn: z.number().int().positive().optional(),
});

/** One session's setup. Strict: an unknown key is an error, never silently dropped. */
export const SessionConfigSchema = z.strictObject({
  /** `provider/model` id. */
  model: z.string().min(1).optional(),
  /** How the default agent's model behaves (`maxTokens`, `temperature`, `reasoning`, …). */
  modelSettings: z.record(z.string(), z.unknown()).optional(),
  thinking: z.string().min(1).optional(),
  /** Name of an agent registered on the harness. Omitted: the builtin default profile. */
  agent: z.string().min(1).optional(),
  /** Names of the registered tools the default agent may draw on. Its profile lists the tools it
   *  uses by name and those names resolve against this set, so naming fewer narrows the agent; a
   *  tool the profile does not list is not added by naming it here. */
  tools: z.array(z.string().min(1)).optional(),
  appendSystemPrompt: z.string().optional(),
  mcp: SessionMcpConfigSchema.optional(),
  skills: SkillsConfigSchema.optional(),
  hooks: z.array(HookDefConfigSchema).optional(),
  permission: SessionPermissionConfigSchema.optional(),
  /** Per-extension parameters by extension id; `false` skips that extension for this session. */
  extensions: z.record(z.string(), z.unknown()).optional(),
  subagents: SubagentsConfigSchema.optional(),
  limits: SessionLimitsSchema.optional(),
});

type ParsedSessionConfig = z.output<typeof SessionConfigSchema>;
export type SessionMcpConfig = z.output<typeof SessionMcpConfigSchema>;
export type SessionPermissionConfig = z.output<typeof SessionPermissionConfigSchema>;
export type SessionLimits = z.output<typeof SessionLimitsSchema>;
export interface SessionConfig extends Omit<ParsedSessionConfig, "thinking"> {
  readonly thinking?: ThinkingLevel;
}

/** The process's configuration: what a `config.toml` describes. */
export interface HarnessConfig {
  /** What every session starts from. A session replaces these field by field. */
  readonly defaults: SessionConfig;
  /** What no session can override. */
  readonly policy?: SessionPolicy;
  readonly plugins?: readonly PluginRef[];
  readonly pluginMarketplaces?: readonly string[];
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly eventPublication?: "immediate" | "committed";
  /** Default working directory for new sessions. */
  readonly workDir?: string;
}

/** Validate a session configuration from any source (code, RPC, a database row). */
export function parseSessionConfig(input: unknown, where?: string): SessionConfig {
  const result = SessionConfigSchema.safeParse(input ?? {});
  if (result.success) return result.data as SessionConfig;
  throw formatConfigError(result.error, where ?? "session config");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function keyed<T extends Record<string, unknown>>(base: T | undefined, over: T | undefined): T | undefined {
  if (base === undefined && over === undefined) return undefined;
  return defined({ ...(base ?? {}), ...defined(over ?? {}) } as T);
}

/**
 * The configuration a session runs on: `explicit` over `defaults`. A field the session gives wins
 * whole — collections (`tools`, `hooks`, `mcp.servers`, `permission.rules`) are replaced, never
 * concatenated. Three sections are settings rather than collections and are overridden one key at a
 * time: `permission` (`mode` and `rules` separately), `limits`, and `extensions` (per extension id).
 */
export function resolveSessionConfig(defaults: SessionConfig, explicit: SessionConfig): SessionConfig {
  const subagents =
    explicit.subagents === false
      ? false
      : explicit.subagents === undefined
        ? defaults.subagents
        : keyed(defaults.subagents === false ? undefined : defaults.subagents, explicit.subagents);
  return defined({
    ...defaults,
    ...defined({ ...explicit }),
    permission: keyed(defaults.permission, explicit.permission),
    limits: keyed(defaults.limits, explicit.limits),
    extensions: keyed(defaults.extensions, explicit.extensions),
    subagents,
  }) as SessionConfig;
}

/** `over`'s top-level fields laid on `base` — how a fork's own configuration adjusts its source's. */
export function overlaySessionConfig(base: SessionConfig, over: SessionConfig): SessionConfig {
  return defined({ ...base, ...defined({ ...over }), extensions: keyed(base.extensions, over.extensions) }) as SessionConfig;
}

/** Paths of inline MCP secrets in a session configuration — what must not be stored as-is. */
export function inlineMcpSecretPaths(config: SessionConfig): string[] {
  const mcp = config.mcp;
  if (mcp === undefined || mcp === false) return [];
  const paths: string[] = [];
  for (const [name, server] of Object.entries(mcp.servers)) {
    if (server.headers !== undefined && Object.keys(server.headers).length > 0) paths.push(`mcp.servers.${name}.headers`);
    if (server.env !== undefined && Object.keys(server.env).length > 0) paths.push(`mcp.servers.${name}.env`);
    if (server.oauth?.clientSecret !== undefined) paths.push(`mcp.servers.${name}.oauth.clientSecret`);
  }
  return paths;
}

/** Why `config` is not allowed under `policy`, or undefined when it is. */
export function sessionPolicyViolation(config: SessionConfig, policy: SessionPolicy | undefined): { readonly field: string; readonly reason: string } | undefined {
  if (policy === undefined) return undefined;
  const mode = config.permission?.mode;
  const allowedModes = policy.permission?.allowedModes;
  if (mode !== undefined && allowedModes !== undefined && !allowedModes.includes(mode)) {
    return { field: "permission.mode", reason: `permission mode "${mode}" is not allowed here (allowed: ${allowedModes.join(", ") || "none"})` };
  }
  const transports = policy.strictIsolation === true
    ? (policy.allowedMcpTransports ?? ["http", "stdio"]).filter((kind) => kind === "http")
    : policy.allowedMcpTransports;
  if (transports !== undefined && config.mcp !== undefined && config.mcp !== false) {
    for (const [name, server] of Object.entries(config.mcp.servers)) {
      if (!transports.includes(server.transport)) {
        return { field: `mcp.servers.${name}`, reason: `MCP server "${name}" runs over ${server.transport}, which this host does not allow (allowed: ${transports.join(", ") || "none"})` };
      }
    }
  }
  return undefined;
}

function thinkingLevelOf(thinking: AgentFrameworkConfig["thinking"]): ThinkingLevel | undefined {
  if (thinking === undefined) return undefined;
  if (thinking.mode === "off") return "off" as ThinkingLevel;
  return thinking.effort as ThinkingLevel | undefined;
}

/**
 * Turn the flat file shape (`AgentFrameworkConfig`, what `config.toml` holds and `mergeConfigs`
 * produces) into a `HarnessConfig`. Pure: a host that reads the same shape from a database or an
 * API calls this instead of the file loader. An empty collection in the file means "none
 * configured", so it is left out of the defaults rather than recorded as an explicit empty set.
 */
export function normalizeHarnessConfig(raw: unknown): HarnessConfig {
  let file: AgentFrameworkConfig;
  try {
    file = parseConfig(raw);
  } catch (error) {
    throw formatConfigError(error);
  }
  if (isRecord(raw) && isRecord(raw["defaults"])) {
    throw new ConfigError("harness config is already normalized (it has a `defaults` section); pass it to createHarness as it is");
  }
  const limits = defined({ maxTurns: file.loopControl.maxTurns, maxStepsPerTurn: file.loopControl.maxStepsPerTurn });
  const permission = defined({
    mode: file.permission.mode,
    autoApproval: file.permission.autoApproval,
    rules: file.permission.rules.length > 0 ? file.permission.rules : undefined,
  });
  const defaults = defined({
    model: file.model,
    agent: file.agent,
    tools: file.tools,
    appendSystemPrompt: file.appendSystemPrompt,
    thinking: thinkingLevelOf(file.thinking),
    mcp: Object.keys(file.mcpServers).length > 0 ? { servers: file.mcpServers } : undefined,
    skills: file.skills,
    hooks: file.hooks.length > 0 ? file.hooks : undefined,
    permission: Object.keys(permission).length > 0 ? permission : undefined,
    extensions: file.extensions,
    subagents: file.subagents,
    limits: Object.keys(limits).length > 0 ? limits : undefined,
  }) as SessionConfig;
  return defined({
    defaults,
    policy: file.policy,
    plugins: file.plugins.length > 0 ? file.plugins : undefined,
    pluginMarketplaces: file.pluginMarketplaces.length > 0 ? file.pluginMarketplaces : undefined,
    flags: Object.keys(file.flags).length > 0 ? file.flags : undefined,
    eventPublication: file.eventPublication,
    workDir: file.workDir,
  }) as HarnessConfig;
}

/**
 * Read the three-tier config files (user < project < local), merge them, and return the result as
 * a `HarnessConfig`. Loading is not applying: the caller passes the result to `createHarness`,
 * after adjusting it however it likes. The project and local tiers are found from `cwd` — the
 * harness's own directory. A host serving several working directories that wants a directory's
 * file to apply calls this again with a session's `workDir` and uses that result's `defaults` as
 * the session's configuration.
 */
export async function loadHarnessConfig(options: FileResolverOptions = {}): Promise<HarnessConfig> {
  return normalizeHarnessConfig((await resolveFromFiles(options)).config);
}
