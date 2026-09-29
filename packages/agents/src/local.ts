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
import { join, resolve } from "node:path";
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
  createMcpServers,
  loadSkillRoots,
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
  type HarnessParts,
} from "./harness.ts";

export interface LocalDeploymentOptions<TContext = unknown> extends HarnessOptions<TContext> {
  /**
   * App home root — sessions (`<homeDir>/sessions`), MCP creds, logs, and disk-discovered agent
   * profiles all live under it. Defaults to `~/.agents`. (`homeDir` is a local-deployment concept;
   * the harness itself only knows `HarnessParts.sessionRepository`.)
   */
  readonly homeDir?: string;
  /** MCP servers to expose, shared by every session of the harness. */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** Installed-plugin manager, if any. Loaded once here, then handed out as `HarnessParts.pluginManager`. */
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
  const { homeDir: home, mcpServers, pluginManager, hooks, loadDiskProfiles, logger, maxContextTokens, modelRuntime, loadConfiguredProviders, harness, session, extensions, ...engine } = options;
  // Filled by the `harness` half below, read by the `session` half — one process, one set.
  let sharedParts: HarnessParts = {};
  // Set when the shared skill scan ran through a LocalEnvironment at the default workDir (the host
  // named no environment): that catalog only describes sessions rooted there.
  let sharedSkillsWorkDir: string | undefined;
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
    harness: async () => {
      // Disk sessions under <homeDir>/sessions; diagnostics roll on disk under <homeDir>/logs.
      // The MCP connections, the skill scan and the OAuth store are process-wide: one set for
      // every session this harness opens, built once, here.
      const oauthService = new McpOAuthService({ homeDir });
      const configs = { ...(mcpServers ?? {}), ...(pluginManager?.mcpServerConfigs() ?? {}) };
      let servers: McpServersHandle | undefined;
      if (Object.keys(configs).length > 0) {
        servers = createMcpServers(configs, { oauthService });
        // The set has no session and no event sink of its own: failures surface through
        // `onStatusChange`, which each session subscribes to when it views it.
        await servers.connect({ sessionId: "" });
      }
      const fromHost = await harness?.();
      // Skills follow the EXECUTION environment, not the host's disk: the catalog the model sees
      // must be the one whose scripts its Bash can reach. A host that named an environment above
      // is scanned through it; an environment FACTORY (one per session) has no single filesystem
      // to scan, so there is no shared registry then and each session scans through its own.
      //
      // A host that named none gets NO harness-wide environment: each session runs in a
      // LocalEnvironment at its own workDir (the harness's fallback). The shared scan then goes
      // through the default workDir and is reused only by sessions rooted there.
      const hostEnvironment = fromHost?.environment;
      const defaultWorkDir = resolve(options.workDir ?? process.cwd());
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
        ...(servers !== undefined ? { mcpServers: servers } : {}),
        ...(skillRegistry !== undefined ? { skillRegistry } : {}),
        ...(pluginManager !== undefined ? { pluginManager } : {}),
        // What `ExtensionHost.registerProvider` mutates, and where a session's model is looked up.
        ...(runtime !== undefined ? { modelRuntime: runtime } : {}),
        ...fromHost,
        close: async () => {
          await fromHost?.close?.();
          await servers?.shutdown();
        },
      };
      return sharedParts;
    },
    session:
      session ??
      ((ctx) =>
        defaultCapabilities({
          shared: sessionSharedParts(sharedParts, sharedSkillsWorkDir, ctx.workDir),
          ownEnvironment: ctx.ownEnvironment,
          // `createSession({ mcpServers })` — layered over the process-shared connections.
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

/** The shared parts a session may reuse: all of them, less a skill catalog scanned for another workDir. */
function sessionSharedParts(parts: HarnessParts, skillsWorkDir: string | undefined, workDir: string): HarnessParts {
  if (skillsWorkDir === undefined || resolve(workDir) === skillsWorkDir) return parts;
  const { skillRegistry: _skillRegistry, ...rest } = parts;
  return rest;
}
