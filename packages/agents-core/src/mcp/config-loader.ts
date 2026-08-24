import path from "node:path";
import { z } from "zod";
import type { Machine } from "../index.ts";
import { McpServerConfigSchema, type McpServerConfig } from "../config/schema.ts";
import { readTextFile } from "../tool/support/machine-ops.ts";

const PROJECT_MCP_FILENAMES = ["mcp.json", ".mcp.json"] as const;

const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});

async function findProjectRoot(machine: Machine, cwd: string): Promise<string> {
  let current = machine.normpath(cwd);
  // Bounded by reaching the filesystem root (dirname fixpoint).
  for (;;) {
    if (await pathExists(machine, path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return machine.normpath(cwd);
    current = parent;
  }
}

async function pathExists(machine: Machine, p: string): Promise<boolean> {
  try {
    await machine.fileInfo(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadProjectMcpServers(
  machine: Machine,
  cwd: string,
): Promise<Record<string, McpServerConfig>> {
  const root = await findProjectRoot(machine, cwd);
  const merged: Record<string, McpServerConfig> = {};

  for (const filename of PROJECT_MCP_FILENAMES) {
    const file = path.join(root, filename);
    const parsed = await readMcpJsonFile(machine, file);
    if (parsed === undefined) continue;
    Object.assign(merged, parsed.mcpServers);
  }

  return normalizeStdioCwd(merged, root);
}

const LOCAL_MCP_FILENAMES = ["mcp.local.json", ".mcp.local.json"] as const;

export type McpConfigTier = "user" | "project" | "local";

export interface McpConfigLayerOptions {
  /** Working directory the project root is discovered from. Defaults to the machine cwd. */
  readonly cwd?: string;
  /** User-tier directory. Defaults to `<machine home>/.<appName>`. */
  readonly homeDir?: string;
  readonly appName?: string;
}

export interface McpConfigLayer {
  readonly tier: McpConfigTier;
  readonly files: readonly string[];
  readonly loaded: boolean;
}

export interface LoadedMcpServers {
  readonly servers: Record<string, McpServerConfig>;
  readonly layers: readonly McpConfigLayer[];
}

/**
 * Load MCP servers across three tiers, low → high precedence (a later tier overrides a
 * same-named server): user (`~/.<app>/mcp.json`) < project (`<root>/mcp.json` + `.mcp.json`)
 * < local (`<root>/mcp.local.json` + `.mcp.local.json`). Stdio `cwd` is resolved against the
 * project root. The interop `mcp.json` stays JSON (own config is TOML — see ConfigStore).
 */
export async function loadMcpServers(machine: Machine, options: McpConfigLayerOptions = {}): Promise<LoadedMcpServers> {
  const appName = options.appName ?? "agents";
  const cwd = options.cwd ?? machine.getcwd();
  const root = await findProjectRoot(machine, cwd);
  const homeDir = options.homeDir ?? path.join(machine.gethome(), `.${appName}`);

  const tiers: { readonly tier: McpConfigTier; readonly files: readonly string[] }[] = [
    { tier: "user", files: [path.join(homeDir, "mcp.json"), path.join(homeDir, ".mcp.json")] },
    // Project tier reads the cross-tool `<root>/mcp.json` + `<root>/.mcp.json`, plus the
    // app-namespaced `<root>/.<appName>/mcp.json` (highest precedence within the tier).
    {
      tier: "project",
      files: [...PROJECT_MCP_FILENAMES.map((f) => path.join(root, f)), path.join(root, `.${appName}`, "mcp.json")],
    },
    { tier: "local", files: LOCAL_MCP_FILENAMES.map((f) => path.join(root, f)) },
  ];

  const merged: Record<string, McpServerConfig> = {};
  const layers: McpConfigLayer[] = [];
  for (const { tier, files } of tiers) {
    let loaded = false;
    for (const file of files) {
      const parsed = await readMcpJsonFile(machine, file);
      if (parsed === undefined) continue;
      Object.assign(merged, parsed.mcpServers);
      loaded = true;
    }
    layers.push({ tier, files, loaded });
  }

  return { servers: normalizeStdioCwd(merged, root), layers };
}

async function readMcpJsonFile(
  machine: Machine,
  file: string,
): Promise<{ mcpServers: Record<string, McpServerConfig> } | undefined> {
  let text: string;
  try {
    text = await readTextFile(machine, file);
  } catch {
    return undefined;
  }
  if (text.trim().length === 0) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return McpJsonFileSchema.parse(data);
}

function normalizeStdioCwd(
  servers: Record<string, McpServerConfig>,
  root: string,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.transport === "stdio") {
      const cwd =
        config.cwd === undefined
          ? root
          : path.isAbsolute(config.cwd)
            ? config.cwd
            : path.resolve(root, config.cwd);
      out[name] = { ...config, cwd };
    } else {
      out[name] = config;
    }
  }
  return out;
}
