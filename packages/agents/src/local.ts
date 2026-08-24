/**
 * The local composition root — every convention a single-machine, single-operator app runs on,
 * bundled in one place: disk sessions under `<homeDir>/sessions`, the local machine, a rotating
 * file log, file-backed MCP credentials, disk-discovered agent profiles, and the cron extension.
 *
 * There is deliberately no server counterpart. A hosted deployment injects its own repository,
 * machine, logger and credential store, and those choices belong to the host — a preset that
 * bundled them saved three lines while forcing one `McpOAuthService` (and therefore one
 * credential store, which has no tenant dimension) to be shared across every session in the
 * process. Servers call `createHarness` directly; see `examples/managed-agents`.
 *
 * There is still no "mode" inside the engine (Architecture Invariant 7): this file only picks
 * backends, and returns a plain `Harness` nothing downstream can distinguish.
 */
import { homedir } from "node:os";
import { cronExtension } from "./cron/index.ts";
import { join } from "node:path";
import {
  type HookDef,
  type McpServerConfig,
  type PluginManager,
  DiskSessionRepository,
  McpOAuthService,
  RotatingFileSink,
  loadAgentProfiles,
  resolveGlobalLogPath,
  sinkLogger,
} from "operon-agents-core";
import {
  createHarness,
  defaultCapabilities,
  type CreateSessionOptions,
  type Harness,
  type HarnessOptions,
  type HarnessSession,
} from "./harness.ts";

export interface LocalDeploymentOptions<TContext = unknown> extends HarnessOptions<TContext> {
  /**
   * App home root — sessions (`<homeDir>/sessions`), MCP creds, logs, and disk-discovered agent
   * profiles all live under it. Defaults to `~/.agents`. (`homeDir` is a local-deployment concept;
   * the harness itself only knows `repository`.)
   */
  readonly homeDir?: string;
  /** Workspace MCP servers to expose. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Installed-plugin manager, if any. */
  readonly pluginManager?: PluginManager;
  /** Shell hooks from config (`config.hooks`), projected as HookDefs. */
  readonly hooks?: readonly HookDef[];
  /** Discover agent profiles from disk (`<homeDir>/agents` + `<cwd>/.agents/agents`). Default true. */
  readonly loadDiskProfiles?: boolean;
}

/** Build `HarnessOptions` wired for a local, single-machine deployment. */
export async function localHarnessOptions<TContext>(
  options: LocalDeploymentOptions<TContext>,
): Promise<HarnessOptions<TContext>> {
  const homeDir = options.homeDir ?? join(homedir(), ".agents");
  // MCP OAuth credentials on local disk (0600) — the local default backend (`<homeDir>/credentials/mcp`).
  const oauthService = new McpOAuthService({ homeDir });
  // Diagnostics roll on disk under <homeDir>/logs.
  const logger = options.logger ?? sinkLogger(new RotatingFileSink({ path: resolveGlobalLogPath({ homeDir }) }));
  // Agent profiles come from disk here; the server preset supplies them externally instead.
  const extraSubagentProfiles =
    options.extraSubagentProfiles ??
    ((options.loadDiskProfiles ?? true)
      ? await loadAgentProfiles({ homeDir, cwd: options.workDir ?? process.cwd() })
      : undefined);

  return {
    ...options,
    // Disk sessions under <homeDir>/sessions; an injected repository still wins. The machine defaults to local.
    repository: options.repository ?? new DiskSessionRepository(homeDir),
    logger,
    ...(extraSubagentProfiles !== undefined ? { extraSubagentProfiles } : {}),
    capabilities:
      options.capabilities ??
      (() =>
        defaultCapabilities({
          ...(options.maxContextTokens !== undefined ? { maxContextTokens: options.maxContextTokens } : {}),
          ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
          ...(options.pluginManager !== undefined ? { pluginManager: options.pluginManager } : {}),
          ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
          oauthService,
        })),
    // Cron rides the extension channel now: LOCAL deployments attach it, the server profile
    // simply doesn't — Invariant 7 ("cron is local-only") is structural, not an option to pass.
    extensions: [cronExtension(), ...(options.extensions ?? [])],
  };
}

export async function createLocalHarness<TContext = unknown>(
  options: LocalDeploymentOptions<TContext>,
): Promise<Harness<TContext>> {
  return createHarness<TContext>(await localHarnessOptions(options));
}

/** Convenience: a local harness with one session opened and ready to `prompt()`. */
export async function createLocalSession<TContext = unknown>(
  options: LocalDeploymentOptions<TContext>,
  session: CreateSessionOptions<TContext> = {},
): Promise<HarnessSession<TContext>> {
  return (await createLocalHarness<TContext>(options)).createSession(session);
}
