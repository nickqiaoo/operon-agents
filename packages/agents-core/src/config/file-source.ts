import { readFile } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { mergeConfigs } from "./merge.ts";
import { type ConfigLayer, type ConfigLayerOptions, resolveConfigLayers } from "./paths.ts";
import { type AgentFrameworkConfig, parseConfig } from "./schema.ts";
import type { ConfigResolver } from "./resolver.ts";

/** Pluggable on-disk format. The own-config default is TOML; inject `jsonFormat` (or any
 *  other parse/stringify pair) to change it. */
export interface ConfigFormat {
  parse(text: string): unknown;
  stringify(value: unknown): string;
}

export const tomlFormat: ConfigFormat = {
  parse: (text) => parseToml(text),
  stringify: (value) => stringifyToml(value as Record<string, unknown>),
};

export const jsonFormat: ConfigFormat = {
  parse: (text) => JSON.parse(text) as unknown,
  stringify: (value) => `${JSON.stringify(value, null, 2)}\n`,
};

export class ConfigError extends Error {
  readonly file: string | undefined;
  readonly issues: readonly string[] | undefined;
  constructor(message: string, options: { file?: string; issues?: readonly string[] } = {}) {
    super(message);
    this.name = "ConfigError";
    this.file = options.file;
    this.issues = options.issues;
  }
}

/** Turn a Zod/parse failure into a readable `ConfigError` carrying field paths + the file. */
export function formatConfigError(error: unknown, file?: string): ConfigError {
  const where = file !== undefined ? ` in ${file}` : "";
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
    return new ConfigError(`invalid config${where}:\n  ${issues.join("\n  ")}`, { file, issues });
  }
  return new ConfigError(`failed to load config${where}: ${error instanceof Error ? error.message : String(error)}`, { file });
}

/** Read + parse + validate one layer file. Missing file → undefined; bad syntax/shape → ConfigError. */
export async function loadConfigFile(path: string, format: ConfigFormat = tomlFormat): Promise<AgentFrameworkConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return undefined; // absent layer is fine
  }
  let raw: unknown;
  try {
    raw = format.parse(text);
  } catch (error) {
    throw formatConfigError(error, path);
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    throw formatConfigError(error, path);
  }
}

export interface FileResolverOptions extends ConfigLayerOptions {
  readonly format?: ConfigFormat;
  /** Highest-precedence overlay applied after all files (e.g. CLI flags). */
  readonly overrides?: Partial<AgentFrameworkConfig>;
}

export interface ResolvedLayer extends ConfigLayer {
  readonly loaded: boolean;
}

export interface ResolvedFromFiles {
  readonly config: AgentFrameworkConfig;
  readonly layers: readonly ResolvedLayer[];
}

/** Discover the three tiers, read+merge those that exist (low → high), validate the result. */
export async function resolveFromFiles(options: FileResolverOptions = {}): Promise<ResolvedFromFiles> {
  const format = options.format ?? tomlFormat;
  const paths = resolveConfigLayers(options);
  const layers: ResolvedLayer[] = [];
  const parts: Partial<AgentFrameworkConfig>[] = [];
  for (const layer of paths.ordered) {
    const cfg = await loadConfigFile(layer.path, format);
    layers.push({ ...layer, loaded: cfg !== undefined });
    if (cfg !== undefined) parts.push(cfg);
  }
  if (options.overrides !== undefined) parts.push(options.overrides);
  const config = parseConfig(parts.length > 0 ? mergeConfigs(...parts) : {});
  return { config, layers };
}

/** A `ConfigResolver` backed by the three-tier config files. */
export function fileResolver(options: FileResolverOptions = {}): ConfigResolver {
  return { resolve: async () => (await resolveFromFiles(options)).config };
}
