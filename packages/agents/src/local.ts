/**
 * The local composition root — every convention a single-machine, single-operator app runs on,
 * bundled in one place: disk sessions under `<homeDir>/sessions`, the local machine, a rotating
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
import { join } from "node:path";
import {
  type HookDef,
  type Logger,
  type McpServerConfig,
  type PluginManager,
  DiskSessionRepository,
  LocalMachine,
  McpOAuthService,
  RotatingFileSink,
  SkillRegistry,
  T,
  createMcpServers,
  loadSkillRoots,
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
   * the harness itself only knows `T.SessionRepository`.)
   */
  readonly homeDir?: string;
  /** Workspace MCP servers to expose. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Installed-plugin manager, if any. Loaded once here, then registered as `T.PluginManager`. */
  readonly pluginManager?: PluginManager;
  /** Shell hooks from config (`config.hooks`), projected as HookDefs. */
  readonly hooks?: readonly HookDef[];
  /** Discover agent profiles from disk (`<homeDir>/agents` + `<cwd>/.agents/agents`). Default true. */
  readonly loadDiskProfiles?: boolean;
  /** Diagnostics logger. Defaults to a rotating file under `<homeDir>/logs`. */
  readonly logger?: Logger;
  /** Context budget for the default compaction capability. */
  readonly maxContextTokens?: number;
}

/** Build `HarnessOptions` wired for a local, single-machine deployment. */
export async function localHarnessOptions<TContext>(
  options: LocalDeploymentOptions<TContext>,
): Promise<HarnessOptions<TContext>> {
  const { homeDir: home, mcpServers, pluginManager, hooks, loadDiskProfiles, logger, maxContextTokens, harness, workspace, session, extensions, ...engine } = options;
  const homeDir = home ?? join(homedir(), ".agents");
  // Agent profiles come from disk here; the server preset supplies them externally instead.
  const extraSubagentProfiles =
    options.extraSubagentProfiles ??
    ((loadDiskProfiles ?? true)
      ? await loadAgentProfiles({ homeDir, cwd: options.workDir ?? process.cwd() })
      : undefined);
  // Installed plugins are read ONCE per process, not per session: the manager is a harness-tier
  // object, and `session.reloadPlugins()` is the explicit refresh.
  if (pluginManager !== undefined) await pluginManager.load();

  return {
    ...engine,
    ...(extraSubagentProfiles !== undefined ? { extraSubagentProfiles } : {}),
    harness: async (scope) => {
      // Disk sessions under <homeDir>/sessions; diagnostics roll on disk under <homeDir>/logs.
      scope.register(T.SessionRepository, new DiskSessionRepository(homeDir));
      scope.register(T.Logger, logger ?? sinkLogger(new RotatingFileSink({ path: resolveGlobalLogPath({ homeDir }) })), { owned: false });
      if (pluginManager !== undefined) scope.register(T.PluginManager, pluginManager, { owned: false });
      await harness?.(scope);
    },
    // One per working directory, shared by its sessions: the MCP connections (workspace servers +
    // enabled plugin servers), the skill scan, and the OAuth credential store (on local disk,
    // 0600, under `<homeDir>/credentials/mcp`).
    workspace: async (scope, ctx) => {
      const oauthService = new McpOAuthService({ homeDir });
      scope.register(T.McpOAuth, oauthService, { owned: false });
      const configs = { ...(mcpServers ?? {}), ...(pluginManager?.mcpServerConfigs() ?? {}) };
      if (Object.keys(configs).length > 0) {
        const servers = createMcpServers(configs, { oauthService });
        await servers.connect({ scope, sessionId: "" });
        scope.register(T.McpServers, servers, { dispose: () => servers.shutdown() });
      }
      // The host's hook runs BEFORE the skill scan so it can say what machine this workspace
      // executes on (`T.WorkspaceMachineFactory`) — or register its own `T.SkillRegistry`.
      await workspace?.(scope, ctx);
      // Skills follow the workspace's EXECUTION machine, not the host's disk: the catalog the
      // model sees must be the one whose scripts its Bash can reach. A remote workspace
      // registers its machine above and the scan runs through it; absent that, the harness's
      // default (`T.MachineFactory`, read through the parent chain) is what sessions here will
      // execute on — the same precedence `Session.open` resolves. A machine FACTORY (one
      // machine per session) has no single filesystem to scan — no shared registry then; each
      // session scans through its own `T.Machine` (`defaultCapabilities` without `T.SkillRegistry`).
      if (!scope.hasLocal(T.SkillRegistry)) {
        const workspaceMachine = scope.get(T.WorkspaceMachineFactory) ?? scope.get(T.MachineFactory) ?? new LocalMachine(ctx.workDir);
        if (typeof workspaceMachine !== "function") {
          const registry = new SkillRegistry();
          await loadSkillRoots(workspaceMachine, registry, {
            ...(pluginManager !== undefined ? { roots: pluginManager.skillRoots(), includeDefaultRoots: true } : {}),
          });
          scope.register(T.SkillRegistry, registry, { owned: false });
        }
      }
    },
    session:
      session ??
      ((scope, ctx) =>
        defaultCapabilities({
          scope,
          ownMachine: ctx.ownMachine,
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
