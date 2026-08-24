import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  type ConfigFormat,
  type FileResolverOptions,
  type ResolvedLayer,
  formatConfigError,
  resolveFromFiles,
  tomlFormat,
} from "./file-source.ts";
import { type ConfigLayerPaths, type ConfigTier, resolveConfigLayers } from "./paths.ts";
import { type AgentFrameworkConfig, parseConfig } from "./schema.ts";

/**
 * The config file lifecycle: load + merge the three tiers, expose the resolved config, and
 * apply runtime patches by merging into a tier's own file and writing it back (validated,
 * atomic). Re-resolves after every write so `get()` always reflects disk.
 */
export class ConfigStore {
  private readonly options: FileResolverOptions;
  private readonly format: ConfigFormat;
  private readonly paths: ConfigLayerPaths;
  private resolvedConfig: AgentFrameworkConfig | undefined;
  private resolvedLayers: readonly ResolvedLayer[] = [];

  constructor(options: FileResolverOptions = {}) {
    this.options = options;
    this.format = options.format ?? tomlFormat;
    this.paths = resolveConfigLayers(options);
  }

  async load(): Promise<AgentFrameworkConfig> {
    const resolved = await resolveFromFiles(this.options);
    this.resolvedConfig = resolved.config;
    this.resolvedLayers = resolved.layers;
    return this.resolvedConfig;
  }

  get(): AgentFrameworkConfig {
    if (this.resolvedConfig === undefined) throw new Error("ConfigStore: call load() before get()");
    return this.resolvedConfig;
  }

  layers(): readonly ResolvedLayer[] {
    return this.resolvedLayers;
  }

  pathFor(tier: ConfigTier): string {
    return tier === "user" ? this.paths.user : tier === "project" ? this.paths.project : this.paths.local;
  }

  /**
   * Merge `patch` into `tier`'s file and persist it, then re-resolve all tiers. Objects deep-merge,
   * arrays/scalars are replaced — so the file stays minimal (no injected defaults). Throws a
   * `ConfigError` (without writing) if the patched file would be invalid.
   */
  async patch(patch: Partial<AgentFrameworkConfig>, tier: ConfigTier = "user"): Promise<AgentFrameworkConfig> {
    const path = this.pathFor(tier);
    const current = await this.readRaw(path);
    const next = stripUndefined(deepMerge(current, patch as Record<string, unknown>));
    try {
      parseConfig(next); // validate the would-be file; surfaces field paths on failure
    } catch (error) {
      throw formatConfigError(error, path);
    }
    await this.writeRaw(path, next);
    return this.load();
  }

  private async readRaw(path: string): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch {
      return {};
    }
    try {
      const parsed = this.format.parse(text);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      throw formatConfigError(error, path);
    }
  }

  private async writeRaw(path: string, value: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, this.format.stringify(value), { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, path);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge `patch` onto `base`: nested objects merge, arrays/scalars from `patch` replace. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** Drop `undefined` values recursively — TOML (and JSON) have no `undefined`. */
function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    out[key] = isPlainObject(v) ? stripUndefined(v) : v;
  }
  return out;
}
