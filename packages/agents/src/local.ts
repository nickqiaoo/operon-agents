/**
 * The local composition root — every convention a single-environment, single-operator app runs on,
 * bundled in one place: disk sessions under `<homeDir>/sessions`, the local environment, a rotating
 * file log, file-backed MCP credentials, disk-discovered agent profiles, and the cron extension.
 *
 * It is a PRESET: pure data in (`LocalDeploymentOptions`), the three composition hooks out.
 * The `harness` hook registers the process-lived objects on the harness scope; the `session`
 * hook builds each session's capability set. A hosted deployment writes its own preset the same
 * way (see `examples/managed-agents`) — there is still no "mode" inside the engine
 * (Architecture Invariant 7): this file only picks backends, and returns plain `HarnessOptions`
 * nothing downstream can distinguish.
 */
import { homedir } from "node:os";
import { cronExtension } from "./cron/index.ts";
import { createModelRuntimeFromConfig } from "./providers.ts";
import type { ModelRuntime } from "operon-agents-core";
import { join } from "node:path";
import {
  type HookDef,
  type Logger,
  type McpServerConfig,
  type PluginManager,
  DiskSessionRepository,
  LocalEnvironment,
  McpOAuthService,
  RotatingFileSink,
  SkillRegistry,
  Tokens,
  createMcpServers,
  loadSkillRoots,
  loadAgentProfiles,
  resolveGlobalLogPath,
  sinkLogger,
} from "operon-agents-core";
import {
  createHarness,
  defaultCapabilities,
  type Harness,
  type HarnessOptions,
} from "./harness.ts";

export interface LocalDeploymentOptions<TContext = unknown> extends HarnessOptions<TContext> {
  /**
   * App home root — sessions (`<homeDir>/sessions`), MCP creds, logs, and disk-discovered agent
   * profiles all live under it. Defaults to `~/.agents`. (`homeDir` is a local-deployment concept;
   * the harness itself only knows `Tokens.SessionRepository`.)
   */
  readonly homeDir?: string;
  /** Workspace MCP servers to expose. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Installed-plugin manager, if any. Loaded once here, then registered as `Tokens.PluginManager`. */
  readonly pluginManager?: PluginManager;
  /** Shell hooks from config (`config.hooks`), projected as HookDefs. */
  readonly hooks?: readonly HookDef[];
  /** Discover agent profiles from disk (`<homeDir>/agents` + `<cwd>/.agents/agents`). Default true. */
  readonly loadDiskProfiles?: boolean;
  /** Diagnostics logger. Defaults to a rotating file under `<homeDir>/logs`. */
  readonly logger?: Logger;
  /** Context budget for the default compaction capability. */
  readonly maxContextTokens?: number;
  /**
   * The model runtime this harness resolves providers through. Pass the same one the host used to
   * build its `ChatModel` (see `createModelRuntimeFromConfig`) when a model lives on a configured
   * endpoint — otherwise the two registries disagree about what exists. Omitted, the harness builds
   * one from `<homeDir>/providers.toml` itself.
   */
  readonly modelRuntime?: ModelRuntime;
  /** Skip reading `<homeDir>/providers.toml` entirely. Ignored when `modelRuntime` is given. */
  readonly loadConfiguredProviders?: boolean;
}

/** Build `HarnessOptions` wired for a local, single-environment deployment. */
export async function localHarnessOptions<TContext>(
  options: LocalDeploymentOptions<TContext>,
): Promise<HarnessOptions<TContext>> {
  const { homeDir: home, mcpServers, pluginManager, hooks, loadDiskProfiles, logger, maxContextTokens, modelRuntime, loadConfiguredProviders, harness, workspace, session, extensions, ...engine } = options;
  const homeDir = home ?? join(homedir(), ".agents");
  // Agent profiles come from disk here; the server preset supplies them externally instead.
  const extraSubagentProfiles =
    options.extraSubagentProfiles ??
    ((loadDiskProfiles ?? true)
      ? await loadAgentProfiles({ homeDir, cwd: options.workDir ?? process.cwd() })
      : undefined);
  // Installed plugins are read ONCE per process, not per session: the manager is a harness-tier
  // object, and `session.plugins.reload()` is the explicit refresh.
  if (pluginManager !== undefined) await pluginManager.load();
  // Configured endpoints are resolved once per harness, not per session: the registry is a
  // harness-tier object, and a session only ever reads it.
  const runtime =
    modelRuntime ??
    ((loadConfiguredProviders ?? true)
      ? await createModelRuntimeFromConfig({ homeDir })
      : undefined);

  return {
    ...engine,
    ...(extraSubagentProfiles !== undefined ? { extraSubagentProfiles } : {}),
    harness: async (scope) => {
      // Disk sessions under <homeDir>/sessions; diagnostics roll on disk under <homeDir>/logs.
      scope.register(Tokens.SessionRepository, new DiskSessionRepository(homeDir));
      scope.register(Tokens.Logger, logger ?? sinkLogger(new RotatingFileSink({ path: resolveGlobalLogPath({ homeDir }) })), { owned: false });
      if (pluginManager !== undefined) scope.register(Tokens.PluginManager, pluginManager, { owned: false });
      // What `ExtensionHost.registerProvider` mutates, and where a session's model is looked up.
      if (runtime !== undefined) scope.register(Tokens.ModelRuntime, runtime, { owned: false });
      await harness?.(scope);
    },
    // One per working directory, shared by its sessions: the MCP connections (workspace servers +
    // enabled plugin servers), the skill scan, and the OAuth credential store (on local disk,
    // 0600, under `<homeDir>/credentials/mcp`).
    workspace: async (scope, ctx) => {
      const oauthService = new McpOAuthService({ homeDir });
      scope.register(Tokens.McpOAuth, oauthService, { owned: false });
      const configs = { ...(mcpServers ?? {}), ...(pluginManager?.mcpServerConfigs() ?? {}) };
      if (Object.keys(configs).length > 0) {
        const servers = createMcpServers(configs, { oauthService });
        // A workspace has no session and no event sink of its own: failures surface through
        // `onStatusChange`, which each session subscribes to when it views this set.
        await servers.connect({ sessionId: "" });
        scope.register(Tokens.McpServers, servers, { dispose: () => servers.shutdown() });
      }
      // The host's hook runs BEFORE the skill scan so it can say what environment this workspace
      // executes on (`Tokens.WorkspaceEnvironmentFactory`) — or register its own `Tokens.SkillRegistry`.
      await workspace?.(scope, ctx);
      // Skills follow the workspace's EXECUTION environment, not the host's disk: the catalog the
      // model sees must be the one whose scripts its Bash can reach. A remote workspace
      // registers its environment above and the scan runs through it; absent that, the harness's
      // default (`Tokens.EnvironmentFactory`, read through the parent chain) is what sessions here will
      // execute on — the same precedence `Session.open` resolves. An environment FACTORY (one
      // environment per session) has no single filesystem to scan — no shared registry then; each
      // session scans through its own `Tokens.Environment` (`defaultCapabilities` without `Tokens.SkillRegistry`).
      if (!scope.hasLocal(Tokens.SkillRegistry)) {
        const workspaceEnvironment = scope.get(Tokens.WorkspaceEnvironmentFactory) ?? scope.get(Tokens.EnvironmentFactory) ?? new LocalEnvironment(ctx.workDir);
        if (typeof workspaceEnvironment !== "function") {
          const registry = new SkillRegistry();
          await loadSkillRoots(workspaceEnvironment, registry, {
            ...(pluginManager !== undefined ? { roots: pluginManager.skillRoots(), includeDefaultRoots: true } : {}),
          });
          scope.register(Tokens.SkillRegistry, registry, { owned: false });
        }
      }
    },
    session:
      session ??
      ((scope, ctx) =>
        defaultCapabilities({
          scope,
          ownEnvironment: ctx.ownEnvironment,
          // `createSession({ mcpServers })` — layered over the workspace's shared connections.
          ...(ctx.mcpServers !== undefined ? { sessionMcpServers: ctx.mcpServers } : {}),
          ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
          ...(pluginManager !== undefined ? { pluginManager } : {}),
          ...(hooks !== undefined ? { hooks } : {}),
        })),
    // Cron rides the extension channel now: LOCAL deployments attach it, the server profile
    // simply doesn't — Invariant 7 ("cron is local-only") is structural, not an option to pass.
    extensions: [cronExtension(), ...(extensions ?? [])],
  };
}

/**
 * The local entry point: one harness per process, one `createSession()` per conversation on it.
 * Its `close()` closes those sessions and then the harness scope — the cron timer, the workspace
 * MCP connections and the rotating log handle all live there, so nothing else tears them down.
 */
export async function createLocalHarness<TContext = unknown>(
  options: LocalDeploymentOptions<TContext>,
): Promise<Harness<TContext>> {
  return createHarness<TContext>(await localHarnessOptions(options));
}
