/**
 * The local composition root — every convention a single-environment, single-operator app runs on,
 * bundled in one place: disk sessions under `<homeDir>/sessions`, the local environment, a rotating
 * file log, file-backed MCP credentials, disk-discovered agent profiles, and the cron extension.
 *
 * It is a PRESET: pure data in (`LocalDeploymentOptions`), the three composition hooks out.
 * The `harness` hook registers the process-lived objects on the harness scope; the `sessionCapabilities`
 * hook builds each session's capability set. A hosted deployment writes its own preset the same
 * way (see `examples/managed-agents`) — there is still no "mode" inside the engine
 * (Architecture Invariant 7): this file only picks backends, and returns plain `HarnessOptions`
 * nothing downstream can distinguish.
 */
import { homedir } from "node:os";
import { cronExtension } from "./cron/index.ts";
import { createModelManagerFromConfig } from "./providers.ts";
import type { ModelManager } from "operon-agents-core";
import { join, resolve } from "node:path";
import {
  type HarnessConfig,
  type HookDef,
  type Logger,
  type McpServerConfig,
  type PluginManager,
  DiskSessionRepository,
  LocalEnvironment,
  McpOAuthService,
  RotatingFileSink,
  SkillRegistry,
  createMcpServers,
  hookDefsFromConfig,
  loadSkillRoots,
  loadHarnessConfig,
  loadAgentProfiles,
  resolveGlobalLogPath,
  sinkLogger,
} from "operon-agents-core";
import type { McpServersHandle } from "operon-agents-core";
import {
  createHarness,
  defaultCapabilities,
  type Harness,
  type HarnessOptions,
  type HarnessInfrastructure,
} from "./harness.ts";

export interface LocalDeploymentOptions<TContext = unknown> extends Omit<HarnessOptions<TContext>, "config"> {
  /**
   * App home root — sessions (`<homeDir>/sessions`), MCP creds, logs, and disk-discovered agent
   * profiles all live under it. Defaults to `~/.agents`. (`homeDir` is a local-deployment concept;
   * the harness itself only knows `HarnessInfrastructure.sessionRepository`.)
   */
  readonly homeDir?: string;
  readonly config?: HarnessConfig;
  /**
   * MCP servers every session sees unless its own configuration says otherwise — the same thing as
   * `config.defaults.mcp.servers`, which these are laid over. Connected once for the process.
   */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Installed-plugin manager, if any. Loaded once here, then handed out as `HarnessInfrastructure.pluginManager`. */
  readonly pluginManager?: PluginManager;
  /** Shell hooks already built as HookDefs, run for every session ahead of the ones its
   *  configuration names (`config.defaults.hooks`, or a session's own). */
  readonly hooks?: readonly HookDef[];
  /** Discover agent profiles from disk (`<homeDir>/agents` + `<cwd>/.agents/agents`). Default true. */
  readonly loadDiskProfiles?: boolean;
  /** Diagnostics logger. Defaults to a rotating file under `<homeDir>/logs`. */
  readonly logger?: Logger;
  /** Context budget for the default compaction capability. */
  readonly maxContextTokens?: number;
  /** {@link HarnessOptions.modelManager}. Omitted, it is built from `<homeDir>/providers.toml`. */
  readonly modelManager?: ModelManager;
  /** Skip reading `<homeDir>/providers.toml` entirely. Ignored when `modelManager` is given. */
  readonly loadConfiguredProviders?: boolean;
}

/**
 * Build `HarnessOptions` wired for a local, single-environment deployment.
 *
 * Configuration is whatever the caller passes as `config`. Without one the preset reads the
 * `config.toml` files itself — `loadHarnessConfig({ homeDir, cwd })`, user < project < local. A host
 * that wants the files plus its own adjustments loads them, edits the result, and passes it.
 */
export async function localHarnessOptions<TContext>(
  options: LocalDeploymentOptions<TContext>,
): Promise<HarnessOptions<TContext>> {
  const { homeDir: home, mcpServers, pluginManager, hooks, loadDiskProfiles, logger, maxContextTokens, modelManager, loadConfiguredProviders, infrastructure, sessionCapabilities, extensions, ...engine } = options;
  // Filled by the `infrastructure` half below, read by the `sessionCapabilities` half — one process, one set.
  let sharedParts: HarnessInfrastructure = {};
  // Set when the shared skill scan ran through a LocalEnvironment at the default workDir (the host
  // named no environment): that catalog only describes sessions rooted there.
  let sharedSkillsWorkDir: string | undefined;
  const homeDir = home ?? join(homedir(), ".agents");
  // The servers every session sees by default are one set, however they were named: in the
  // configuration, or through this preset's own option. A session that names its servers replaces it.
  const loadedConfig = options.config ?? await loadHarnessConfig({ homeDir, cwd: process.cwd() });
  const configured = loadedConfig.defaults.mcp;
  const defaultServers = configured === false ? undefined : { ...(configured?.servers ?? {}), ...(mcpServers ?? {}) };
  const config: HarnessConfig = {
    ...loadedConfig,
    defaults: {
      ...loadedConfig.defaults,
      ...(defaultServers !== undefined && Object.keys(defaultServers).length > 0 ? { mcp: { servers: defaultServers } } : {}),
    },
    // One user, one disk: the session store is exactly as trusted as the config file beside it,
    // so a server's inline secret may be stored with the session it was given to.
    policy: { allowInlineMcpSecrets: true, ...(loadedConfig.policy ?? {}) },
  };
  // Agent profiles come from disk here; the server preset supplies them externally instead.
  const extraSubagentProfiles =
    options.extraSubagentProfiles ??
    ((loadDiskProfiles ?? true)
      ? await loadAgentProfiles({ homeDir, cwd: config.workDir ?? process.cwd() })
      : undefined);
  // Installed plugins are read ONCE per process, not per session: the manager is a harness-tier
  // object, and `session.plugins.reload()` is the explicit refresh.
  if (pluginManager !== undefined) await pluginManager.load();
  // Configured endpoints are resolved once per harness, not per session: the registry is a
  // harness-tier object, and a session only ever reads it.
  const runtime =
    modelManager ??
    ((loadConfiguredProviders ?? true)
      ? await createModelManagerFromConfig({ homeDir })
      : undefined);

  return {
    ...engine,
    config,
    ...(extraSubagentProfiles !== undefined ? { extraSubagentProfiles } : {}),
    ...(runtime !== undefined ? { modelManager: runtime } : {}),
    infrastructure: async () => {
      // Disk sessions under <homeDir>/sessions; diagnostics roll on disk under <homeDir>/logs.
      // The MCP connections, the skill scan and the OAuth store are process-wide: one set for
      // every session this harness opens, built once, here.
      const oauthService = new McpOAuthService({ homeDir });
      const configs = { ...(defaultServers ?? {}), ...(pluginManager?.mcpServerConfigs() ?? {}) };
      let servers: McpServersHandle | undefined;
      if (Object.keys(configs).length > 0) {
        servers = createMcpServers(configs, { oauthService });
        // The set has no session and no event sink of its own: failures surface through
        // `onStatusChange`, which each session subscribes to when it views it.
        await servers.connect({ sessionId: "" });
      }
      const fromHost = await infrastructure?.();
      // Skills follow the EXECUTION environment, not the host's disk: the catalog the model sees
      // must be the one whose scripts its Bash can reach. A host that named an environment above
      // is scanned through it; an environment FACTORY (one per session) has no single filesystem
      // to scan, so there is no shared registry then and each session scans through its own.
      //
      // A host that named none gets NO harness-wide environment: each session runs in a
      // LocalEnvironment at its own workDir (the harness's fallback). The shared scan then goes
      // through the default workDir and is reused only by sessions rooted there.
      const hostEnvironment = fromHost?.environment;
      const defaultWorkDir = resolve(config.workDir ?? process.cwd());
      const scanEnvironment = hostEnvironment ?? new LocalEnvironment(defaultWorkDir);
      let skillRegistry = fromHost?.skillRegistry;
      if (skillRegistry === undefined && typeof scanEnvironment !== "function") {
        skillRegistry = new SkillRegistry();
        await loadSkillRoots(scanEnvironment, skillRegistry, {
          ...(pluginManager !== undefined ? { roots: pluginManager.skillRoots(), includeDefaultRoots: true } : {}),
        });
        if (hostEnvironment === undefined) sharedSkillsWorkDir = defaultWorkDir;
      }
      sharedParts = {
        sessionRepository: new DiskSessionRepository(homeDir),
        logger: logger ?? sinkLogger(new RotatingFileSink({ path: resolveGlobalLogPath({ homeDir }) })),
        oauthService,
        ...(hostEnvironment !== undefined ? { environment: hostEnvironment } : {}),
        // With the configurations beside the connections, a session whose own setup names one of
        // these very servers views the shared connection instead of opening a second one.
        ...(servers !== undefined ? { mcpServers: servers, mcpServerConfigs: configs } : {}),
        ...(skillRegistry !== undefined ? { skillRegistry } : {}),
        ...(pluginManager !== undefined ? { pluginManager } : {}),
        ...fromHost,
        close: async () => {
          await fromHost?.close?.();
          await servers?.shutdown();
        },
      };
      return sharedParts;
    },
    sessionCapabilities:
      sessionCapabilities ??
      ((ctx) =>
        defaultCapabilities({
          // What the session sees is its configuration's to say — isolation and credentials
          // included; where a connection comes from (the process's shared set, or the session's
          // own) follows from that.
          session: ctx,
          shared: sessionSharedParts(sharedParts, sharedSkillsWorkDir, ctx.workDir),
          ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
          ...(pluginManager !== undefined ? { pluginManager } : {}),
          hooks: [...(hooks ?? []), ...hookDefsFromConfig(ctx.config.hooks ?? [])],
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
export async function createLocalHarness<TContext = unknown, TOutput = unknown>(
  options: LocalDeploymentOptions<TContext>,
): Promise<Harness<TContext, TOutput>> {
  return createHarness<TContext>(await localHarnessOptions(options)) as Harness<TContext, TOutput>;
}

/** The shared parts a session may reuse: all of them, less a skill catalog scanned for another workDir. */
function sessionSharedParts(parts: HarnessInfrastructure, skillsWorkDir: string | undefined, workDir: string): HarnessInfrastructure {
  if (skillsWorkDir === undefined || resolve(workDir) === skillsWorkDir) return parts;
  const { skillRegistry: _skillRegistry, ...rest } = parts;
  return rest;
}
