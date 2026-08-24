import { homedir } from "node:os";
import { join } from "node:path";

export type ConfigTier = "user" | "project" | "local";

export interface ConfigLayerOptions {
  /** Names the host config dir/file family. Default "agents". */
  readonly appName?: string;
  /** User-tier directory. Default `~/.<appName>`. */
  readonly homeDir?: string;
  /** Project root for project/local tiers. Default `process.cwd()`. */
  readonly cwd?: string;
  /** Config file name. Default "config.toml" (own config is TOML; mcp.json stays JSON). */
  readonly fileName?: string;
  /** Local (gitignored) override file name. Default "config.local.toml". */
  readonly localFileName?: string;
}

export interface ConfigLayer {
  readonly tier: ConfigTier;
  readonly path: string;
}

export interface ConfigLayerPaths {
  readonly user: string;
  readonly project: string;
  readonly local: string;
  /** Layers in precedence order, low → high (local wins). */
  readonly ordered: readonly ConfigLayer[];
}

/**
 * Standard three-tier config file locations. Precedence low → high:
 * user (`~/.<app>/config.toml`) < project (`<cwd>/.<app>/config.toml`) <
 * local (`<cwd>/.<app>/config.local.toml`).
 */
export function resolveConfigLayers(options: ConfigLayerOptions = {}): ConfigLayerPaths {
  const appName = options.appName ?? "agents";
  const fileName = options.fileName ?? "config.toml";
  const localFileName = options.localFileName ?? "config.local.toml";
  const homeDir = options.homeDir ?? join(homedir(), `.${appName}`);
  const cwd = options.cwd ?? process.cwd();

  const user = join(homeDir, fileName);
  const project = join(cwd, `.${appName}`, fileName);
  const local = join(cwd, `.${appName}`, localFileName);

  return {
    user,
    project,
    local,
    ordered: [
      { tier: "user", path: user },
      { tier: "project", path: project },
      { tier: "local", path: local },
    ],
  };
}
