import path from "node:path";
import { McpServerConfigSchema, type McpServerConfig, type Machine } from "../index.ts";
import { loadPluginHooks } from "./hooks.ts";
import { PLUGIN_NAME_REGEX, type PluginDiagnostic, type PluginInterface, type PluginManifest } from "./types.ts";
import { readTextFile } from "../tool/support/machine-ops.ts";

const PLUGIN_ROOT_MANIFEST = "agents.plugin.json";
const PLUGIN_DIR_MANIFEST = ".agents-plugin/plugin.json";
// Codex-format plugins (github.com/openai/plugins): same manifest shape, different filename, and
// `mcpServers` is a PATH to a `.mcp.json` rather than an inline object — handled in readMcpServers.
const CODEX_DIR_MANIFEST = ".codex-plugin/plugin.json";

// Runtime fields we still do not execute. `hooks` is supported (see loadPluginHooks).
const UNSUPPORTED_RUNTIME_FIELDS = ["tools", "commands", "apps", "inject", "configFile", "bootstrap"] as const;


export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(machine: Machine, pluginRoot: string): Promise<ParsedManifestResult> {
  const candidates = [PLUGIN_ROOT_MANIFEST, PLUGIN_DIR_MANIFEST, CODEX_DIR_MANIFEST];
  let manifestPath: string | undefined;
  for (const candidate of candidates) {
    const candidatePath = path.join(pluginRoot, candidate);
    if (await isFile(machine, candidatePath)) {
      manifestPath = candidatePath;
      break;
    }
  }
  if (manifestPath === undefined) {
    return { diagnostics: [{ severity: "error", message: `No manifest at ${candidates.join(", ")}` }] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readTextFile(machine, manifestPath));
  } catch (error) {
    return { manifestPath, diagnostics: [{ severity: "error", message: `Failed to parse ${manifestPath}: ${(error as Error).message}` }] };
  }
  if (!isObject(raw)) {
    return { manifestPath, diagnostics: [{ severity: "error", message: "manifest must be a JSON object" }] };
  }

  const diagnostics: PluginDiagnostic[] = [];
  const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
  if (name.length === 0) {
    diagnostics.push({ severity: "error", message: '"name" is required' });
    return { manifestPath, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({ severity: "error", message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")` });
    return { manifestPath, diagnostics };
  }

  let skills = await resolveSkillsField(machine, pluginRoot, raw["skills"], diagnostics);
  if (raw["skills"] === undefined && (await isFile(machine, path.join(pluginRoot, "SKILL.md")))) {
    skills = [pluginRoot];
  }

  for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
    if (raw[field] !== undefined) diagnostics.push({ severity: "info", message: `"${field}" is present but not supported` });
  }

  const hooks = await loadPluginHooks(machine, pluginRoot, raw["hooks"], diagnostics);

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, "version"),
    description: stringField(raw, "description"),
    keywords: stringArrayField(raw, "keywords"),
    homepage: stringField(raw, "homepage"),
    license: stringField(raw, "license"),
    author: readAuthor(raw["author"]),
    skills,
    sessionStart: readSessionStart(raw["sessionStart"], diagnostics),
    mcpServers: await readMcpServers(machine, pluginRoot, raw["mcpServers"], diagnostics),
    ...(hooks.length > 0 ? { hooks } : {}),
    interface: readInterface(raw["interface"]),
    skillInstructions: typeof raw["skillInstructions"] === "string" ? raw["skillInstructions"] : undefined,
  };
  return { manifest, manifestPath, diagnostics };
}

async function resolveSkillsField(
  machine: Machine,
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === "string") entries.push(raw);
  else if (Array.isArray(raw) && raw.every((e) => typeof e === "string")) entries.push(...(raw as string[]));
  else {
    diagnostics.push({ severity: "error", message: '"skills" must be a string or string[]' });
    return [];
  }

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
    if (!(await isDir(machine, absolute))) {
      diagnostics.push({ severity: "warn", message: `"skills" path is not a directory (${entry})` });
      continue;
    }
    resolved.push(absolute);
  }
  return resolved;
}

function readSessionStart(raw: unknown, diagnostics: PluginDiagnostic[]): PluginManifest["sessionStart"] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: "warn", message: '"sessionStart" must be an object' });
    return undefined;
  }
  const skill = typeof raw["skill"] === "string" ? raw["skill"].trim() : "";
  if (skill.length === 0) {
    diagnostics.push({ severity: "warn", message: '"sessionStart.skill" is required when sessionStart is present' });
    return undefined;
  }
  return { skill };
}

async function readMcpServers(
  machine: Machine,
  pluginRoot: string,
  raw: unknown,
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
      const parsed = JSON.parse(await readTextFile(machine, absolute)) as unknown;
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
    out[trimmedName] = await normalizePluginMcpServer(machine, pluginRoot, trimmedName, parsed.data, diagnostics);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

async function normalizePluginMcpServer(
  machine: Machine,
  pluginRoot: string,
  name: string,
  config: McpServerConfig,
  diagnostics: PluginDiagnostic[],
): Promise<McpServerConfig> {
  // stdio `./command` resolves within the plugin root; bare names stay PATH commands.
  if (config.transport === "stdio" && typeof config.command === "string" && config.command.startsWith("./")) {
    const absolute = path.resolve(pluginRoot, config.command);
    if (isWithin(absolute, pluginRoot)) {
      if (!(await isFile(machine, absolute))) {
        diagnostics.push({ severity: "warn", message: `"mcpServers.${name}.command" not found (${config.command})` });
      }
      return { ...config, command: absolute };
    }
    diagnostics.push({ severity: "warn", message: `"mcpServers.${name}.command" resolves outside the plugin` });
  }
  return config;
}

function readAuthor(raw: unknown): PluginManifest["author"] {
  if (typeof raw === "string") return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, "name");
  const email = stringField(raw, "email");
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const out: PluginInterface = {
    displayName: stringField(raw, "displayName"),
    shortDescription: stringField(raw, "shortDescription"),
    longDescription: stringField(raw, "longDescription"),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((e) => typeof e === "string")) return undefined;
  return value as readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isFile(machine: Machine, p: string): Promise<boolean> {
  try {
    return (await machine.fileInfo(p)).kind === "file";
  } catch {
    return false;
  }
}

async function isDir(machine: Machine, p: string): Promise<boolean> {
  try {
    return (await machine.fileInfo(p)).kind === "dir";
  } catch {
    return false;
  }
}
