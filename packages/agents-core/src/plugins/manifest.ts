import path from "node:path";
import { z } from "zod";
import { McpServerConfigSchema, type McpServerConfig, type Environment } from "../index.ts";
import { loadPluginHooks } from "./hooks.ts";
import { PLUGIN_NAME_REGEX, type PluginDiagnostic, type PluginInterface, type PluginManifest } from "./types.ts";
import { readTextFile } from "../tool/support/environment-ops.ts";
import { describeIssue, optionalText } from "./fields.ts";

const PLUGIN_ROOT_MANIFEST = "agents.plugin.json";
const PLUGIN_DIR_MANIFEST = ".agents-plugin/plugin.json";
// Codex-format plugins (github.com/openai/plugins): same manifest shape, different filename, and
// `mcpServers` is a PATH to a `.mcp.json` rather than an inline object — handled in readMcpServers.
const CODEX_DIR_MANIFEST = ".codex-plugin/plugin.json";

// Runtime fields we still do not execute. `hooks` is supported (see loadPluginHooks).
const UNSUPPORTED_RUNTIME_FIELDS = ["tools", "commands", "apps", "inject", "configFile", "bootstrap"] as const;

const AuthorSchema = z.union([
  z.string().transform((name): PluginManifest["author"] => ({ name })),
  z.object({ name: optionalText, email: optionalText }).transform(
    ({ name, email }): PluginManifest["author"] => (name === undefined && email === undefined ? undefined : { name, email }),
  ),
]);

const InterfaceSchema = z
  .object({ displayName: optionalText, shortDescription: optionalText, longDescription: optionalText })
  .transform((iface): PluginInterface | undefined => (Object.values(iface).some((v) => v !== undefined) ? iface : undefined));

/**
 * The manifest as written. Fields that need the filesystem to be resolved (`skills`,
 * `mcpServers`, `hooks`) are shape-checked here and resolved below; everything else lands in
 * the `PluginManifest` as is. Unknown fields pass through so a newer plugin still loads.
 */
const RawManifestSchema = z.looseObject({
  name: z.string({ error: "is required" }).refine((name) => name.trim().length > 0, "is required"),
  version: optionalText,
  description: optionalText,
  keywords: z.array(z.string()).optional(),
  homepage: optionalText,
  license: optionalText,
  author: AuthorSchema.optional(),
  skills: z.union([z.string(), z.array(z.string())], { error: "must be a string or string[]" }).optional(),
  sessionStart: z.object({ skill: z.string().refine((skill) => skill.trim().length > 0, "is required when sessionStart is present") }).optional(),
  mcpServers: z.union([z.string(), z.record(z.string(), z.unknown())], { error: "must be an object or a path to a .mcp.json" }).optional(),
  hooks: z.unknown().optional(),
  interface: InterfaceSchema.optional(),
  skillInstructions: z.string().optional(),
});

type RawManifest = z.output<typeof RawManifestSchema>;

// A malformed optional field is reported and dropped, not fatal: the plugin still loads with
// what was valid, the way it always has. `name` and `skills` are the two a plugin cannot do
// without, so those stay errors.
const FATAL_FIELDS = new Set(["name"]);
const ERROR_FIELDS = new Set(["skills"]);

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

const DEFAULT_SKILLS_DIR = "skills";
const DEFAULT_MCP_CONFIG_FILE = ".mcp.json";

export async function parseManifest(environment: Environment, pluginRoot: string): Promise<ParsedManifestResult> {
  const candidates = [PLUGIN_ROOT_MANIFEST, PLUGIN_DIR_MANIFEST, CODEX_DIR_MANIFEST];
  let manifestPath: string | undefined;
  for (const candidate of candidates) {
    const candidatePath = path.join(pluginRoot, candidate);
    if (await isFile(environment, candidatePath)) {
      manifestPath = candidatePath;
      break;
    }
  }
  if (manifestPath === undefined) {
    return { diagnostics: [{ severity: "error", message: `No manifest at ${candidates.join(", ")}` }] };
  }

  let json: unknown;
  try {
    json = JSON.parse(await readTextFile(environment, manifestPath));
  } catch (error) {
    return { manifestPath, diagnostics: [{ severity: "error", message: `Failed to parse ${manifestPath}: ${(error as Error).message}` }] };
  }
  if (!isObject(json)) {
    return { manifestPath, diagnostics: [{ severity: "error", message: "manifest must be a JSON object" }] };
  }

  const diagnostics: PluginDiagnostic[] = [];
  const raw = parseTolerant(json, diagnostics);
  if (raw === undefined) return { manifestPath, diagnostics };

  const name = raw.name.trim();
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({ severity: "error", message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")` });
    return { manifestPath, diagnostics };
  }

  // Codex convention: a manifest that doesn't name its skills / MCP file still gets the plugin's
  // `skills/` dir and root `.mcp.json` (most curated plugins rely on this — e.g. Vercel, Slack).
  const skillsField =
    raw.skills ?? ((await isDir(environment, path.join(pluginRoot, DEFAULT_SKILLS_DIR))) ? `./${DEFAULT_SKILLS_DIR}` : undefined);
  const mcpServersField =
    raw.mcpServers ?? ((await isFile(environment, path.join(pluginRoot, DEFAULT_MCP_CONFIG_FILE))) ? `./${DEFAULT_MCP_CONFIG_FILE}` : undefined);

  let skills = await resolveSkillsField(environment, pluginRoot, skillsField, diagnostics);
  if (skillsField === undefined && (await isFile(environment, path.join(pluginRoot, "SKILL.md")))) {
    skills = [pluginRoot];
  }

  for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
    if (raw[field] !== undefined) diagnostics.push({ severity: "info", message: `"${field}" is present but not supported` });
  }

  const hooks = await loadPluginHooks(environment, pluginRoot, raw.hooks, diagnostics);

  const manifest: PluginManifest = {
    name,
    version: raw.version,
    description: raw.description,
    keywords: raw.keywords,
    homepage: raw.homepage,
    license: raw.license,
    author: raw.author,
    skills,
    sessionStart: raw.sessionStart === undefined ? undefined : { skill: raw.sessionStart.skill.trim() },
    mcpServers: await readMcpServers(environment, pluginRoot, mcpServersField, diagnostics),
    ...(hooks.length > 0 ? { hooks } : {}),
    interface: raw.interface,
    skillInstructions: raw.skillInstructions,
  };
  return { manifest, manifestPath, diagnostics };
}

/**
 * Validate the manifest, reporting each malformed field by name. A bad `name` ends parsing;
 * any other bad field is dropped and the rest is parsed again, so one typo in `author` does
 * not cost the plugin its skills.
 */
function parseTolerant(json: Record<string, unknown>, diagnostics: PluginDiagnostic[]): RawManifest | undefined {
  const first = RawManifestSchema.safeParse(json);
  if (first.success) return first.data;

  const dropped = new Set<string>();
  for (const issue of first.error.issues) {
    const field = String(issue.path[0] ?? "");
    if (FATAL_FIELDS.has(field) || issue.path.length === 0) {
      diagnostics.push({ severity: "error", message: describeIssue(issue) });
      return undefined;
    }
    diagnostics.push({ severity: ERROR_FIELDS.has(field) ? "error" : "warn", message: describeIssue(issue) });
    dropped.add(field);
  }
  const pruned = Object.fromEntries(Object.entries(json).filter(([key]) => !dropped.has(key)));
  const second = RawManifestSchema.safeParse(pruned);
  if (second.success) return second.data;
  for (const issue of second.error.issues) diagnostics.push({ severity: "error", message: describeIssue(issue) });
  return undefined;
}

async function resolveSkillsField(
  environment: Environment,
  pluginRoot: string,
  raw: string | readonly string[] | undefined,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries = typeof raw === "string" ? [raw] : raw;

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("./")) {
      diagnostics.push({ severity: "error", message: `"skills" path must start with "./" (got "${entry}")` });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    if (!isWithin(absolute, pluginRoot)) {
      diagnostics.push({ severity: "error", message: `"skills" path resolves outside the plugin (${entry})` });
      continue;
    }
    if (!(await isDir(environment, absolute))) {
      diagnostics.push({ severity: "warn", message: `"skills" path is not a directory (${entry})` });
      continue;
    }
    resolved.push(absolute);
  }
  return resolved;
}

async function readMcpServers(
  environment: Environment,
  pluginRoot: string,
  raw: string | Readonly<Record<string, unknown>> | undefined,
  diagnostics: PluginDiagnostic[],
): Promise<PluginManifest["mcpServers"]> {
  if (raw === undefined) return undefined;
  // Codex format: `mcpServers` is a path to a `.mcp.json` ({ "mcpServers": { … } }). Read it and
  // treat its `mcpServers` object as the inline map. (`McpServerConfigSchema` already accepts the
  // Codex `type` field and normalises it to `transport`.)
  let servers: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.startsWith("./")) {
      diagnostics.push({ severity: "warn", message: `"mcpServers" path must start with "./" (got "${raw}")` });
      return undefined;
    }
    const absolute = path.resolve(pluginRoot, raw);
    if (!isWithin(absolute, pluginRoot)) {
      diagnostics.push({ severity: "warn", message: `"mcpServers" path resolves outside the plugin (${raw})` });
      return undefined;
    }
    try {
      const parsed = JSON.parse(await readTextFile(environment, absolute)) as unknown;
      servers = isObject(parsed) && isObject(parsed["mcpServers"]) ? parsed["mcpServers"] : parsed;
    } catch (error) {
      diagnostics.push({ severity: "warn", message: `Failed to read MCP file ${raw}: ${(error as Error).message}` });
      return undefined;
    }
  }
  if (!isObject(servers)) {
    diagnostics.push({ severity: "warn", message: '"mcpServers" must be an object or a path to a .mcp.json' });
    return undefined;
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers)) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      diagnostics.push({ severity: "warn", message: '"mcpServers" entries must have a non-empty name' });
      continue;
    }
    const parsed = McpServerConfigSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({ severity: "warn", message: `Invalid MCP server "${trimmedName}": ${parsed.error.message}` });
      continue;
    }
    out[trimmedName] = await normalizePluginMcpServer(environment, pluginRoot, trimmedName, parsed.data, diagnostics);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

async function normalizePluginMcpServer(
  environment: Environment,
  pluginRoot: string,
  name: string,
  config: McpServerConfig,
  diagnostics: PluginDiagnostic[],
): Promise<McpServerConfig> {
  // stdio `./command` resolves within the plugin root; bare names stay PATH commands.
  if (config.transport === "stdio" && typeof config.command === "string" && config.command.startsWith("./")) {
    const absolute = path.resolve(pluginRoot, config.command);
    if (isWithin(absolute, pluginRoot)) {
      if (!(await isFile(environment, absolute))) {
        diagnostics.push({ severity: "warn", message: `"mcpServers.${name}.command" not found (${config.command})` });
      }
      return { ...config, command: absolute };
    }
    diagnostics.push({ severity: "warn", message: `"mcpServers.${name}.command" resolves outside the plugin` });
  }
  return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isFile(environment: Environment, p: string): Promise<boolean> {
  try {
    return (await environment.fileInfo(p)).kind === "file";
  } catch {
    return false;
  }
}

async function isDir(environment: Environment, p: string): Promise<boolean> {
  try {
    return (await environment.fileInfo(p)).kind === "dir";
  } catch {
    return false;
  }
}
