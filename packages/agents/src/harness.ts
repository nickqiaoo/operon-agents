/**
 * Mode 2 — batteries-included, in-process Harness facade.
 *
 * Wraps the `operon-agents-core` engine into the kind of ergonomic interface a CLI
 * backend wants: `createHarness()` manages sessions, and each session exposes
 * `prompt()/steer()/followUp()/cancel()/onEvent()/setApprovalHandler()` plus the full
 * control plane (goals, plan mode, compaction, skills, plugins, …) delegated to
 * the core `Session`.
 *
 * It is a pure composition of core primitives — no new engine behavior. The low-level
 * primitives for the "assemble it yourself / stateless server" path are exported from
 * `operon-agents` too.
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeDeadlines } from "./harness-test-hooks.ts";
import { readTranscriptPage, type TranscriptPage, type TranscriptPageOptions } from "operon-agents-core";
import { type AgentEvent, type AgentRecord,type EventPublicationMode, type TelemetryService, type AgentEventListener, type AgentInput, readSessionTails, SessionProjection, type SessionSnapshot, type SnapshotOptions, type DirectoryEntry, type ProjectionObservation, type ProjectionListener, type ApprovalRequest, type ApprovalResponse, type Capability, type InterruptAnswer, type ChatModel, type ModelSettings, type RunOptions, ListenerSink, type AutoApprover, type PermissionMode, type PermissionRule, type PendingRunInterrupt, type QuestionRequest, type QuestionResult, type Responder, type RunHandle, type RunResult, type SessionStore, type SessionHandle, type SessionSummary, type ListSessionsFilter, type CreateSessionInput, type OpenSessionOptions, type DeleteSessionOptions, type ThinkingLevel, type Tool, type PromptOrigin, type SteerMessage, type SteerOptions, type SteerOrigin, type SteerReceipt, Agent, buildAgentFromProfile, INTERRUPTION_STATE_KEY, flattenPendingInterrupts, parseInterruptionState, Runner, Session, emptyUsage, isGuardrailTripwireError, type GuardrailTripwireError, askUserQuestionTool, createAutoApprover, createModelManager, backgroundCapability, compactionCapability, filesystemTools, goalCapability, LocalEnvironment, McpOAuthService, MemorySessionRepository, SessionRepositoryNotFoundError, SessionBusyError, SessionClosedError, SessionInterruptedError, SessionNotInterruptedError, SteerTargetNotFoundError, isAbortError, planCapability, skillsCapability, SkillRegistry, mcpServersCapability, pluginsCapability, userHooksCapability, type HookDef, type McpServerConfig, type McpTransportKind, type McpCredentialProvider, type PluginManager, type ApprovalRequestOptions, type Environment, type EnvironmentFactory, type ActivateSkillRequest, type SessionRepository, type ResolvedAgentProfile, taskCapability, workflowCapability, DEFAULT_AGENT_PROFILES, DEFAULT_AGENT_PROFILE_NAME, DEFAULT_SUBAGENT_NAMES, profileSubagentProvider, type SubagentProvider, DEFAULT_ADDRESS, envLogger, noopLogger, parseSessionConfig, resolveSessionConfig, inlineMcpSecretPaths, sessionPolicyViolation, hookDefsFromConfig, SessionPolicySchema, SESSION_MODEL_KEY, SESSION_PERMISSION_KEY, SESSION_THINKING_KEY, type SessionConfig, type HarnessConfig, type SessionPolicy, type SessionMcpConfig, type SkillsConfig } from "operon-agents-core";
import { recoverOrphanedTurns } from "operon-agents-core/internal";
import type {
  TodoStore,
  SkillsService,
  CompactionService,
  BackgroundManager,
  McpServersHandle,
  McpServersCapabilityOptions,
  GoalStore,
  PlanMode,
  Logger,
  ModelManager,
  TracingProcessor,
} from "operon-agents-core";
import { mkdirSync } from "node:fs";
import { workspaceMcpCapability, type WorkspaceMcpPool } from "./workspace-mcp.ts";
import { join } from "node:path";
import { extensionCapability, extensionRuntimeOf, extensionsCapability, HarnessExtensionManager, type ExtensionRuntime, ServiceRegistry, stageDefinition, type ExtensionDefinition, type ExtensionHost, type ExtensionInheritedSetting, type ExtensionSettingsStore, type ServiceOptions, type StagedDefinition, createFileSettingsStore } from "./extensions/index.ts";
import { createExtensionCommandRegistry, type CommandRegistry, type CommandResult, type TodoItem } from "operon-agents-core";

export type ApprovalHandler = (
  request: ApprovalRequest,
  options?: ApprovalRequestOptions,
) => Promise<ApprovalResponse> | ApprovalResponse;
export type QuestionHandler = (
  request: QuestionRequest,
  options?: { readonly signal?: AbortSignal },
) => Promise<QuestionResult> | QuestionResult;

/**
 * What a session may do without asking. `mode` picks the baseline, `rules` allow or deny specific
 * tools on top of it, and `autoApprover` is the judge the `auto` mode consults.
 */
export interface HarnessPermissionOptions {
  readonly mode?: PermissionMode;
  readonly rules?: readonly PermissionRule[];
  readonly autoApprover?: AutoApprover;
}


/** The harness has been closed and can open nothing further. */
export class HarnessClosedError extends Error {
  constructor() {
    super("harness is closed");
    this.name = "HarnessClosedError";
  }
}

/** Another harness-wide operation is in progress. */
export class HarnessBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessBusyError";
  }
}

/** The harness or session options cannot work as given. */
export class HarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessConfigError";
  }
}

/**
 * `resumeSession(id, options)` was asked to restore a session that is already loaded. Options
 * cannot be applied to an existing instance without dropping them, so this is refused: attach with
 * `resumeSession(id)` (no options), or close the session first to restore it differently.
 */
export class SessionAlreadyLoadedError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session "${sessionId}" is already loaded, so the options given cannot be applied to it; call resumeSession(id) without options to get the loaded session, or close it first`);
    this.name = "SessionAlreadyLoadedError";
    this.sessionId = sessionId;
  }
}

/** The same refusal while a load of that session is in flight: `resumeSession(id)` joins it. */
export class SessionAlreadyLoadingError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session "${sessionId}" is already being loaded, so the options given cannot be applied to it; call resumeSession(id) without options to join that load`);
    this.name = "SessionAlreadyLoadingError";
    this.sessionId = sessionId;
  }
}

/**
 * A session was created on a live object — a sandbox, a credential provider, an agent built in code —
 * that nobody provides on this open. The harness does not substitute a default: a sandboxed session
 * restored onto the host's own filesystem is not the same session. Provide it through `bindings` or
 * `resolveSession`.
 */
export class SessionDependencyMissingError extends Error {
  readonly sessionId: string;
  readonly missing: readonly SessionBindingKey[];
  constructor(sessionId: string, missing: readonly SessionBindingKey[]) {
    super(`session "${sessionId}" needs ${missing.join(", ")} provided when it is opened (through \`bindings\` or \`resolveSession\`); the harness does not substitute a default`);
    this.name = "SessionDependencyMissingError";
    this.sessionId = sessionId;
    this.missing = missing;
  }
}

/** A session's configuration asks for something the harness's policy does not allow. */
export class SessionPolicyViolationError extends Error {
  readonly sessionId: string;
  readonly field: string;
  constructor(sessionId: string, field: string, reason: string) {
    super(`session "${sessionId}": ${reason}`);
    this.name = "SessionPolicyViolationError";
    this.sessionId = sessionId;
    this.field = field;
  }
}

/**
 * The live objects one open of a session runs on — what cannot be written down. Never stored: a
 * later open provides them again, directly or through `resolveSession`. An object given here wins
 * over the same thing named in the session's configuration (`agent`, `model`, `tools`).
 */
export interface SessionBindings<TContext = unknown> {
  /** Host application context for this session's runs. Absent, the harness's own applies. */
  readonly context?: TContext;
  /** Where this session's tools execute. The session only operates it; see `release`. */
  readonly environment?: Environment | EnvironmentFactory;
  /** Where this session's http MCP servers get their credentials, asked on every connect. */
  readonly mcpCredentials?: McpCredentialProvider;
  /** A complete agent, instead of one named in the configuration or the default. */
  readonly agent?: Agent<TContext>;
  /** A built model — how one session gets its own API key. */
  readonly model?: ChatModel;
  /** Concrete tools for this session's default agent, instead of names from the registry. */
  readonly tools?: readonly Tool[];
  readonly subagentProvider?: SubagentProvider<TContext>;
  readonly extraSubagentProfiles?: Record<string, ResolvedAgentProfile>;
  /**
   * Give back what these bindings acquired. Called exactly once: when the session closes, or when
   * its open fails after the bindings were handed over. What "give back" means — destroy a
   * sandbox, return it to a pool, drop a reference — is the provider's. Absent, nothing is done.
   */
  release?(): void | Promise<void>;
}

/** The kinds of live object a session can depend on being provided again. */
export type SessionBindingKey = "environment" | "mcpCredentials" | "agent" | "model" | "tools" | "subagentProvider";
const SESSION_BINDING_KEYS: readonly SessionBindingKey[] = ["environment", "mcpCredentials", "agent", "model", "tools", "subagentProvider"];

export type SessionOperation = "create" | "restore" | "fork";

/** Who asked for a session to be opened: the host's own code, an extension, or a remote client. */
export type SessionOrigin = { readonly kind: "host" } | { readonly kind: "extension"; readonly extensionId: string } | { readonly kind: "remote" };

/** The session being opened, as its durable record names it. */
export interface SessionIdentity {
  readonly id: string;
  readonly workDir: string;
  readonly ownerKey?: string;
  readonly title?: string;
}

export interface SessionResolveRequest<TContext = unknown> {
  readonly operation: SessionOperation;
  readonly origin: SessionOrigin;
  readonly session: SessionIdentity;
  /** The session a fork copies, or the one an extension is creating this session from. */
  readonly source?: { readonly id: string; readonly workDir: string; readonly ownerKey?: string };
  /** What this call handed in directly. */
  readonly requested: { readonly config?: SessionConfig; readonly bindings: SessionBindings<TContext> };
  /** The setup stored with the session (a restore or a fork), runtime changes included. */
  readonly stored?: SessionConfig;
  /** Aborted when the harness closes. */
  readonly signal: AbortSignal;
}

/**
 * What the host resolves for one open. A `config` returned here is FINAL — the host saw what was
 * requested and what was stored and decided — and is not stored by the harness, so a host that
 * keeps configuration in its own database has exactly one copy. What IS stored is unchanged by
 * it: a reopen keeps the setup the session had, and a create stores what it was asked for (its
 * `requested.config` — for a session an extension creates, that extension's parameters), so the
 * next open's `stored` still carries it. `bindings` are laid over the requested ones key by key.
 */
export interface SessionResolution<TContext = unknown> {
  readonly config?: SessionConfig;
  readonly bindings?: SessionBindings<TContext>;
}

export interface SessionOpenInfo {
  readonly operation: SessionOperation;
  readonly origin: SessionOrigin;
  readonly source?: { readonly id: string; readonly workDir: string; readonly ownerKey?: string };
}

export type SessionOpenedListener<TContext = unknown> = (
  session: HarnessSession<TContext>,
  info: SessionOpenInfo,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

interface SessionSource {
  readonly id: string;
  readonly workDir: string;
  readonly ownerKey?: string;
  readonly requires: readonly SessionBindingKey[];
}

interface OpenRequest<TContext> {
  /** `config` as given, validated. On a resume it replaces the stored setup. */
  readonly config?: SessionConfig;
  readonly bindings: SessionBindings<TContext>;
  readonly hasContext: boolean;
  readonly origin: SessionOrigin;
}

interface StoredSetup {
  readonly config: SessionConfig;
  readonly requires: readonly SessionBindingKey[];
  /** False for a session from before the setup was stored under its own key. */
  readonly present: boolean;
}

interface AssembleArgs<TContext> {
  readonly operation: SessionOperation;
  readonly id: string;
  readonly workDir: string;
  readonly store: SessionStore;
  readonly request: OpenRequest<TContext>;
  readonly source?: SessionSource;
  readonly ownerKey?: string;
  readonly title?: string;
  /** This open made the durable record, so a failed open removes it. */
  readonly createdRecord: boolean;
}

/** Session-store key holding a session's stored setup: `{ version, config, requires }`. */
const SESSION_CONFIG_STATE_KEY = "session:config";
const DEFAULT_PERMISSION_MODE: PermissionMode = "workspace";

/** Every key `createSession` takes — what an extension's options are checked against. */
const CREATE_SESSION_OPTION_KEYS: ReadonlySet<string> = new Set([
  "workDir", "ownerKey", "title", "config", "from", "inherit",
]);

/** What an extension's `createSession({ from, inherit })` can copy from its source. */
const INHERITABLE_SETTINGS: ReadonlySet<string> = new Set<ExtensionInheritedSetting>(["model"]);

function definedOnly<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** A session's model is remembered by the core under its own key; the stored setup holds the rest. */
function withoutModel(config: SessionConfig): SessionConfig {
  const { model: _model, thinking: _thinking, permission, ...rest } = config;
  const { mode: _mode, ...permissionConfig } = permission ?? {};
  return { ...rest, ...(Object.keys(permissionConfig).length > 0 ? { permission: permissionConfig } : {}) };
}

const DEFAULT_AGENT_ONLY_OPTIONS = ["modelSettings", "tools", "appendSystemPrompt", "maxStepsPerTurn"] as const;

/** These options shape the default agent. Given alongside a complete `agent`, they could only be ignored. */
function assertNoDefaultAgentOptions(options: { readonly [K in (typeof DEFAULT_AGENT_ONLY_OPTIONS)[number]]?: unknown }, agentGivenAt: string): void {
  const conflicting = DEFAULT_AGENT_ONLY_OPTIONS.filter((name) => options[name] !== undefined);
  if (conflicting.length === 0) return;
  throw new HarnessConfigError(`${conflicting.join(", ")} only apply to the default agent, but ${agentGivenAt} sets \`agent\`. Set them on that agent instead.`);
}

export type HarnessSessionState = "idle" | "running" | "interrupted" | "closed";

/** Rendezvous budget for `replaceExtension` when the caller names none. */
const DEFAULT_REPLACE_TIMEOUT_MS = 30_000;
/** Where the per-session extension params lived before `session:config`. Read for sessions stored
 *  back then (as `config.extensions`), never written. */
const EXTENSION_PARAMS_STATE_KEY = "extensions:params";

/** A slash command as listed by `HarnessSession.listCommands`. */
export interface CommandInfo {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

export interface HarnessSessionStatus {
  readonly state: HarnessSessionState;
  readonly activeTurnId: string | null;
  readonly hasQueuedMessages: boolean;
}

export interface DefaultCapabilitiesOptions {
  /**
   * The session this bundle is built for — the context a `sessionCapabilities` factory receives.
   * Given it, the bundle reads what that session runs on from it: the MCP servers, skills and hooks
   * its configuration names, the transports policy allows, whether it is isolated or on its own
   * environment, its credentials, and the harness's shared parts. A factory that only adds to the
   * standard bundle passes this and its additions; any option below, given too, wins over what the
   * context says.
   */
  readonly session?: SessionCapabilityContext;
  /**
   * The harness's process-shared parts. When it carries a set of MCP connections, a skill scan or
   * an OAuth service, the bundle uses THOSE instead of building per-session ones. Without it
   * everything here is built per session.
   */
  readonly shared?: HarnessInfrastructure;
  /**
   * The session brought its own environment (`bindings.environment`). The shared
   * `skillRegistry` was scanned through the HARNESS's environment and does not describe this one,
   * so the skill scan runs per session through the session's environment instead — the catalog
   * follows the filesystem the session's tools actually operate. Default false.
   */
  readonly ownEnvironment?: boolean;
  /** Context window budget used to size compaction. Defaults to 200_000. */
  readonly maxContextTokens?: number;
  /**
   * The session's MCP configuration (`SessionConfig.mcp`): `false` for none, or the COMPLETE set of
   * servers it sees — not an overlay. When given it decides visibility alone, and `mcpServers`,
   * `sessionMcpServers` and the plugins' servers are not consulted (the harness has already folded
   * what applies into it). Where each connection comes from is a separate matter: a server whose
   * configuration is identical to one the process shares (`shared.mcpServers` built from
   * `shared.mcpServerConfigs`) is viewed there; every other one is connected for this session.
   */
  readonly mcp?: SessionMcpConfig;
  /** The session's skills configuration (`SessionConfig.skills`): `false` for none, or the roots to
   *  scan for this session instead of the shared catalog. */
  readonly skills?: SkillsConfig;
  /**
   * Servers for a bundle built WITHOUT a session configuration (`mcp` above, or `session`): every
   * session this factory builds for sees them. With `mcp` they do not decide what is visible, only
   * what a directory pool may lend.
   */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /**
   * Like `mcpServers`, for a bundle built without a session configuration: servers private to the
   * one session being built, layered over the shared ones (same name: these win). Built, connected
   * and shut down with the session. A session's own servers normally arrive as `mcp` instead.
   */
  readonly sessionMcpServers?: Record<string, McpServerConfig>;
  /**
   * Share MCP connections per DIRECTORY instead of building them per session: every server this
   * bundle would otherwise connect for the session — `mcpServers`, the plugins', and `servers`
   * here (the directory's own, e.g. its `mcp.json`) — is borrowed from `pool` under `workDir`, so
   * the sessions open in one directory run one set. `sessionMcpServers` stay the session's own,
   * layered over it. Ignored when `shared.mcpServers` is set (a process-wide set already covers
   * every directory) and for a session on its own environment. See {@link WorkspaceMcpPool}.
   */
  readonly workspaceMcp?: {
    readonly pool: WorkspaceMcpPool;
    readonly workDir: string;
    readonly servers?: Record<string, McpServerConfig>;
  };
  /**
   * Installed-plugin manager. When set, the framework self-drives the plugin's contributions into
   * this capability set: its skills (merged into the skills capability), its MCP servers (merged
   * into the MCP capability), its shell hooks (merged into user-hooks), and its session-start skill
   * (rendered via a shared skill registry). Build capabilities fresh per session (a harness
   * capability factory) and load the manager first, so each session reflects the current plugin set
   * — read here at construction.
   */
  readonly pluginManager?: PluginManager;
  /**
   * Session shell hooks from config (`config.hooks`). Merged with plugin hooks when a
   * `pluginManager` is present (config first, then plugins). Wired as `userHooksCapability`.
   */
  readonly hooks?: readonly HookDef[];
  /**
   * OAuth service backing MCP servers that need it. Its credential store is the injection point:
   * a `JsonFileStore` locally, a `MemoryMcpCredentialStore` (hydrated from external storage) on a
   * server. Only consulted when an MCP capability is built.
   */
  readonly oauthService?: McpOAuthService;
  /**
   * MCP transports this host will run. Omitted means both, which is right for a local host.
   *
   * A SERVER host should pass `["http"]`. An stdio server is a child process of the harness
   * process, so it neither follows the session's environment into a sandbox nor survives the
   * replica model a server is deployed under — and `transport` defaults to `"stdio"`, so
   * leaving this unset means a config that merely forgot the field spawns a process on the
   * server. `McpTransportNotPermittedError` names the offending server at startup.
   *
   * The same reasoning as Invariant 7 (cron is a local-only capability): what a host is willing
   * to run is the host's statement, not the kernel's.
   */
  readonly allowedMcpTransports?: readonly McpTransportKind[];
  /** Credentials the host hands out per connect for this session's http MCP servers. See
   *  `McpCredentialProvider`. */
  readonly mcpCredentials?: McpCredentialProvider;
  /** How this session's own MCP connections are made, for a host with a transport of its own.
   *  Connections the session only views (the process's, a directory pool's) were made elsewhere. */
  readonly mcpTransportFactory?: McpServersCapabilityOptions["transportFactory"];
  /**
   * The session belongs to one tenant among many (a managed host's default): nothing the process
   * shares reaches it — no process-wide MCP set, skill scan, OAuth service or directory pool —
   * MCP runs over http only, and no server may read its token from the process environment.
   * Each is refused rather than skipped where skipping would hide a misconfiguration. See
   * docs/server-profile.md.
   */
  readonly strictIsolation?: boolean;
}

/**
 * The standard coding-agent capability bundle (goal / plan / todo / skills /
 * cron / background / compaction). Filesystem access is NOT here — it is a tool
 * on the agent (`filesystemTools()`), not a capability; so is AskUserQuestion
 * (`askUserQuestionTool`, wired through ToolRunContext.responder).
 *
 * With `mcpServers`, `sessionMcpServers` and/or `pluginManager`, an MCP capability is added; with `pluginManager`, the
 * plugin's skills/MCP/session-start are wired in too. Intended to be called fresh per session (via
 * a harness capability factory) so per-session state (goal/plan/todo/…) and the plugin set are
 * isolated per session, mirroring a fresh-Session-per-create model.
 */
export function defaultCapabilities(given: DefaultCapabilitiesOptions = {}): Capability[] {
  const options = given.session === undefined ? given : { ...optionsOfSession(given.session), ...definedOnly({ ...given }) };
  const manager = options.pluginManager ?? options.shared?.pluginManager;
  // A session on its own environment ignores the process-wide registry: it was scanned elsewhere.
  const strict = options.strictIsolation === true;
  // A session on its own environment, or one tenant among many, gets nothing the process shares.
  const isolated = strict || options.ownEnvironment === true;
  const sharedSkills = isolated ? undefined : options.shared?.skillRegistry;
  const sharedServers = isolated ? undefined : options.shared?.mcpServers;
  const oauthService = options.oauthService ?? (strict ? undefined : options.shared?.oauthService);
  const allowedMcpTransports: readonly McpTransportKind[] | undefined = strict
    ? (options.allowedMcpTransports ?? ["http", "stdio"]).filter((kind) => kind === "http")
    : options.allowedMcpTransports;
  // Shared registry so the plugin session-start injector can render a skill the skills capability
  // loaded (its roots include the plugin skill dirs below). A process-wide registry is scanned
  // once for every session; a session-level one is scanned here.
  const registry = sharedSkills ?? (manager !== undefined ? new SkillRegistry() : undefined);
  // `includeDefaultRoots` because the plugin dirs ADD to the project/user `.agents/skills` roots —
  // without it, enabling a single skill-bearing plugin would hide every local skill.
  const ownSkills = options.skills !== undefined && options.skills !== false ? options.skills : undefined;
  const skills =
    options.skills === false
      ? undefined
      : ownSkills !== undefined && (ownSkills.roots !== undefined || ownSkills.includeDefaultRoots !== undefined)
        // The session names its own roots: scanned for it, the shared catalog does not apply.
        ? skillsCapability({
            ...(manager !== undefined ? { registry } : {}),
            roots: [...(ownSkills.roots ?? []).map((path) => ({ path, source: "project" as const })), ...(manager?.skillRoots() ?? [])],
            includeDefaultRoots: ownSkills.includeDefaultRoots ?? true,
          })
        : sharedSkills !== undefined
          ? skillsCapability({ registry: sharedSkills, scan: false })
          : manager !== undefined
            ? skillsCapability({ registry, roots: manager.skillRoots(), includeDefaultRoots: true })
            : skillsCapability();
  const capabilities: Capability[] = [
    goalCapability(),
    workflowCapability(),
    planCapability(),
    taskCapability(),
    ...(skills !== undefined ? [skills] : []),
    backgroundCapability(),
    compactionCapability({ maxContextTokens: options.maxContextTokens ?? 200_000 }),
  ];
  // Cron is a local-only capability (Invariant 7): the server host doesn't install it.
  const sessionMcp = options.sessionMcpServers ?? {};
  const mcpOptions = {
    ...(oauthService !== undefined ? { oauthService } : {}),
    ...(allowedMcpTransports !== undefined ? { allowedTransports: allowedMcpTransports } : {}),
    ...(options.mcpCredentials !== undefined ? { credentials: options.mcpCredentials } : {}),
    ...(options.mcpTransportFactory !== undefined ? { transportFactory: options.mcpTransportFactory } : {}),
  };
  // Everything this session would connect that is not private to it: the directory's servers
  // last, so they win over a same-named plugin server the way they did as a session overlay.
  const shareable = {
    ...(options.mcpServers ?? {}),
    ...(manager?.mcpServerConfigs() ?? {}),
    ...(options.workspaceMcp?.servers ?? {}),
  };
  if (strict) {
    // The process environment has no tenant boundary: a token read from it is every tenant's.
    for (const [name, config] of Object.entries({ ...shareable, ...sessionMcp })) {
      if (config.bearerTokenEnvVar !== undefined) {
        throw new HarnessConfigError(`MCP server "${name}" reads its token from the process environment (bearerTokenEnvVar), which every tenant on this host shares; hand it out per session with mcpCredentials instead.`);
      }
    }
  }
  const pooled = sharedServers === undefined && !isolated ? options.workspaceMcp : undefined;
  if (options.mcp !== undefined) {
    // The session's configuration names what it sees. `false`: nothing, and no MCP capability.
    if (options.mcp !== false) {
      const visible = options.mcp.servers;
      if (strict) {
        for (const [name, config] of Object.entries(visible)) {
          if (config.bearerTokenEnvVar !== undefined) {
            throw new HarnessConfigError(`MCP server "${name}" reads its token from the process environment (bearerTokenEnvVar), which every tenant on this host shares; hand it out per session with mcpCredentials instead.`);
          }
        }
      }
      // A connection is shared only when it IS the same server: same name, same configuration.
      const sharedConfigs = sharedServers !== undefined ? options.shared?.mcpServerConfigs : undefined;
      const viewed = sharedConfigs === undefined
        ? []
        : Object.keys(visible).filter((name) => sharedConfigs[name] !== undefined && mcpFingerprint(sharedConfigs[name]!) === mcpFingerprint(visible[name]!));
      // Likewise a directory's pool lends what the host declared shareable there, as long as the
      // session sees that very server; anything else it sees is connected for it alone.
      const borrowed = pooled === undefined
        ? []
        : Object.keys(visible).filter((name) => shareable[name] !== undefined && mcpFingerprint(shareable[name]!) === mcpFingerprint(visible[name]!));
      const elsewhere = new Set([...viewed, ...borrowed]);
      const own = Object.fromEntries(Object.entries(visible).filter(([name]) => !elsewhere.has(name)));
      if (viewed.length > 0 && sharedServers !== undefined) {
        capabilities.push(mcpServersCapability(own, { ...mcpOptions, sharedServers: onlyServers(sharedServers, new Set(viewed)) }));
      } else if (borrowed.length > 0 && pooled !== undefined) {
        const servers = Object.fromEntries(borrowed.map((name) => [name, visible[name]!]));
        capabilities.push(workspaceMcpCapability({ pool: pooled.pool, workDir: pooled.workDir, servers, overlay: own, overlayOptions: mcpOptions }));
      } else if (Object.keys(own).length > 0) {
        capabilities.push(mcpServersCapability(own, mcpOptions));
      }
    }
  } else if (pooled !== undefined && Object.keys(shareable).length > 0) {
    // Borrowed per directory: the capability views the pool's set, `sessionMcp` is its overlay.
    capabilities.push(workspaceMcpCapability({ pool: pooled.pool, workDir: pooled.workDir, servers: shareable, overlay: sessionMcp, overlayOptions: mcpOptions }));
  } else {
    // With process-shared connections, the capability is a VIEW over them and `configs` is this
    // session's overlay. Without, everything this session sees is its own — session servers last,
    // so the same name still resolves to the session's.
    const mcpConfigs = sharedServers !== undefined ? sessionMcp : { ...shareable, ...sessionMcp };
    if (sharedServers !== undefined || Object.keys(mcpConfigs).length > 0) {
      capabilities.push(mcpServersCapability(mcpConfigs, { ...mcpOptions, ...(sharedServers !== undefined ? { sharedServers } : {}) }));
    }
  }
  // Plugins: load the manager + render the plugin's session-start skill from the shared registry
  // (skills opens before this, so by injection time the registry holds the plugin skills).
  if (manager !== undefined && registry !== undefined) {
    capabilities.push(pluginsCapability(manager, (_pluginId, skillName) => registry.getSkill(skillName)?.content));
  }
  // Shell hooks: config first, then enabled plugin hooks (single HookEngine / SessionStart injector).
  const hookDefs: HookDef[] = [
    ...(options.hooks ?? []),
    ...(manager !== undefined ? manager.hookDefs() : []),
  ];
  if (hookDefs.length > 0) {
    capabilities.push(userHooksCapability(hookDefs));
  }
  return capabilities;
}

/** What a session's context says about the standard bundle: its configuration, policy and bindings. */
function optionsOfSession(ctx: SessionCapabilityContext): DefaultCapabilitiesOptions {
  return {
    shared: ctx.shared,
    ownEnvironment: ctx.ownEnvironment,
    strictIsolation: ctx.strictIsolation,
    ...(ctx.config.mcp !== undefined ? { mcp: ctx.config.mcp } : {}),
    ...(ctx.config.skills !== undefined ? { skills: ctx.config.skills } : {}),
    ...(ctx.config.hooks !== undefined && ctx.config.hooks.length > 0 ? { hooks: hookDefsFromConfig(ctx.config.hooks) } : {}),
    ...(ctx.policy.allowedMcpTransports !== undefined ? { allowedMcpTransports: ctx.policy.allowedMcpTransports } : {}),
    ...(ctx.mcpCredentials !== undefined ? { mcpCredentials: ctx.mcpCredentials } : {}),
  };
}

/** One server's configuration, order-independent — two with the same fingerprint are the same server. */
function mcpFingerprint(config: McpServerConfig): string {
  return JSON.stringify(config, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
}

/** A view of a shared set of MCP connections limited to `names`. It connects and shuts down
 *  nothing: the set belongs to whoever built it. */
function onlyServers(shared: McpServersHandle, names: ReadonlySet<string>): McpServersHandle {
  return {
    list: () => shared.list().filter((view) => names.has(view.name)),
    listTools: async (name) => (names.has(name) ? shared.listTools(name) : []),
    reconnect: async (name) => {
      if (!names.has(name)) throw new Error(`Unknown MCP server: ${name}`);
      await shared.reconnect(name);
    },
    onStatusChange: (listener) => shared.onStatusChange((view) => {
      if (names.has(view.name)) listener(view);
    }),
    // One provider per server, in the order `list()` reports them.
    toolProviders: () => {
      const views = shared.list();
      return shared.toolProviders().filter((_provider, index) => {
        const view = views[index];
        return view !== undefined && names.has(view.name);
      });
    },
    connect: async () => {},
    shutdown: async () => {},
  };
}

/**
 * The builtin subagents (`coder` / `explore` / `plan`) the `Agent` and `Workflow` tools spawn by
 * default. The profiles declare no model, so each subagent inherits the session's model; their tool
 * names resolve against the default agent's toolset (sharing read/write/edit/grep/glob/bash).
 */
function defaultSubagentProvider<TContext>(
  agentTools: readonly Tool[],
  resolveModel: (modelId: string) => ChatModel | Promise<ChatModel>,
  extraProfiles: Record<string, ResolvedAgentProfile> = {},
): SubagentProvider<TContext> {
  const tools: Record<string, Tool> = {};
  for (const tool of agentTools) tools[tool.schema.name] = tool;
  // Deployment-supplied profiles (disk locally, external on a server) extend the builtin fleet;
  // the SOURCE differs by composition root, the wiring here does not.
  const profiles = { ...DEFAULT_AGENT_PROFILES, ...extraProfiles };
  const only = [...new Set([...DEFAULT_SUBAGENT_NAMES, ...Object.keys(extraProfiles)])];
  return profileSubagentProvider<TContext>(profiles, {
    only,
    tools,
    resolveModel,
  });
}

/**
 * The process-lived objects a harness is built on — what `HarnessOptions.infrastructure` returns.
 * Each one is optional; what is absent simply has no provider, and the harness falls back to
 * its own default (an in-memory repository, a silent logger, a `LocalEnvironment` per session).
 */
export interface HarnessInfrastructure {
  readonly logger?: Logger;
  readonly sessionRepository?: SessionRepository;
  /** The default environment for sessions that bring none: an instance shared by all of them, or
   *  a factory called once per session. */
  readonly environment?: Environment | EnvironmentFactory;
  readonly tracing?: TracingProcessor;
  readonly pluginManager?: PluginManager;
  /** One set of MCP connections for every session in this process. */
  readonly mcpServers?: McpServersHandle;
  /** The configurations `mcpServers` was built from, by name. With them a session whose
   *  configuration names the very same server views the shared connection; without them a session
   *  that names its servers connects its own. */
  readonly mcpServerConfigs?: Readonly<Record<string, McpServerConfig>>;
  /** One skill scan for every session in this process. */
  readonly skillRegistry?: SkillRegistry;
  readonly oauthService?: McpOAuthService;
  /**
   * Tears down whatever this bag opened — the MCP connections, a pool, a log handle. Called by
   * `harness.close()` after every session is closed. Without it, anything the preset connected
   * outlives the harness that asked for it.
   */
  close?(): void | Promise<void>;
}

/** The settings every run on one session carries. */
type SessionRunOverrides<TContext> = Pick<RunOptions<TContext>, "maxTurns" | "subagentProvider" | "workflowTool" | "maxConcurrentSubagents">;

function toolPaletteOf(tools: readonly Tool[]): Readonly<Record<string, Tool>> {
  return Object.fromEntries(tools.map((tool) => [tool.schema.name, tool]));
}

export interface HarnessOptions<TContext = unknown> {
  readonly context?: TContext;
  readonly extraSubagentProfiles?: Record<string, ResolvedAgentProfile>;
  /**
   * The harness's serializable configuration: the defaults every session starts from, the policy no
   * session can override, and the process-level settings. The same object a `config.toml` loads
   * into (`loadHarnessConfig`), so configuration built in code, read from a file or fetched from a
   * database takes one path. `config.defaults.model` is what a session with no model of its own
   * runs on: a `provider/model` id looked up in {@link modelManager}.
   */
  readonly config?: HarnessConfig;
  /**
   * The code a session's configuration refers to by name: `tools` (keyed by their schema name;
   * defaults to `filesystemTools()` plus `askUserQuestionTool`) and `agents`.
   */
  readonly registry?: {
    readonly tools?: readonly Tool[];
    readonly agents?: Readonly<Record<string, Agent<TContext>>>;
  };
  /**
   * Supplies what the harness cannot know when it opens a session — a sandbox, a user's
   * credentials, application context, configuration kept in the host's own database. Called once
   * for every session being assembled (create, restore and fork alike, whoever asked), before its
   * capabilities are built; never for attaching to a loaded one. It returns data and live objects:
   * it does not return a session and must not open the one it is resolving. Throwing refuses the
   * open. Without it a session runs on what the call handed in and what is stored with it.
   */
  readonly resolveSession?: (request: SessionResolveRequest<TContext>) => SessionResolution<TContext> | void | Promise<SessionResolution<TContext> | void>;
  /** The judge the `auto` permission mode consults, for every session of this harness. */
  readonly autoApprover?: AutoApprover;
  /**
   * The one model manager this harness runs on: what every string model id resolves against.
   * Defaults to a fresh `createModelManager()`. Pass one only for what cannot be changed later,
   * such as a custom credential store. Add providers in place: `harness.modelManager.register()` for
   * plain configuration, `harness.modelManager.models.setProvider()` for one built with `createProvider`.
   */
  readonly modelManager?: ModelManager;
  /**
   * The process-lived infrastructure this harness runs on, built once. Everything a session needs
   * that is NOT per-session lives here: the repository (disk locally, Pg/Redis on a server;
   * in-memory when absent), the logger, the default environment, one set of MCP connections, one
   * skill scan. Runs before the by-value extensions' `harness` halves, so they can consume what it
   * returns.
   *
   * There is no tier between this and a session. A shared object is shared by the WHOLE process
   * or it is built per session — nothing is shared by "the sessions in one directory".
   */
  readonly infrastructure?: () => HarnessInfrastructure | Promise<HarnessInfrastructure>;
  /**
   * Session-tier composition: called once per session being opened. Return its capabilities.
   * Defaults to `defaultCapabilities()`. Always called fresh per session, so per-session state
   * (goal/plan/todo/background/skills/mcp) is isolated by construction.
   */
  readonly sessionCapabilities?: (ctx: SessionCapabilityContext) => readonly Capability[] | Promise<readonly Capability[]>;
  /**
   * Product telemetry (docs/telemetry.md). Process-lifetime: create ONE service, attach the
   * appenders once, pass the same instance to every harness. Absent = nothing is counted.
   * The harness never shuts it down; the product does, before exit.
   */
  readonly telemetry?: TelemetryService;
  /**
   * Process-level shared services BY NAME, registered into the harness scope at construction
   * (extension services are the one string-keyed corner: an extension is loaded by its id and
   * names what it consumes in `uses`). An extension receives one as `ctx.services[name]` -- a
   * stable handle that resolves the current provider on every call, which is what makes a
   * host-side `harness.services.replace()` land without touching any session. A plain value
   * registers as-is (not replaceable); wrap it as `{ instance, replaceable, dispose }` to opt
   * into hot swapping. Design: docs/architecture.md §5.5.
   */
  readonly services?: Record<string, unknown | ({ readonly instance: unknown } & ServiceOptions)>;
  /**
   * Opt-in to FILE extensions, both tiers, from this directory (one folder per extension).
   * The single explicit switch: without it no file-extension machinery exists ("default
   * closed"); with it, `harness.extensions` loads/reloads/unloads them — each load being the
   * manual approval. Extensions with a `harness` half publish process-level services and may
   * embed a session half; see docs/architecture.md §5.4-5.5. (Unrelated to
   * `pluginManager`, the Codex-compatible skill/MCP plugin system.)
   */
  readonly extensionDir?: string;
  /**
   * Root of the per-extension data folders handed to `harness` halves as `host.dataDir`
   * (`<root>/<id>`). Defaults to `<extensionDir>/.data` when `extensionDir` is set; by value
   * only, set it to give `harness` halves a place for their files (absent ⇒ `dataDir` is
   * `undefined`). Kept outside the code folders so an update never touches state.
   */
  readonly extensionDataDir?: string;
  /**
   * Where file extensions' settings values are kept (`harness.extensions.setSettings`, read as
   * `host.settings`). Defaults to one JSON file per extension in `<extensionDir>/.settings` — apart
   * from the extensions' own data folders, so an extension cannot rewrite its settings past
   * validation. Replace it to keep settings in the host's own store. Only with `extensionDir`.
   */
  readonly extensionSettings?: ExtensionSettingsStore;
  /**
   * Programmatic runtime extensions, registered once here — the by-value twin of `extensionDir`.
   * Every definition's `session` runs in every session; a session varies that with
   * `config.extensions` (a value configures, `false` skips). A definition with a
   * `harness` half has it run here, once, and the result registered as a service under its `id`
   * before any session opens; `harness.close()` unregisters (and disposes) those services.
   * Each definition's `uses` is checked at this point, in order — a consumer comes after its
   * provider (or after `services`). Synchronous `harness`s finish before `createHarness`
   * returns; an async one makes sessions wait for it, so `harness` must not open a session of
   * its own. Intentionally independent from Codex-compatible plugins (`pluginManager`): those
   * are skills/MCP/hooks metadata, extensions are trusted host code.
   */
  readonly extensions?: readonly ExtensionDefinition[];
}

/**
 * What a capability factory is told about the session it is building for: the configuration the
 * session runs on (its own over the harness defaults), the live objects of this open, and the
 * policy no session overrides. `defaultCapabilities({ session: ctx })` builds the standard bundle
 * from exactly this; a custom factory that builds its own is responsible for honouring it.
 */
export interface SessionCapabilityContext {
  readonly sessionId: string;
  readonly workDir: string;
  readonly ownerKey?: string;
  /** The configuration this session runs on: its own over the harness defaults. MCP, skills and
   *  hooks are built from this — `config.mcp.servers` is the complete set the session sees. */
  readonly config: SessionConfig;
  readonly shared: HarnessInfrastructure;
  /** The live objects this open runs on. */
  readonly bindings: SessionBindings<any>;
  /** What the harness does not let a session override. */
  readonly policy: SessionPolicy;
  /** The session brought its own environment (`bindings.environment` on this open): harness-shared
   *  objects derived from the harness's environment (the skill scan) do not apply to it. */
  readonly ownEnvironment: boolean;
  /** `bindings.mcpCredentials` for this open. */
  readonly mcpCredentials?: McpCredentialProvider;
  /** `policy.strictIsolation`. A custom factory owns honouring it the way `defaultCapabilities` does. */
  readonly strictIsolation: boolean;
}

/**
 * What every way of opening a session takes. One harness serves sessions that differ in model,
 * tools, MCP servers or permission: none of that needs a harness of its own.
 */
interface OpenSessionOptionsBase<TContext = unknown> {
  /** This session's own configuration, laid over the harness defaults field by field. Stored with
   *  the session, so a later `resumeSession(id)` needs none of it again. */
  readonly config?: SessionConfig;
  /** The live objects this open runs on — never stored; see {@link SessionBindings}. */
  readonly bindings?: SessionBindings<TContext>;
  /** Who is asking, as `resolveSession` and `onSessionOpened` are told. Defaults to the host; a
   *  server opening a session for a remote client says `{ kind: "remote" }`. */
  readonly origin?: SessionOrigin;
}

export interface CreateSessionOptions<TContext = unknown> extends OpenSessionOptionsBase<TContext> {
  readonly id?: string;
  readonly workDir?: string;
  /** Partition this session under an owner — see {@link CreateSessionInput.ownerKey}. */
  readonly ownerKey?: string;
  readonly title?: string;
}

export interface ResumeSessionOptions<TContext = unknown> extends OpenSessionOptionsBase<TContext> {}

export interface ForkSessionOptions<TContext = unknown> extends ResumeSessionOptions<TContext> {
  readonly id?: string;
  /** Defaults to the source session's key. */
  readonly ownerKey?: string;
  readonly title?: string;
}

/** A `Responder` whose approval/question handlers can be swapped at runtime (last-wins). */
class MutableResponder implements Responder {
  approvalHandler: ApprovalHandler | undefined;
  questionHandler: QuestionHandler | undefined;

  /** No handler ⇒ not a live approver ⇒ the run interrupts durably (resume later via
   *  `HarnessSession.respond`) instead of auto-rejecting the tool. */
  isLiveApprover(): boolean {
    return this.approvalHandler !== undefined;
  }

  /** Same rule for questions: no handler ⇒ nobody attached ⇒ AskUserQuestion suspends durably
   *  (the question is on the paused run's pending list) instead of being dismissed unanswered. */
  isLiveQuestioner(): boolean {
    return this.questionHandler !== undefined;
  }

  async requestApproval(request: ApprovalRequest, options?: ApprovalRequestOptions): Promise<ApprovalResponse> {
    if (this.approvalHandler) return this.approvalHandler(request, options);
    return { decision: "rejected", feedback: "No approval handler registered on this session." };
  }

  async requestQuestion(request: QuestionRequest, options?: { readonly signal?: AbortSignal }): Promise<QuestionResult> {
    if (this.questionHandler) return this.questionHandler(request, options);
    return null;
  }
}

/**
 * Ergonomic per-session facade. Run-driving methods (`prompt`/`steer`/`followUp`/`cancel`/
 * `onEvent`/approval handlers) live here; everything else delegates to the core
 * `Session` (reachable via `.core` for anything not surfaced).
 */
export class HarnessSession<TContext = unknown, TOutput = unknown> {
  readonly id: string;
  readonly workDir: string;
  /** The owner this session is partitioned under, when it has one. */
  readonly ownerKey: string | undefined;
  /** The configuration this session was assembled with: its own setup over the harness defaults.
   *  A snapshot of the open — `setModel` and the other setters do not rewrite it. */
  readonly config: SessionConfig;
  /** The kinds of live object this session depends on being provided again when it is reopened. */
  readonly requires: readonly SessionBindingKey[];
  /** The underlying core session — escape hatch for the full control plane. */
  readonly core: Session;
  /**
   * The session's event stream folded into state. The consumer split: `onEvent` serves
   * events-as-events (tracing, telemetry); the projection serves state — a late-joining
   * consumer calls `observeProjection()` and gets an exact history/live seam (no loss,
   * no duplicates, no dedup).
   * Attached before the session's first run — see docs/architecture.md §2.3.
   */
  readonly projection: SessionProjection;

  private readonly agent: Agent<TContext>;
  private readonly runner: Runner<TContext>;
  private readonly events: ListenerSink;
  private readonly responder: MutableResponder;
  private readonly onClosed: (id: string) => void | Promise<void>;
  private runContext: TContext | undefined;
  /** Barrier gate (docs/architecture.md §5.5): while set, no NEW run starts on this
   *  session — prompt/respond park at it, promptStream starts lazily behind it. The in-flight
   *  run is never touched. */
  private runGate: { readonly released: Promise<void>; release(): void } | undefined;
  /** Held from construction until the harness has finished wiring this session: no run starts
   *  before the host's open listeners have subscribed. Independent of `runGate`, which a reshape
   *  barrier takes and releases on its own schedule. */
  private birthHold: { readonly released: Promise<void>; release(): void } | undefined;
  /**
   * Every run this facade has begun and not yet seen settle, by its controller. More than one
   * entry means runs are queued behind the core's run lock (`prompt` while a turn is in flight):
   * "busy" is this set being non-empty, `cancel()` aborts ALL of them, and the barrier's
   * quiescence is ALL of them settling — tracking only the last-begun run would abort the
   * queued one and leave the running one untouched.
   */
  private readonly runs = new Map<AbortController, { readonly settled: Promise<void>; resolve(): void }>();
  private lastRunInterrupted = false;
  /** open → closing (runs being drained, resources going down) → closed. Never goes back. */
  private lifecycle: "open" | "closing" | "closed" = "open";
  /** The one close in flight (or finished): every `close()` call returns THIS promise. */
  private closing: Promise<void> | undefined;
  /** Resolves the moment close() begins — what wakes a caller parked at the barrier gate so it
   *  can fail with the closed error instead of hanging on a gate nobody will release. */
  private notifyClosing!: () => void;
  private readonly closingNotified = new Promise<void>((resolve) => {
    this.notifyClosing = resolve;
  });
  /** A wake is already scheduled on the microtask queue; more enqueues fold into it. */
  private wakeScheduled = false;
  private readonly runOverrides: SessionRunOverrides<TContext>;
  /** The permission modes the harness's policy allows; undefined when it does not restrict them. */
  private readonly allowedModes: readonly PermissionMode[] | undefined;
  /** Builds the capability an extension attached to THIS session runs as — bound to the
   *  session's harness reach and its per-session params. */
  private readonly mountExtension: (definition: ExtensionDefinition) => Capability;

  constructor(args: {
    core: Session;
    agent: Agent<TContext>;
    runner: Runner<TContext>;
    events: ListenerSink;
    responder: MutableResponder;
    projection: SessionProjection;
    workDir: string;
    ownerKey?: string;
    config: SessionConfig;
    requires: readonly SessionBindingKey[];
    allowedModes?: readonly PermissionMode[];
    context?: TContext;
    runOverrides: SessionRunOverrides<TContext>;
    interrupted?: boolean;
    mountExtension: (definition: ExtensionDefinition) => Capability;
    onClosed: (id: string) => void | Promise<void>;
  }) {
    this.core = args.core;
    this.id = args.core.id;
    this.projection = args.projection;
    this.workDir = args.workDir;
    this.ownerKey = args.ownerKey;
    this.config = args.config;
    this.requires = args.requires;
    this.allowedModes = args.allowedModes;
    let releaseBirth!: () => void;
    this.birthHold = { released: new Promise<void>((resolve) => { releaseBirth = resolve; }), release: releaseBirth };
    this.agent = args.agent;
    this.runner = args.runner;
    this.events = args.events;
    this.responder = args.responder;
    this.runContext = args.context;
    this.runOverrides = args.runOverrides;
    this.lastRunInterrupted = args.interrupted ?? false;
    this.onClosed = args.onClosed;
    this.mountExtension = args.mountExtension;
    // Nothing drains a queue that fills while the session sits idle — the run loop's
    // turn-boundary drain only exists while a run is in flight. Without this, a background
    // task settling minutes after its spawning turn ended (the normal case: spawning to the
    // background is precisely how a turn stops waiting) would leave its result queued until
    // the user happened to prompt again.
    this.core.steer.setIdleWakeListener(() => this.scheduleIdleWake());
  }

  /**
   * Start a turn to consume queued follow-ups, once the current synchronous work is done.
   *
   * Deferred to a microtask for two reasons: several enqueues in one stack fold into a single
   * wake, and a settle that lands in a finishing run's own stack sees its run already
   * cleared. Re-checked at fire time because either can change in between — and re-checked
   * again after every run, since the queue may have filled during one whose drain had passed.
   */
  private scheduleIdleWake(): void {
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      if (this.closed || this.lastRunInterrupted) return;
      // Held at a barrier: stand down instead of parking a drain run at the gate (stacked
      // parked drains would race on release). `release()` re-schedules this wake.
      if (this.gated) return;
      // A run in flight drains at its own turn boundary; an interrupted one must be resumed,
      // not talked over.
      if (this.hasActiveRuns()) return;
      // Either channel counts. A "steering" item is an interruption of work in flight, but with
      // nothing in flight there is nothing to interrupt — it is simply the next input, and the
      // turn picks it up at the top of its first step (`runTurn`'s drain runs before the model
      // call), just as the follow-up queue is drained before the turn starts.
      if (!this.core.steer.hasItems()) return;
      // No input: the queue IS the prompt for this turn.
      this.startWakeRun();
    });
  }

  /** Not open: closing or closed. Every run entry point refuses from here on. */
  private get closed(): boolean {
    return this.lifecycle !== "open";
  }

  /**
   * Park at the barrier gate until released — or until this session starts closing, in which
   * case fail with the closed error rather than wait on a gate no coordinator will release.
   * Re-checked in a loop: a new hold can land between a release and this task resuming.
   */
  private async parkAtGate(): Promise<void> {
    while (this.gated) {
      await Promise.race([(this.birthHold ?? this.runGate)!.released, this.closingNotified]);
      if (this.closed) throw new SessionClosedError(this.id);
    }
  }

  /** Held at birth, or by a reshape barrier: new runs wait. */
  private get gated(): boolean {
    return this.runGate !== undefined || this.birthHold !== undefined;
  }

  /** Harness-internal: the session is wired, let it run. Anything queued meanwhile drains on the
   *  normal idle-wake path. */
  releaseBirthHold(): void {
    const hold = this.birthHold;
    if (hold === undefined) return;
    this.birthHold = undefined;
    hold.release();
    this.scheduleIdleWake();
  }

  /** Current runtime-only application context supplied to Agent callbacks. */
  get context(): TContext | undefined {
    return this.runContext;
  }

  get status(): HarnessSessionStatus {
    return {
      state: this.closed
        ? "closed"
        : this.hasActiveRuns()
          ? "running"
          : this.lastRunInterrupted
            ? "interrupted"
            : "idle",
      activeTurnId: this.core.steer.activeTurn,
      hasQueuedMessages: this.core.steer.hasItems(),
    };
  }

  /** Durable approvals / tool inputs awaiting answers, including after a reopen where the
   *  historical `turn.paused` event itself is no longer live in Projection. */
  async pendingInterruptions(): Promise<readonly PendingRunInterrupt[]> {
    const raw = await this.core.store?.getState(INTERRUPTION_STATE_KEY);
    if (raw === null || raw === undefined) return [];
    return flattenPendingInterrupts(parseInterruptionState(raw));
  }

  /** Replace the runtime-only context used by subsequent prompt/respond calls. */
  setContext(context: TContext | undefined): void {
    this.runContext = context;
  }

  // ── Run driving (the methods core Session does not have) ──

  private beginRun(controller: AbortController): void {
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    this.runs.set(controller, { settled, resolve });
  }

  private endRun(controller: AbortController): void {
    this.runs.get(controller)?.resolve();
    this.runs.delete(controller);
    // Input can arrive after the last drain while this run still counts as active. Every
    // entry point must recheck on exit; the wake itself respects pauses, gates and other runs.
    this.scheduleIdleWake();
  }

  /** A run is in flight or queued behind the core's run lock. */
  private hasActiveRuns(): boolean {
    return this.runs.size > 0;
  }

  /** Settles when every run begun so far has settled (trivially, when idle). */
  private allRunsSettled(): Promise<void> {
    return Promise.all([...this.runs.values()].map((run) => run.settled)).then(() => undefined);
  }

  /**
   * Barrier support (docs/architecture.md §5.5): refuse NEW runs until released and
   * report when this session reaches its run boundary. Installing the gate is synchronous — a
   * coordinator gates every affected session FIRST, then awaits quiescence, so the set of
   * running sessions only shrinks. The in-flight run (if any) is never signaled or aborted;
   * `quiescent` settles when it finishes on its own. `release` is idempotent and always safe —
   * a coordinator calls it in a finally so a failed barrier leaves nothing held.
   */
  holdAtBoundary(): { readonly quiescent: Promise<void>; release(): void } {
    let releaseGate!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gate = { released, release: releaseGate };
    this.runGate = gate;
    const quiescent = this.allRunsSettled();
    return {
      quiescent,
      release: () => {
        if (this.runGate === gate) this.runGate = undefined;
        gate.release();
        // Anything queued while held drains on the normal idle-wake path.
        this.scheduleIdleWake();
      },
    };
  }

  /** Run a turn to completion. Serialized with other runs on this session. */
  async prompt(input: AgentInput): Promise<RunResult<TOutput>> {
    this.drainFollowUpsAhead();
    return this.runPrompt(input) as Promise<RunResult<TOutput>>;
  }

  /** Messages can go in while running or idle, but not past a question waiting for its answer. */
  private assertCanSendPrompt(input: AgentInput): void {
    // A wake run consumes what was already accepted; only new input can be refused here.
    if (Array.isArray(input) && input.length === 0) {
      if (this.closed) throw new SessionClosedError(this.id);
      return;
    }
    this.assertCanSend();
  }

  private assertCanSend(): void {
    if (this.closed) throw new SessionClosedError(this.id);
    if (this.lastRunInterrupted && !this.hasActiveRuns()) throw new SessionInterruptedError(this.id);
  }

  /** Follow-ups accepted before this prompt go first: they get a run ahead of it on the lock. */
  private drainFollowUpsAhead(): void {
    if (!this.closed && this.core.steer.fenceUserFollowUps()) this.startWakeRun();
  }

  /** A run with no input of its own, whose prompt is whatever is queued. Nobody awaits it, so its
   *  failures are reported on the event stream. */
  private startWakeRun(): void {
    const reportFailure = (message: string): void => {
      void this.events.emit({ type: "error", message, address: DEFAULT_ADDRESS, sessionId: this.id });
    };
    void this.runPrompt([]).then(
      (result) => { if (result.status === "error") reportFailure(result.error.message); },
      (error: unknown) => { if (!isAbortError(error)) reportFailure(error instanceof Error ? error.message : String(error)); },
    );
  }

  private async runPrompt(input: AgentInput, inputOrigin?: PromptOrigin): Promise<RunResult> {
    this.assertCanSendPrompt(input);
    // Barrier gate: park until released (a hold is "wait", not "fail") — unless the session
    // closes meanwhile, which is the one thing that turns the wait into a failure. Ungated, the
    // run is registered SYNCHRONOUSLY: a cancel() or close() on the next line must find it.
    if (this.gated) await this.parkAtGate();
    const controller = new AbortController();
    this.beginRun(controller);
    try {
      const result = await this.runner.run(this.agent, input, {
        session: this.core,
        signal: controller.signal,
        context: this.runContext,
        ...(inputOrigin !== undefined ? { inputOrigin } : {}),
        ...this.runOverrides,
      });
      this.lastRunInterrupted = result.status === "interrupted";
      return result;
    } catch (error) {
      // Facade contract: a guardrail tripwire resolves as a terminal RunResult (the low-level
      // Runner still throws — OpenAI parity). Callers branch on `result.status`, no try/catch.
      if (isGuardrailTripwireError(error)) return this.guardrailBlocked(error);
      throw error;
    } finally {
      this.endRun(controller);
    }
  }

  /**
   * Hand a message to the frame running at `address` in this session (`main` for the root agent,
   * `main/<agentId>` for a subagent). Throws `SteerTargetNotFoundError` when nobody is there, and
   * the usual errors when the session is closed or waiting for an answer. The seam an
   * out-of-process coordinator uses to address a specific subagent.
   *
   * The receipt's `journaled` settles once the `steer.queued` record is on disk — the moment a
   * caller may answer "accepted" to someone else and mean it survives a crash. A running frame
   * drains the message at its next boundary; an idle root frame is woken to take it.
   */
  steerTo(address: string, content: string, origin: SteerOrigin, options?: SteerOptions): SteerReceipt {
    this.assertCanSend();
    // A run in flight drains its own queues, so handing the message to the frame is enough.
    // A resume keeps the prior interruption flag until it settles, but is already running.
    if (this.hasActiveRuns()) {
      const receipt = this.core.steerTo(address, content, origin, options);
      if (receipt === undefined) throw new SteerTargetNotFoundError(this.id, address);
      return receipt;
    }
    // Idle: only the root frame can be woken. A subagent whose frame has ended is not a teammate
    // waiting for mail — it is a finished delegation, and only the parent that delegated it can
    // decide to continue it (`Agent(resume=...)`). Its store, capabilities, permissions and
    // lifetime are all the parent's; there is no independent agent here to start.
    if (address !== DEFAULT_ADDRESS) throw new SteerTargetNotFoundError(this.id, address);
    // Queue it and let the idle-wake listener start the turn. Going through the bus (rather
    // than synthesizing a prompt here) is what gives the message its `steer.queued` record and
    // a `steerId` on its journal record, same as every other producer.
    return this.core.steer.steer(content, origin, options);
  }

  /**
   * Put a message whose `steer.queued` record ALREADY exists back on the bus.
   *
   * For whoever holds a reopened session and finds, in its log, accepted messages no turn ever
   * consumed — a `steer.queued` with no `message.appended` carrying its `steerId`. That happens
   * when acceptance and execution are different processes (a managed API node writes the record,
   * a worker runs it later, possibly on another machine) or when the process that accepted a
   * message died before a turn drained it. Nothing is journaled again: the record and its
   * `steer.queued` event exist from the first acceptance. Run state is read NOW, not then — a
   * running turn drains it at its next boundary, an idle session is woken to take it.
   */
  requeue(item: SteerMessage): SteerReceipt {
    if (this.closed) throw new SessionClosedError(this.id);
    return this.core.steer.requeue(item);
  }

  /**
   * Settles when no run is in flight. Yields once first, so a run that an enqueue on the
   * previous line scheduled (the idle wake fires from a microtask) is counted as in flight
   * rather than missed. A run that starts afterwards is not waited for.
   */
  async whenIdle(): Promise<void> {
    await Promise.resolve();
    await this.allRunsSettled();
  }

  /**
   * Answer a durably-interrupted run and continue it. When a `prompt` returns `status:"interrupted"` — which
   * happens when no live approval handler is registered (`no live responder ⇒ durable`) — the run's
   * interruption control tree was persisted to the session store. This loads it, applies the
   * caller's `answers` (prefer `approvalId`; a unique `toolCallId` is also accepted), and continues the
   * run to its next stop. Works across processes as long as the reopened session shares the same
   * durable store. Same guardrail-facade contract as `prompt` (a tripwire resolves as a terminal
   * `RunResult`, not a throw).
   *
   * An answer is either a bare `ApprovalResponse` (shorthand for the common approval case) or a
   * discriminated `InterruptAnswer` — pass `{ kind: "input", data }` to answer a durable input
   * suspension (`ctx.suspend`), which the approval-only shorthand cannot express.
   *
   * Recovery: if a previous resume threw mid-flight, the persisted state is left at
   * `phase: "recovery_required"` with its revision bumped. Calling this again handles it —
   * the state is re-read from the store here, so it is never stale — and continues from the
   * last durable pause. Only callers driving `Runner.resume` directly with a kept-around
   * copy see a "stale interruption state" error; re-fetching the persisted state clears it.
   */
  async respond(answers: Record<string, ApprovalResponse | InterruptAnswer>): Promise<RunResult<TOutput>> {
    return this.resumeRun(answers) as Promise<RunResult<TOutput>>;
  }

  private async resumeRun(answers: Record<string, ApprovalResponse | InterruptAnswer>): Promise<RunResult> {
    if (this.closed) throw new SessionClosedError(this.id);
    // Barrier gate first (a coordinator holding the barrier should not be resumed against —
    // the call parks here until release rather than failing; closing meanwhile does fail it).
    if (this.gated) await this.parkAtGate();
    if (this.hasActiveRuns()) throw new SessionBusyError(this.id, `session "${this.id}" already has an active run`);
    const controller = new AbortController();
    // Set this BEFORE the first await (past the gate). A host returning 202 from resume can
    // immediately observe `running`, and a concurrent steer joins this resumed turn instead
    // of seeing stale interrupted state while the control record is being read.
    this.beginRun(controller);
    try {
      const raw = await this.core.store?.getState(INTERRUPTION_STATE_KEY);
      if (raw === null || raw === undefined) {
        throw new SessionNotInterruptedError(this.id);
      }
      const interruption = parseInterruptionState(raw);
      // Bare ApprovalResponses (no `kind` field — the common case) are wrapped into the
      // discriminated InterruptAnswer shape; already-discriminated answers (including
      // `kind: "input"` for durable input suspensions) pass through untouched.
      const wrappedAnswers: Record<string, InterruptAnswer> = Object.fromEntries(
        Object.entries(answers).map(([id, answer]) => [
          id,
          isInterruptAnswer(answer) ? answer : { kind: "approval", ...answer },
        ]),
      );
      const result = await this.runner.resume(this.agent, { interruption, answers: wrappedAnswers }, {
        session: this.core,
        signal: controller.signal,
        context: this.runContext,
        ...this.runOverrides,
      });
      this.lastRunInterrupted = result.status === "interrupted";
      return result;
    } catch (error) {
      if (isGuardrailTripwireError(error)) return this.guardrailBlocked(error);
      throw error;
    } finally {
      this.endRun(controller);
    }
  }

  /** Streaming variant: iterate events, await `.completed` for the result. */
  promptStream(input: AgentInput): RunHandle<RunResult<TOutput>> {
    this.drainFollowUpsAhead();
    return this.promptStreamRun(input) as RunHandle<RunResult<TOutput>>;
  }

  private promptStreamRun(input: AgentInput): RunHandle<RunResult> {
    if (this.closed) throw new SessionClosedError(this.id);
    const controller = new AbortController();
    // Ungated: start synchronously, byte-identical to the pre-barrier behavior. Gated: the
    // handle returns immediately but the underlying run starts only after release (lazy start —
    // promptStream has no callers that depend on first-event timing).
    const gated = this.gated;
    if (!gated) this.beginRun(controller);
    const start = (async () => {
      if (gated) {
        await this.parkAtGate();
        this.beginRun(controller);
      }
      return this.runner.runStream(this.agent, input, {
        session: this.core,
        signal: controller.signal,
        context: this.runContext,
        ...this.runOverrides,
      });
    })();
    // Same facade contract as `prompt`: `completed` resolves with a "guardrail_blocked" result
    // instead of rejecting. Events (including the `guardrail.blocked` frame) stream through the
    // original handle unchanged.
    const completed = start
      .then((handle) => handle.completed)
      .then((result) => {
        this.lastRunInterrupted = result.status === "interrupted";
        return result;
      })
      .catch((error) => {
        if (isGuardrailTripwireError(error)) return this.guardrailBlocked(error);
        throw error;
      })
      .finally(() => {
        this.endRun(controller);
      });
    // Guard the floating promise so iterate-only callers don't trip an unhandled rejection
    // (mirrors runStream's own internal guard); awaiters still receive a real rejection.
    completed.catch(() => undefined);
    const iterate = async function* (): AsyncGenerator<AgentEvent> {
      const handle = await start;
      for await (const event of handle) yield event;
    };
    return {
      [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
      completed,
    };
  }

  /** Synthesize the terminal RunResult for a guardrail tripwire (facade contract). */
  private guardrailBlocked(error: GuardrailTripwireError): RunResult {
    // Terminal, like any other completed result: without this, a tripwire during resume()
    // would leave the flag stuck true (the success path at the call sites never runs) and
    // wedge the session in "interrupted" with its durable state already consumed.
    this.lastRunInterrupted = false;
    return {
      status: "guardrail_blocked",
      finalAgent: error.agentName ?? this.agent.name,
      activeAddress: error.address ?? this.core.conversationHead()?.address ?? "main",
      output: "",
      messages: [],
      usage: emptyUsage(),
      guardrail: {
        stage: error.stage,
        guardrail: error.guardrailName,
        ...(error.agentName !== undefined ? { agent: error.agentName } : {}),
      },
    };
  }

  /**
   * Inject a user message into the in-flight (or next) turn. The receipt's `steerId` is the
   * correlation key: a `steer.queued` event carries it now, and the consuming `message.appended`
   * event's `origin.steerId` matches it when the model actually sees the message; `journaled`
   * settles once the `steer.queued` record is durable.
   */
  steer(input: string): SteerReceipt {
    this.assertCanSend();
    return this.core.steer.steer(input, { kind: "user" });
  }

  /**
   * Send a user message without waiting for the answer: `prompt` that returns a receipt. It runs
   * as its own run, after the current turn finishes or right away on an idle session, so the
   * current run's result stays its own. Track it by the receipt's `steerId` (see `steer`).
   */
  followUp(input: string): SteerReceipt {
    this.assertCanSend();
    return this.core.steer.followUp(input);
  }

  /** Abort every run this session has accepted, the one in flight and any queued behind it, and
   *  drop what the user queued for them. Cron fires and background results stay queued. */
  cancel(): void {
    this.core.steer.discardUserMessages("cancelled");
    for (const controller of [...this.runs.keys()]) controller.abort();
  }

  /** Subscribe to this session's event stream. Returns an unsubscribe fn. */
  onEvent(listener: AgentEventListener): () => void {
    return this.events.subscribe(listener);
  }

  // ── Projection (state-shaped consumers; see the `projection` field doc) ──

  /** Current folded state. Consumers that also need subsequent events should use
   *  `observeProjection()` for an atomic history/live seam. */
  snapshot(options?: SnapshotOptions): SessionSnapshot {
    return this.projection.snapshot(options);
  }

  /** Post-apply event feed: every delivered event's effect is already in `snapshot()`.
   *  Listeners must be synchronous — backpressure belongs to the transport. */
  subscribeProjection(listener: ProjectionListener): () => void {
    return this.projection.subscribe(listener);
  }

  /** Atomically subscribe to post-fold AgentEvents and capture the authoritative state at
   *  that boundary. Prefer this over coordinating `snapshot()` and `subscribeProjection()`
   *  manually in transports and UIs. */
  observeProjection(listener: ProjectionListener, options?: SnapshotOptions): ProjectionObservation {
    return this.projection.observe(listener, options);
  }

  /** Lightweight per-address summary (which agents exist, who is live/running). */
  directory(): DirectoryEntry[] {
    return this.projection.directory();
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.responder.approvalHandler = handler;
  }

  setQuestionHandler(handler: QuestionHandler | undefined): void {
    this.responder.questionHandler = handler;
  }

  // ── Control plane (delegated to core Session) ──

  setModel(model: string | ChatModel): void {
    this.core.setModel(model);
  }
  setThinking(level: ThinkingLevel): void {
    this.core.setThinking(level);
  }
  /** In-memory switch is immediate; await the returned promise to confirm it was journaled.
   *  A mode the harness's policy does not allow is refused (`SessionPolicyViolationError`) — the
   *  policy holds for a running session as it does for a new one, whoever asks. */
  setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.allowedModes !== undefined && !this.allowedModes.includes(mode)) {
      return Promise.reject(new SessionPolicyViolationError(this.id, "permission.mode", `permission mode "${mode}" is not allowed here (allowed: ${this.allowedModes.join(", ") || "none"})`));
    }
    return this.core.setPermissionMode(mode);
  }
  /** The model this session runs on, as last set; undefined means the agent's own. */
  get modelSetting(): string | ChatModel | undefined {
    return this.core.modelSetting;
  }
  /** The thinking level this session runs at, as last set; undefined means the model's default. */
  get thinkingSetting(): ThinkingLevel | undefined {
    return this.core.thinkingSetting;
  }
  /** The permission mode in force right now — what a status line reads instead of tracking it. */
  get permissionMode(): PermissionMode | undefined {
    return this.core.permissionModeSetting;
  }

  // ── capability services ───────────────────────────────────────────────────────────────
  // The same accessors the core `Session` exposes, forwarded. There used to be one wrapper
  // method per operation here, mirroring one facade method per operation there — two layers
  // that had to be kept in step by hand every time a capability grew an operation. Forwarding
  // the SERVICE means a new operation needs no change in either layer.
  get goal(): GoalStore {
    return this.core.goal;
  }
  get plan(): PlanMode {
    return this.core.plan;
  }
  get skills(): SkillsService {
    return this.core.skills;
  }
  get plugins(): PluginManager {
    return this.core.plugins;
  }
  get compaction(): CompactionService {
    return this.core.compaction;
  }
  /** PROBE tier: absent without the background capability — see `Session.background`. */
  get background(): BackgroundManager | undefined {
    return this.core.background;
  }
  /** PROBE tier: absent without an MCP capability. */
  get mcp(): McpServersHandle | undefined {
    return this.core.mcp;
  }

  // ── Conversation log (flat, linear) — read the record stream for transcript rendering ──
  getRecords(...args: Parameters<Session["getRecords"]>): ReturnType<Session["getRecords"]> {
    return this.core.getRecords(...args);
  }

  getAuditRecords(): ReturnType<Session["getAuditRecords"]> {
    return this.core.getAuditRecords();
  }

  // ── context introspection — where the model's window is spent, as of the last turn ──
  getContextBreakdown(): ReturnType<Session["getContextBreakdown"]> {
    return this.core.getContextBreakdown();
  }
  /** Where this session's tools run. A host uses it to run a command in the same place the agent
   *  does — one shell, one filesystem, one working directory. */
  get environment(): Environment {
    return this.core.environment;
  }
  /** The current todo list (the `TodoList` tool's latest state); empty without the todo capability. */
  getTodos(): readonly TodoItem[] {
    return this.core.service<TodoStore>("todo")?.get() ?? [];
  }
  /** Every slash command this session answers to — the static registry plus the ones its
   *  capabilities and extensions contribute — for a UI's palette and autocompletion. */
  listCommands(): readonly CommandInfo[] {
    return sharedCommands()
      .list(this.core)
      .map((command) => ({ name: command.name, aliases: command.aliases ?? [], description: command.description }));
  }

  // ── extensions — hot attach/detach on the live session (host API; never a model tool) ──
  /**
   * Add an extension mid-session. Applied at the next quiet point: immediately when idle,
   * at the run's stop boundary when one is in flight — its tools appear at the next run's
   * assembly. The change is journaled; it does NOT survive `resumeSession` (re-attach, or
   * register it in `createHarness({ extensions })`, which every open re-evaluates). A definition
   * with a `harness` half is accepted only once registered — its service must already exist.
   */
  async attachExtension(definition: ExtensionDefinition): Promise<void> {
    await this.core.attachCapability(this.mountExtension(definition));
  }
  /** Remove an extension mid-session: `session.end("detach")` fires, then its scope unwinds. */
  async detachExtension(extensionId: string): Promise<void> {
    if (this.extensionRuntime(extensionId) === undefined) throw new HarnessConfigError(`unknown extension "${extensionId}"`);
    await this.core.detachCapability(extensionId);
  }
  /** Ids of currently attached extensions, in mount order. */
  attachedExtensionIds(): readonly string[] {
    return this.attachedExtensions().map((extension) => extension.id);
  }
  /** Currently attached extensions with what each `uses`. */
  attachedExtensions(): readonly { readonly id: string; readonly uses: readonly string[] }[] {
    const out: { readonly id: string; readonly uses: readonly string[] }[] = [];
    for (const capability of this.core.capabilities) {
      const runtime = extensionRuntimeOf(capability);
      if (runtime !== undefined) out.push({ id: runtime.id, uses: runtime.definition.uses ?? [] });
    }
    return out;
  }
  /** Run a slash command against this session: the static registry plus capability-contributed
   *  dynamic commands (extensions' `registerCommand`). Commands are the SERIALIZABLE control
   *  surface — what an out-of-process host (app-server RPC) uses where an in-process host
   *  reaches `extensionHandle()`. */
  runCommand(input: string): Promise<CommandResult> {
    return sharedCommands().run(input, { session: this.core });
  }
  /** The control surface an extension published via `api.expose`; undefined when the extension
   *  is absent, detached, or exposed nothing. The generic replacement for per-feature session
   *  facade methods (e.g. cron's — see `cronExtension`). */
  extensionHandle<T = unknown>(extensionId: string): T | undefined {
    return this.extensionRuntime(extensionId)?.exposedHandle<T>();
  }
  private extensionRuntime(extensionId: string): ExtensionRuntime | undefined {
    const capability = this.core.capabilities.find((open) => open.name === extensionId);
    return capability === undefined ? undefined : extensionRuntimeOf(capability);
  }

  /**
   * Close the session and release its resources. Order: stop accepting runs, abort the ones
   * accepted (in flight and queued) and wait for them to settle — their tools' finally blocks,
   * their journal writes — then detach the projection and take the core down. Every call
   * returns the SAME promise, so nobody returns while the teardown is still running.
   *
   * The wait for runs is bounded (`closeDeadlines.runSettleMs`, 5s): a run that ignores its abort signal
   * is logged and left behind, and the teardown continues — the deadline caps the wait for
   * runs, not the whole close (flushes and disposes carry their own deadlines).
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.lifecycle = "closing";
    this.notifyClosing();
    this.closing = this.runClose();
    return this.closing;
  }

  private async runClose(): Promise<void> {
    try {
      const settled = this.allRunsSettled();
      this.cancel();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        settled.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), closeDeadlines.runSettleMs);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        this.core.logger.log("warn", "session close: runs still settling after the deadline; continuing teardown", {
          sessionId: this.id,
          runs: this.runs.size,
          deadlineMs: closeDeadlines.runSettleMs,
        });
      }
      try { await this.core.close(); }
      finally { this.projection.detach(); await this.onClosed(this.id); }
    } finally {
      this.lifecycle = "closed";
    }
  }
}

/** Manages a fleet of in-process sessions over a shared engine config. */
export class Harness<TContext = unknown, TOutput = unknown> {
  private readonly options: HarnessOptions<TContext>;
  private readonly runner: Runner<TContext>;
  /** Concrete tools the default profile's tool NAMES resolve against (keyed by schema name). */
  private readonly toolPalette: Readonly<Record<string, Tool>>;
  private readonly agentTools: readonly Tool[];
  private readonly defaultSubagents: SubagentProvider<TContext>;
  private readonly activeSessions = new Map<string, HarnessSession<TContext>>();
  /** Opens in flight, including reconciliation and cleanup. Prevents duplicate instances and
   *  lets closeSession wait until construction settles. `resumeSession(id)` joins the entry here. */
  private readonly opening = new Map<string, Promise<HarnessSession<TContext>>>();
  /** The one close in flight (or finished): every `close()` call returns THIS promise. */
  private closing: Promise<void> | undefined;
  /** Opens a `closeSession` asked to abandon: closed as soon as they are built. */
  private readonly cancelledOpens = new Set<string>();
  /** Sessions whose `resolveSession` call is running — it must not open the one it is resolving. */
  private readonly resolving = new AsyncLocalStorage<string>();
  private readonly openListeners: SessionOpenedListener<TContext>[] = [];
  /** Aborted when the harness closes; what `resolveSession` receives as its signal. */
  private readonly abortController = new AbortController();
  /** What every session starts from: `config.defaults`, validated. */
  private readonly defaultConfig: SessionConfig;
  private readonly sessionPolicy: SessionPolicy;
  private readonly agents: Readonly<Record<string, Agent<TContext>>>;

  /** The one model manager of this harness. Edit its providers in place; it is never swapped. */
  readonly modelManager: ModelManager;
  private readonly resolveModel: (modelId: string) => ChatModel | Promise<ChatModel>;
  /** The process-lived objects this harness runs on (`HarnessOptions.infrastructure`), plus defaults. */
  private infrastructure: HarnessInfrastructure = {};
  /** Process-level extension services by name (a facade over `scope`). The host replaces
   *  providers here (`services.replace`); sessions only ever see handles (`ctx.shared`, `ctx.services`). */
  readonly services: ServiceRegistry;
  /** The one in-flight reshape barrier (mutex: a second barrier operation rejects). Sessions
   *  appearing while it holds are gated at birth — see `assemble`. */
  private activeBarrier: { readonly holds: Map<string, { readonly quiescent: Promise<void>; release(): void }> } | undefined;
  /** File-extension manager (both tiers) — present only when the host opted in with
   *  `extensionDir`. NOT the Codex-compatible skill/MCP plugin system (`pluginManager`). */
  readonly extensions: HarnessExtensionManager | undefined;
  /** Service ids published by by-value `harness` halves, in creation order — unregistered (and
   *  disposed) by `close()`, newest first. */
  private readonly createdServices: string[] = [];
  /** The by-value definitions this harness currently mounts into newborn sessions, in
   *  registration order. Seeded from `createHarness({ extensions })` and rewritten in place by
   *  `replaceExtension`, so a swap reaches sessions born after it — reading `options.extensions`
   *  directly would hand new sessions the OLD code, which is exactly the skew the barrier exists
   *  to prevent. */
  private readonly valueDefs = new Map<string, ExtensionDefinition>();
  /** Root of extensions' data folders (`host.dataDir` = `<root>/<id>`); absent ⇒ none handed out. */
  private readonly dataRoot: string | undefined;
  /** Settles once every by-value `harness` half has published its service; sessions open after it. */
  private readonly sharedReady: Promise<void>;
  /** The extension whose `harness` is running right now — its `createSession` must refuse. */
  private runningCreate: string | undefined;

  constructor(options: HarnessOptions<TContext>) {
    assertHarnessOptions(options);
    this.options = options;
    this.modelManager = options.modelManager ?? createModelManager();
    this.resolveModel = (id) => this.modelManager.resolve(id);
    this.services = new ServiceRegistry();
    let configured: SessionConfig;
    try {
      configured = parseSessionConfig(options.config?.defaults, "createHarness({ config.defaults })");
    } catch (error) {
      throw new HarnessConfigError(error instanceof Error ? error.message : String(error));
    }
    this.defaultConfig = configured;
    if (configured.agent !== undefined) assertNoDefaultAgentOptions({ modelSettings: configured.modelSettings, tools: configured.tools, appendSystemPrompt: configured.appendSystemPrompt, maxStepsPerTurn: configured.limits?.maxStepsPerTurn }, "the harness");
    const policy = SessionPolicySchema.safeParse(options.config?.policy ?? {});
    if (!policy.success) {
      throw new HarnessConfigError(`createHarness({ config.policy }) is invalid: ${policy.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
    }
    this.sessionPolicy = policy.data;
    this.agents = options.registry?.agents ?? {};
    this.agentTools = options.registry?.tools ?? [...filesystemTools(), askUserQuestionTool];
    this.toolPalette = toolPaletteOf(this.agentTools);
    this.defaultSubagents = defaultSubagentProvider<TContext>(this.agentTools, this.resolveModel, options.extraSubagentProfiles);
    this.runner = new Runner<TContext>({
      resolveModel: this.resolveModel,
      maxTurns: this.defaultConfig.limits?.maxTurns,
      maxStepsPerTurn: this.defaultConfig.limits?.maxStepsPerTurn,
    });
    this.dataRoot = options.extensionDataDir ?? (options.extensionDir !== undefined ? join(options.extensionDir, ".data") : undefined);
    this.extensions = options.extensionDir === undefined
      ? undefined
      : new HarnessExtensionManager({
          directory: options.extensionDir,
          dataDir: this.dataRoot ?? join(options.extensionDir, ".data"),
          settings: options.extensionSettings ?? createFileSettingsStore(join(options.extensionDir, ".settings")),
          bridge: {
            services: this.services,
            resumeSession: (id, extensionId) => this.resumeFrom(id, undefined, { kind: "extension", extensionId }),
            createSession: (sessionOptions, extensionId) => this.createFromExtension(sessionOptions, extensionId),
            readSessionMessages: (id, pageOptions) => this.readSessionMessages(id, pageOptions),
            sessions: () => [...this.activeSessions.values()],
            withBarrier: (extensionIds, timeoutMs, fn) => this.withBarrier(extensionIds, timeoutMs, fn),
            warn: (message) => console.warn(`[extensions] ${message}`),
          },
        });
    for (const [name, value] of Object.entries(options.services ?? {})) {
      // A plain object carrying an `instance` key is read as a registration descriptor;
      // anything else registers as the service itself (methods-only, not replaceable).
      if (isServiceDescriptor(value)) {
        const { instance, ...serviceOptions } = value;
        this.services.register(name, instance, serviceOptions);
      } else {
        this.services.register(name, value);
      }
    }
    for (const definition of options.extensions ?? []) {
      if (this.valueDefs.has(definition.id)) throw new HarnessConfigError(`duplicate by-value extension id "${definition.id}" in createHarness({ extensions })`);
      this.valueDefs.set(definition.id, definition);
    }
    // The host's process-tier registrations come first (extension `harness` halves may consume
    // them); a synchronous hook keeps the whole chain synchronous, so a synchronous extension's
    // service exists the moment `createHarness` returns.
    const composed = options.infrastructure?.();
    const absorb = (parts: HarnessInfrastructure | undefined): void => {
      this.infrastructure = parts ?? {};
    };
    this.sharedReady = composed instanceof Promise
      ? composed.then((parts) => {
          absorb(parts);
          return this.registerDefinitions(options.extensions);
        })
      : (absorb(composed), this.registerDefinitions(options.extensions));
    // Surfaced to whoever opens a session; never an unhandled rejection on its own.
    this.sharedReady.catch(() => undefined);
  }

  /**
   * Which session-facing parts the `infrastructure` hook built for the whole process — what a
   * multi-tenant host must not have, since every session on the process would share them.
   * Infrastructure (repository, logger, model runtime) is not listed: sharing it is the point.
   */
  async processSharedParts(): Promise<readonly ("mcpServers" | "oauthService" | "skillRegistry")[]> {
    await this.sharedReady;
    const parts: ("mcpServers" | "oauthService" | "skillRegistry")[] = [];
    if (this.infrastructure.mcpServers !== undefined) parts.push("mcpServers");
    if (this.infrastructure.oauthService !== undefined) parts.push("oauthService");
    if (this.infrastructure.skillRegistry !== undefined) parts.push("skillRegistry");
    return parts;
  }

  /** The session repository, once the `infrastructure` hook has had its say. */
  private async repository(): Promise<SessionRepository> {
    await this.sharedReady;
    this.memoryRepository ??= new MemorySessionRepository();
    return this.infrastructure.sessionRepository ?? this.memoryRepository;
  }
  /** The fallback repository, built once so two opens share one in-memory store. */
  private memoryRepository: MemorySessionRepository | undefined;

  /** The harness logger: the preset's, else the `AGENTS_LOG` env logger, else silent. */
  private get logger(): Logger {
    this.defaultLogger ??= envLogger() ?? noopLogger;
    return this.infrastructure.logger ?? this.defaultLogger;
  }
  private defaultLogger: Logger | undefined;

  /**
   * Run one by-value definition's `harness` half against a staging host: the service is COLLECTED,
   * not registered, so a throwing `harness` publishes nothing. Stays synchronous when `harness` is
   * — what lets a synchronous extension's service exist the moment `createHarness` returns.
   * Shared by construction and `replaceExtension`.
   */
  private stageValue(definition: ExtensionDefinition): StagedDefinition | Promise<StagedDefinition> {
    // The data folder exists before `harness` runs (synchronously: `harness` may be too).
    const dataDir = this.dataRoot !== undefined ? join(this.dataRoot, definition.id) : undefined;
    if (dataDir !== undefined) mkdirSync(dataDir, { recursive: true });
    this.runningCreate = definition.id;
    const done = (staged: StagedDefinition): StagedDefinition => {
      this.runningCreate = undefined;
      return staged;
    };
    const failed = (error: unknown): never => {
      this.runningCreate = undefined;
      throw error;
    };
    try {
      const staged = stageDefinition(definition, {
        defaultReplaceable: false,
        ...(dataDir !== undefined ? { dataDir } : {}),
        createSession: (sessionOptions) => {
          if (this.runningCreate !== undefined) {
            return Promise.reject(
              new Error(`extension "${this.runningCreate}": createSession is not available inside create() — open sessions later, from setup, a tool, or an event`),
            );
          }
          return this.createFromExtension(sessionOptions, definition.id);
        },
        resumeSession: (id) => this.resumeFrom(id, undefined, { kind: "extension", extensionId: definition.id }),
        readSessionMessages: (id, pageOptions) => this.readSessionMessages(id, pageOptions),
        service: (name) => this.services.handle(name),
        warn: (message) => console.warn(`[extensions] ${message}`),
      });
      return staged instanceof Promise ? staged.then(done, failed) : done(staged);
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * Register the by-value definitions, in order: check each one's `uses` against the registry
   * (a consumer must come after its provider), then run its `harness` half if it has one and
   * register the result as a service under the extension's `id`. Stays synchronous as long as
   * every `harness` is — so `createHarness` returns with a synchronous extension's service
   * already registered; the first async `harness` turns the rest of the sequence into a promise
   * chain that `assemble` awaits. Staging (`stageDefinition`) collects before registering,
   * so a throwing `harness` publishes nothing.
   */
  private registerDefinitions(extensions: readonly ExtensionDefinition[] | undefined): Promise<void> {
    if (extensions === undefined) return Promise.resolve();
    const run = (definition: ExtensionDefinition): void | Promise<void> => {
      for (const name of definition.uses ?? []) {
        if (!this.services.has(name)) {
          throw new HarnessConfigError(`extension "${definition.id}" uses service "${name}", which is not registered — list its provider earlier in createHarness({ extensions }) (or register it in services)`);
        }
      }
      if (definition.harness === undefined) return;
      const staged = this.stageValue(definition);
      const publish = (result: StagedDefinition): void => {
        if (result.service !== undefined) {
          this.services.register(result.service.name, result.service.instance, result.service.options);
          this.createdServices.push(result.service.name);
        }
      };
      if (staged instanceof Promise) return staged.then(publish);
      publish(staged);
    };
    let chain: Promise<void> | undefined;
    for (const definition of extensions) {
      if (chain === undefined) {
        const result = run(definition);
        if (result !== undefined) chain = result;
      } else {
        chain = chain.then(() => run(definition));
      }
    }
    return chain ?? Promise.resolve();
  }

  /**
   * The default agent for sessions with no explicit `agent`: the builtin `agent` profile rendered as
   * an Agent — its tool names resolved against {@link toolPalette}, its model forced to `options.model`
   * (the profile declares none). Capability tools (goal/plan/todo/…) still join at runtime via the
   * session's capabilities.
   *
   * Built fresh per session. Runtime-specific prompt data is not captured here: `instructions`
   * resolves the current frame's environment + cwd through the Session cache, so root/subagent/worktree
   * prompts stay isolated without coupling Agent lifetime to environment lifetime.
   */
  private buildDefaultAgent(config: SessionConfig, sessionTools: readonly Tool[] | undefined): Promise<Agent<TContext>> {
    const steps = config.limits?.maxStepsPerTurn;
    return buildAgentFromProfile<TContext>(DEFAULT_AGENT_PROFILES[DEFAULT_AGENT_PROFILE_NAME]!, {
      tools: sessionTools === undefined ? this.toolPalette : toolPaletteOf(sessionTools),
      // The profile declares no model: the harness default. A model the session names is applied
      // on the session itself, like `setModel`.
      ...(this.defaultConfig.model !== undefined ? { model: this.defaultConfig.model } : {}),
      ...(config.appendSystemPrompt !== undefined ? { roleAdditional: config.appendSystemPrompt } : {}),
      ...(steps !== undefined ? { maxStepsPerTurn: steps } : {}),
      ...(config.modelSettings !== undefined ? { modelSettings: config.modelSettings as ModelSettings } : {}),
      resolveModel: this.resolveModel,
    });
  }

  /**
   * The Agent/Workflow tools only appear when a run has subagents to spawn. The fleet defaults to
   * the builtin coder/explore/plan profiles so orchestration works out of the box; an explicit
   * provider overrides it, and `subagents: false` (or a `null` provider) opts out, hiding those tools.
   */
  private subagentProviderFor(config: SessionConfig, bindings: SessionBindings<TContext>, sessionTools: readonly Tool[] | undefined): SubagentProvider<TContext> | null {
    if (config.subagents === false) return null;
    const chosen = bindings.subagentProvider;
    if (chosen !== undefined) return chosen;
    if (sessionTools === undefined && bindings.extraSubagentProfiles === undefined) return this.defaultSubagents;
    return defaultSubagentProvider<TContext>(
      sessionTools ?? this.agentTools,
      this.resolveModel,
      bindings.extraSubagentProfiles ?? this.options.extraSubagentProfiles,
    );
  }

  private runOverridesFor(config: SessionConfig, bindings: SessionBindings<TContext>, sessionTools: readonly Tool[] | undefined): SessionRunOverrides<TContext> {
    const maxTurns = config.limits?.maxTurns;
    const subagents = config.subagents === false ? undefined : config.subagents;
    return {
      subagentProvider: this.subagentProviderFor(config, bindings, sessionTools),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(subagents?.workflowTool !== undefined ? { workflowTool: subagents.workflowTool } : {}),
      ...(subagents?.maxConcurrent !== undefined ? { maxConcurrentSubagents: subagents.maxConcurrent } : {}),
    };
  }

  get sessions(): ReadonlyMap<string, HarnessSession<TContext>> {
    return this.activeSessions;
  }

  /**
   * Called for every session this harness opens, whichever way it was opened — `createSession`,
   * a cold `resumeSession`, `forkSession`, or an extension doing any of the three — after it is
   * fully assembled and BEFORE it can start a run. This is where a host wires events and approval
   * handlers, so a subscriber never misses a session's first event. The returned function (if any)
   * runs when that session closes. A listener that throws fails the open, which is rolled back:
   * a host can refuse a session that should not exist here. Attaching to an already loaded session
   * does not fire it again. Returns an unsubscribe function.
   */
  onSessionOpened(listener: SessionOpenedListener<TContext>): () => void {
    this.openListeners.push(listener);
    return () => {
      const index = this.openListeners.indexOf(listener);
      if (index >= 0) this.openListeners.splice(index, 1);
    };
  }

  /** What every session starts from: the harness's own session configuration. */
  get config(): HarnessConfig {
    return { ...this.options.config, defaults: this.defaultConfig, policy: this.sessionPolicy };
  }

  get defaults(): SessionConfig {
    return this.defaultConfig;
  }

  /** What no session's configuration can override. */
  get policy(): SessionPolicy {
    return this.sessionPolicy;
  }

  /** Passing `agent` replaces the harness's for this session, so its output type wins too. */
  async createSession<TAgentOutput>(opts: CreateSessionOptions<TContext> & { readonly bindings: { readonly agent: Agent<TContext, TAgentOutput> } }): Promise<HarnessSession<TContext, TAgentOutput>>;
  async createSession(opts?: CreateSessionOptions<TContext>): Promise<HarnessSession<TContext, TOutput>>;
  async createSession(opts: CreateSessionOptions<TContext> = {}): Promise<HarnessSession<TContext, any>> {
    return this.createFrom(opts, undefined);
  }

  /** `source` is the session an extension created this one from: it lends its directory and its
   *  owner, and — because the new session runs for the same party — its execution boundary: a
   *  source on an environment of its own means this one must be given one too. */
  private async createFrom(opts: CreateSessionOptions<TContext>, source: SessionSource | undefined): Promise<HarnessSession<TContext>> {
    this.assertAcceptingSessions();
    this.assertSessionOptions(opts);
    const request = this.requestOf(opts);
    const workDir = opts.workDir ?? source?.workDir ?? this.options.config?.workDir ?? process.cwd();
    const ownerKey = opts.ownerKey ?? source?.ownerKey;
    const id = opts.id ?? randomUUID();
    return this.trackOpen(id, async () => {
      const handle = await this.prepareRecord(request, () => this.repository().then((repository) => repository.create({ id, workDir, ownerKey, title: opts.title })));
      return this.assemble({
        operation: "create",
        id: handle.id,
        workDir: handle.workDir,
        store: handle.store,
        request,
        ...(source !== undefined ? { source } : {}),
        ...(ownerKey !== undefined ? { ownerKey } : {}),
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        createdRecord: true,
      });
    });
  }

  /**
   * Track construction through reconciliation and cleanup; closes wait for this promise. A
   * `closeSession` that lands while the open is in flight cancels it: the instance is closed the
   * moment it is built and everyone waiting gets `SessionClosedError`, never a dead handle.
   */
  private async prepareRecord(request: OpenRequest<TContext>, prepare: () => Promise<SessionHandle>): Promise<SessionHandle> {
    try { return await prepare(); }
    catch (error) {
      try { await request.bindings.release?.(); } catch (cleanup) { this.logger.log("warn", "binding release failed", { error: String(cleanup) }); }
      throw error;
    }
  }

  private trackOpen(id: string, open: () => Promise<HarnessSession<TContext>>): Promise<HarnessSession<TContext>> {
    if (this.opening.has(id)) throw new SessionAlreadyLoadingError(id);
    if (this.getSession(id) !== undefined) throw new SessionAlreadyLoadedError(id);
    const promise: Promise<HarnessSession<TContext>> = Promise.resolve().then(open)
      .then(async (session) => {
        if (!this.cancelledOpens.has(id)) return session;
        await session.close();
        throw new SessionClosedError(id);
      })
      .finally(() => {
        this.cancelledOpens.delete(id);
        if (this.opening.get(id) === promise) this.opening.delete(id);
      });
    this.opening.set(id, promise);
    return promise;
  }

  /**
   * Get the session with this id, loading it if it is not loaded.
   *
   * `resumeSession(id)` — no options — attaches or restores: a loaded session is returned as it is,
   * a load already in flight is joined (every caller gets the same instance or the same error),
   * and otherwise the session is restored from storage. What it runs on comes from the setup stored
   * with it, the harness defaults, and `resolveSession` for what cannot be stored. It never
   * reconfigures or replaces a loaded instance, never starts a turn, never creates missing history.
   *
   * `resumeSession(id, options)` restores an UNLOADED session with what the caller hands it. Because
   * options cannot be applied to an instance that already exists without silently dropping them,
   * it throws `SessionAlreadyLoadedError` / `SessionAlreadyLoadingError` instead of joining. A
   * `config` given here replaces the stored setup.
   *
   * Missing history throws `SessionRepositoryNotFoundError`. A close in progress is awaited before
   * restoring. A live object the session was created with and nobody provides now throws
   * `SessionDependencyMissingError` — the harness does not fall back to a default resource.
   */
  resumeSession<TAgentOutput>(id: string, opts: ResumeSessionOptions<TContext> & { readonly bindings: { readonly agent: Agent<TContext, TAgentOutput> } }): Promise<HarnessSession<TContext, TAgentOutput>>;
  resumeSession(id: string, opts?: ResumeSessionOptions<TContext>): Promise<HarnessSession<TContext, TOutput>>;
  async resumeSession(id: string, opts?: ResumeSessionOptions<TContext>): Promise<HarnessSession<TContext, any>> {
    return this.resumeFrom(id, opts);
  }

  private async resumeFrom(id: string, opts?: ResumeSessionOptions<TContext>, origin?: SessionOrigin): Promise<HarnessSession<TContext, any>> {
    if (this.closing !== undefined) throw new HarnessClosedError();
    if (this.resolving.getStore() === id) {
      throw new HarnessConfigError(`resolveSession for session "${id}" tried to open that same session; it supplies configuration and live objects, it does not open sessions`);
    }
    if (opts === undefined) {
      const inflight = this.opening.get(id);
      if (inflight !== undefined) return inflight;
      const loaded = this.getSession(id);
      if (loaded !== undefined) return loaded;
    } else {
      this.assertSessionOptions(opts);
      if (this.opening.has(id)) throw new SessionAlreadyLoadingError(id);
      if (this.getSession(id) !== undefined) throw new SessionAlreadyLoadedError(id);
    }
    const request = this.requestOf({ ...(opts ?? {}), ...(origin !== undefined ? { origin } : {}) });
    // An instance still registered here is closing (or closed): wait it out, then restore.
    const leaving = this.activeSessions.get(id);
    return this.trackOpen(id, async (): Promise<HarnessSession<TContext>> => {
      if (leaving !== undefined) await leaving.close();
      const repository = await this.repository();
      const handle = await repository.open(id);
      if (handle === undefined) throw new SessionRepositoryNotFoundError(id);
      const summary = await repository.get(id);
      return this.assemble({
        operation: "restore",
        id: handle.id,
        workDir: handle.workDir,
        store: handle.store,
        request,
        ...(summary?.ownerKey !== undefined ? { ownerKey: summary.ownerKey } : {}),
        ...(summary?.title !== undefined ? { title: summary.title } : {}),
        createdRecord: false,
      });
    });
  }

  /**
   * Fork an existing session into a new one and open it. The fork copies the history and the stored
   * setup, never a connection or a sandbox: live objects are provided again (by the caller or by
   * `resolveSession`), and one the source needed that is missing now is an error. A `config` given
   * here is laid over the source's setup field by field.
   */
  async forkSession<TAgentOutput>(sourceId: string, opts: ForkSessionOptions<TContext> & { readonly bindings: { readonly agent: Agent<TContext, TAgentOutput> } }): Promise<HarnessSession<TContext, TAgentOutput>>;
  async forkSession(sourceId: string, opts?: ForkSessionOptions<TContext>): Promise<HarnessSession<TContext, TOutput>>;
  async forkSession(
    sourceId: string,
    opts: ForkSessionOptions<TContext> = {},
  ): Promise<HarnessSession<TContext, any>> {
    this.assertAcceptingSessions();
    this.assertSessionOptions(opts);
    const request = this.requestOf(opts);
    const id = opts.id ?? randomUUID();
    return this.trackOpen(id, async () => {
    const repository = await this.repository();
    const origin = await repository.get(sourceId);
    const handle = await this.prepareRecord(request, () => repository.fork(sourceId, {
      id,
      ...(opts.ownerKey !== undefined ? { ownerKey: opts.ownerKey } : {}),
      ...(opts.title !== undefined ? { title: opts.title } : {}),
    }));
    const ownerKey = opts.ownerKey ?? origin?.ownerKey;
    const title = opts.title ?? origin?.title;
    return this.assemble({
        operation: "fork",
        id: handle.id,
        workDir: handle.workDir,
        store: handle.store,
        request,
        source: { id: sourceId, workDir: origin?.workDir ?? handle.workDir, ...(origin?.ownerKey !== undefined ? { ownerKey: origin.ownerKey } : {}), requires: [] },
        ...(ownerKey !== undefined ? { ownerKey } : {}),
        ...(title !== undefined ? { title } : {}),
        createdRecord: true,
      });
    });
  }

  /**
   * `createSession` from an extension's `harness` half. Its options are checked — a key this
   * harness does not know is an error, never silently dropped. `from` names the session the new
   * one is created on behalf of (a lead spawning a teammate): like a session-side `createSession`,
   * the new session takes that one's directory and owner, and what that one needed live must be
   * provided for it too.
   */
  private async createFromExtension(sessionOptions: Parameters<import("./extensions/types.ts").ExtensionHostContext["createSession"]>[0], extensionId: string): Promise<HarnessSession<TContext>> {
    const unknown = Object.keys(sessionOptions ?? {}).filter((key) => !CREATE_SESSION_OPTION_KEYS.has(key));
    if (unknown.length > 0) {
      throw new HarnessConfigError(`createSession from an extension got unknown option${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => `"${key}"`).join(", ")}; per-extension parameters go in config.extensions`);
    }
    const { from, inherit, ...rest } = (sessionOptions ?? {});
    if (from !== undefined && typeof from !== "string") throw new HarnessConfigError("createSession from an extension: `from` is the id of the session it is created on behalf of");
    if (inherit !== undefined) {
      if (!Array.isArray(inherit) || inherit.some((key) => !INHERITABLE_SETTINGS.has(key))) {
        throw new HarnessConfigError(`createSession from an extension: \`inherit\` lists settings to copy from \`from\` — any of ${[...INHERITABLE_SETTINGS].map((key) => `"${key}"`).join(", ")}`);
      }
      if (from === undefined) throw new HarnessConfigError("createSession from an extension: `inherit` copies from the `from` session, so it needs one");
    }
    const source = from === undefined ? undefined : await this.sourceOf(from);
    let options: CreateSessionOptions<TContext> = rest;
    if (from !== undefined && inherit?.includes("model") === true && rest.config?.model === undefined) {
      const model = await this.currentModelOf(from);
      if (model !== undefined) options = { ...rest, config: { ...(rest.config ?? {}), model } };
    }
    return this.createFrom({ ...options, origin: { kind: "extension", extensionId } }, source);
  }

  /** The model a session runs on right now, by name: the loaded instance's setting (a runtime
   *  `setModel` included), or — when it is not loaded here — the one stored with it. `undefined`
   *  when it runs on the harness default or on a model given as a live object. */
  private async currentModelOf(sessionId: string): Promise<string | undefined> {
    const live = this.activeSessions.get(sessionId);
    if (live !== undefined) {
      const setting = live.modelSetting;
      return typeof setting === "string" ? setting : undefined;
    }
    const handle = await (await this.repository()).open(sessionId);
    const stored = await handle?.store.getState(SESSION_MODEL_KEY);
    return typeof stored === "string" ? stored : undefined;
  }

  /** The session an extension is acting from, as the source of what it creates: the loaded
   *  instance, or — when it is not loaded here — what is stored with it. */
  private async sourceOf(sessionId: string): Promise<SessionSource> {
    const session = this.activeSessions.get(sessionId);
    if (session !== undefined) {
      return { id: session.id, workDir: session.workDir, ...(session.ownerKey !== undefined ? { ownerKey: session.ownerKey } : {}), requires: session.requires };
    }
    const repository = await this.repository();
    const [summary, handle] = await Promise.all([repository.get(sessionId), repository.open(sessionId)]);
    if (summary === undefined || handle === undefined) throw new SessionRepositoryNotFoundError(sessionId);
    const stored = await this.readStoredSetup(sessionId, handle.store);
    return { id: sessionId, workDir: handle.workDir, ...(summary.ownerKey !== undefined ? { ownerKey: summary.ownerKey } : {}), requires: stored.requires };
  }

  /** The fully opened session with this id, running or not. Undefined while opening or closed. */
  getSession(id: string): HarnessSession<TContext> | undefined {
    if (this.opening.has(id)) return undefined;
    const session = this.activeSessions.get(id);
    return session?.status.state === "closed" ? undefined : session;
  }

  /** Read a session's durable handle without constructing a Session, opening capabilities,
   *  reconciling background tasks, or subscribing Projection. Intended for read-only servers.
   *  Soft-deleted sessions resolve only with `{ includeDeleted: true }` — audit/purge tooling. */
  async inspectSession(id: string, options?: OpenSessionOptions): Promise<SessionHandle | undefined> {
    return (await this.repository()).open(id, options);
  }

  /**
   * One page of a session's transcript, newest page first — open or closed alike, and NEVER by
   * opening it: a closed session stays closed (no Session built, no capabilities, no recovery).
   * What happened, including messages a compaction has since summarized away; see
   * `readTranscriptPage` for exactly what is read. Page backwards with the returned `next`.
   *
   * An open session is read through its own store after its pending appends have landed, so a
   * message appended a moment ago is already on the page. Only durable records are read: text
   * still streaming is not on any page — follow it live with `observeProjection`.
   * Soft-deleted and unknown ids throw `SessionRepositoryNotFoundError`.
   */
  async readSessionMessages(id: string, options?: TranscriptPageOptions): Promise<TranscriptPage> {
    const live = this.getSession(id);
    const liveStore = live?.core.store;
    if (live !== undefined && liveStore !== undefined) {
      await live.core.flushEvents();
      return readTranscriptPage(liveStore, options);
    }
    const handle = await this.inspectSession(id);
    if (handle === undefined) throw new SessionRepositoryNotFoundError(id);
    // Not closed on purpose: a read holds nothing, and some repositories hand back the very
    // store a later open will use (the in-memory one) — closing it here would close that.
    return readTranscriptPage(handle.store, options);
  }

  /** Read one catalog row without the O(N) `listSessions()` scan. */
  async getSessionSummary(id: string): Promise<SessionSummary | undefined> {
    return (await this.repository()).get(id);
  }

  /** Close one open session by id (no-op if it isn't open). An open in flight for this id is
   *  cancelled — whoever awaits it gets `SessionClosedError` — and waited for, so a close/delete
   *  never races a half-built session. */
  async closeSession(id: string): Promise<void> {
    const inflight = this.opening.get(id);
    if (inflight !== undefined) {
      // Abandon the open: it closes the instance as soon as it is built and rejects for everyone
      // waiting on it, so nobody is handed a session that is already closed.
      this.cancelledOpens.add(id);
      await inflight.catch(() => undefined);
      return;
    }
    await this.activeSessions.get(id)?.close();
  }

  /**
   * Delete a session after releasing any open in-process handle. Soft by default — the durable
   * record is retained and `resumeSession` stops resolving it. `{ purge: true }` destroys it.
   */
  async deleteSession(id: string, options?: DeleteSessionOptions): Promise<void> {
    await this.closeSession(id);
    await (await this.repository()).delete(id, options);
  }

  /** Undo a soft delete. No-op when the session is absent or was never deleted. */
  async restoreSession(id: string): Promise<void> {
    return (await this.repository()).restore(id);
  }

  async listSessions(filter?: ListSessionsFilter): Promise<readonly SessionSummary[]> {
    return (await this.repository()).list(filter);
  }

  /** Set a session's title (an empty string clears it). Works on open and closed sessions alike. */
  async renameSession(id: string, title: string): Promise<void> {
    await (await this.repository()).rename(id, title.trim());
  }

  /**
   * Close every open session, then the harness scope — which disposes everything registered
   * there in reverse order: by-value `harness` halves die with the harness that ran them (each
   * drained, then its dispose hook — default the instance's close()), then the host's own
   * registrations, then the defaults.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closing = this.runClose();
    return this.closing;
  }

  private async runClose(): Promise<void> {
    // Opens in flight finish (or fail) first: closing the scope tree under a half-built session
    // would tear its scope out from under `Session.open`. New opens are refused from here on
    // (`assertAcceptingSessions`), so the set only shrinks.
    this.abortController.abort();
    await Promise.allSettled([...this.opening.values()]);
    for (const session of [...this.activeSessions.values()]) await session.close();
    await this.sharedReady.catch(() => undefined);
    // The `harness` halves' services, newest first: each is drained, then disposed (default, the
    // instance's own close()). A failure here is logged, never allowed to skip the rest.
    for (const name of [...this.createdServices].reverse()) {
      try {
        await this.services.unregister(name);
      } catch (error) {
        this.logger.log("warn", `service "${name}" unregister failed during harness close`, {
          service: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.createdServices.length = 0;
    // Last: the process-shared objects the preset opened (MCP connections, handles). Every
    // session is closed by now, so nothing is still reading them.
    try {
      await this.infrastructure.close?.();
    } catch (error) {
      this.logger.log("warn", "harness parts close failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** An option this harness does not know is an error, and one that only shapes the default agent
   *  is an error beside a complete agent — neither is a no-op. */
  private assertSessionOptions(opts: OpenSessionOptionsBase<TContext>): void {
    const allowed = new Set(["id", "workDir", "ownerKey", "title", "config", "bindings", "origin"]);
    const unknown = Object.keys(opts).filter((key) => !allowed.has(key));
    if (unknown.length) throw new HarnessConfigError(`unknown session options: ${unknown.join(", ")}; use config and bindings`);
    // A request that contradicts itself is refused as such, whatever state the session is in.
    const config = opts.config !== null && typeof opts.config === "object" ? opts.config : undefined;
    if (opts.bindings?.agent !== undefined || config?.agent !== undefined) {
      assertNoDefaultAgentOptions(
        { modelSettings: config?.modelSettings, tools: opts.bindings?.tools ?? config?.tools, appendSystemPrompt: config?.appendSystemPrompt, maxStepsPerTurn: config?.limits?.maxStepsPerTurn },
        "this session",
      );
    }
  }

  /** Every path that opens a session starts here: a closing harness opens nothing new. */
  private assertAcceptingSessions(): void {
    if (this.closing !== undefined) throw new HarnessClosedError();
  }

  /**
   * Replace by-value extensions with new versions, as one coordinated act — the by-value twin of
   * `harness.extensions.reload()` (docs/architecture.md §5.5). Every session holding
   * one of them rendezvous at its run boundary (in-flight runs finish untouched — nothing is
   * aborted); in that global quiet moment the old halves detach, each `harness` half re-runs and
   * its service is swapped, and the new halves attach; then everyone resumes. Sessions born from
   * the quiet moment on are born with the new definitions. On rendezvous timeout NOTHING changes:
   * the barrier lifts, `BarrierTimeout` names the stuck sessions, and the caller retries later
   * (or closes the straggler).
   *
   * Pass EVERY definition a shape change affects in ONE call — the provider and the consumers
   * written against it — so they cross the barrier together; a consumer left out resumes against
   * the new shape running old code, which is the skew this whole mechanism exists to prevent.
   *
   * `services` swaps HOST-registered services (`createHarness({ services })`) in the same quiet
   * moment, for when the shape that changed is the host's rather than an extension's. Those obey
   * their `replaceable` flag; an extension's own `harness` service swaps unconditionally, since
   * its owner is being replaced along with it.
   *
   * Implementation-only swaps need none of this — `harness.services.replace` (layer 1) lands on
   * the next call and touches no session at all.
   */
  async replaceExtension(
    next: ExtensionDefinition | readonly ExtensionDefinition[],
    options: {
      /** Host-registered services to swap in the same quiet moment, by name. */
      readonly services?: Readonly<Record<string, unknown>>;
      /** Rendezvous budget; on expiry the replace fails and nothing changed. Default 30s. */
      readonly timeoutMs?: number;
      readonly drainTimeoutMs?: number;
    } = {},
  ): Promise<void> {
    const definitions = Array.isArray(next) ? [...(next as readonly ExtensionDefinition[])] : [next as ExtensionDefinition];
    if (definitions.length === 0) {
      throw new HarnessConfigError("replaceExtension needs at least one definition — to swap a service alone, use harness.services.replace");
    }
    for (const definition of definitions) {
      if (!this.valueDefs.has(definition.id)) {
        throw new HarnessConfigError(
          `cannot replace extension "${definition.id}": it is not registered on this harness by value — pass it in createHarness({ extensions }), or use harness.extensions.reload("${definition.id}") for a file extension`,
        );
      }
    }
    // A `harness` half still publishing would race the swap.
    await this.sharedReady;
    // Every new `harness` runs BEFORE the barrier: staging COLLECTS, so one that throws leaves the
    // world completely untouched (no session detached, no service swapped) — the same discipline
    // construction and the file manager use. Whatever a failed act staged is disposed below.
    const staged = new Map<string, StagedDefinition>();
    for (const definition of definitions) {
      if (definition.harness !== undefined) staged.set(definition.id, await this.stageValue(definition));
    }
    const published = new Set<string>();
    const ids = definitions.map((definition) => definition.id);
    try {
      await this.withBarrier(ids, options.timeoutMs ?? DEFAULT_REPLACE_TIMEOUT_MS, async (held) => {
        // Globally quiet. These two statements are ONE synchronous act: from here on newborn
        // sessions are born with the new definitions, and `targets` is exactly the set still
        // holding an old one — so nobody is swapped twice and nobody is missed.
        const targets = held()
          .map((session) => ({ session, held: ids.filter((id) => session.attachedExtensionIds().includes(id)) }))
          .filter((target) => target.held.length > 0);
        for (const definition of definitions) this.valueDefs.set(definition.id, definition);

        // Old halves out first: their `session.end` runs against the old shape.
        for (const target of targets) {
          for (const id of target.held) await target.session.detachExtension(id);
        }
        for (const [name, instance] of Object.entries(options.services ?? {})) {
          await this.services.replace(name, instance, options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {});
        }
        for (const definition of definitions) {
          await this.publishValueService(definition, staged.get(definition.id), options.drainTimeoutMs);
          published.add(definition.id);
        }
        // New halves in: their `session.start` runs against the new shape. The pending queue
        // applies immediately on idle sessions.
        for (const target of targets) {
          if (!this.activeSessions.has(target.session.id)) continue; // closed while the barrier held
          for (const id of target.held) await target.session.attachExtension(this.valueDefs.get(id)!);
        }
      });
    } catch (error) {
      // Rendezvous timed out, or a step failed: nothing staged was published, so dispose it —
      // a `harness` that opened a pool must not leak it because the barrier never converged.
      for (const [id, entry] of staged) {
        if (!published.has(id) && entry.service !== undefined) await this.disposeStaged(id, entry.service.instance);
      }
      throw error;
    }
  }

  /**
   * The service half of one replaced extension: publish what its `harness` staged. `replace`
   * rather than unregister + register, so consumers this barrier never gated — other extensions
   * holding a `uses` handle — see no gap; `force` because the owner is being replaced along with
   * it (see `ServiceRegistry.replace`).
   */
  private async publishValueService(
    definition: ExtensionDefinition,
    staged: StagedDefinition | undefined,
    drainTimeoutMs?: number,
  ): Promise<void> {
    const id = definition.id;
    const previous = this.createdServices.indexOf(id);
    const drain = drainTimeoutMs !== undefined ? { drainTimeoutMs } : {};
    if (staged?.service !== undefined) {
      if (previous >= 0) {
        await this.services.replace(id, staged.service.instance, { force: true, ...drain });
      } else {
        this.services.register(id, staged.service.instance, staged.service.options);
        this.createdServices.push(id);
      }
      return;
    }
    // The new version dropped its `harness` half: its service goes away with it.
    if (previous >= 0) {
      await this.services.unregister(id, drain);
      this.createdServices.splice(previous, 1);
    }
  }

  /** Dispose a `harness` result that was staged but never published (default rule: its `close()`). */
  private async disposeStaged(id: string, instance: unknown): Promise<void> {
    try {
      const close = (instance as { close?: unknown } | null | undefined)?.close;
      if (typeof close === "function") await (close as () => void | Promise<void>).call(instance);
    } catch (error) {
      console.warn(`[extensions] extension "${id}": disposing the unpublished harness() result failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The barrier itself (docs/architecture.md §5.5), shared by `replaceExtension` and
   * the plugin manager: gate every session holding one of `extensionIds` (synchronously, FIRST
   * — the set of running sessions only shrinks from there), rendezvous bounded by `timeoutMs`
   * (a straggler throws BarrierTimeout and nothing ran), then run `fn` in the globally quiet
   * moment. `held()` reads live, so sessions born gated during the barrier are included.
   * Whatever happens, every gate is released.
   */
  private async withBarrier(
    extensionIds: readonly string[],
    timeoutMs: number,
    fn: (held: () => readonly HarnessSession<TContext>[]) => Promise<void>,
  ): Promise<void> {
    if (this.activeBarrier !== undefined) throw new HarnessBusyError("another barrier operation is already in progress");
    const holds = new Map<string, { readonly quiescent: Promise<void>; release(): void }>();
    this.activeBarrier = { holds };
    try {
      for (const session of this.activeSessions.values()) {
        const ids = session.attachedExtensionIds();
        if (extensionIds.some((id) => ids.includes(id))) holds.set(session.id, session.holdAtBoundary());
      }
      const stuck = await rendezvous(holds, timeoutMs);
      if (stuck.length > 0) throw new BarrierTimeout(stuck);
      const held = () =>
        [...holds.keys()]
          .map((sessionId) => this.activeSessions.get(sessionId))
          .filter((session): session is HarnessSession<TContext> => session !== undefined);
      await fn(held);
    } finally {
      // Whatever happened, nothing stays held — a failed barrier leaves the world running.
      for (const hold of holds.values()) hold.release();
      this.activeBarrier = undefined;
    }
  }

  /** Resolve the capability set for one session — the `session` hook, called fresh every time. */
  private async resolveCapabilities(
    ctx: SessionCapabilityContext,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<readonly Capability[]> {
    // A session on its own environment (a sandbox) does not get the process's MCP connections or
    // skill scan: both describe the HARNESS's machine, not the one this session's tools run on.
    const base = this.options.sessionCapabilities !== undefined
      ? await this.options.sessionCapabilities(ctx)
      : defaultCapabilities({ session: ctx });
    // Every definition registered on this harness: by value (`extensions`, harness halves
    // included — their per-session `session` is mounted here like any other), then from files.
    const extensions = [...this.valueDefs.values(), ...(this.extensions?.sessionDefinitions() ?? [])];
    // An extension is mounted under its id, so one named like a capability the session already
    // has would displace it — refused by name rather than resolved by order.
    const baseNames = new Set(base.map((capability) => capability.name));
    for (const definition of extensions) {
      if (baseNames.has(definition.id)) {
        throw new HarnessConfigError(`extension "${definition.id}" has the name of one of this session's capabilities; give it another id`);
      }
    }
    // Put extension transforms first. Shell PreToolUse remains in the staged permission policy,
    // so it evaluates the final rewritten args before normal authorization.
    return [...extensionsCapability(extensions, { host: this.extensionHost(ctx.sessionId), params }), ...base];
  }

  /**
   * The harness-tier reach handed to a session's extensions: other sessions, and the model
   * provider registry. Bound to `sessionId` so `fork()` forks THAT session, not whichever one
   * happens to be active.
   *
   * `isIdle`/`waitForIdle` resolve the HarnessSession lazily — at capability-build time the
   * session object does not exist yet (this runs while it is being constructed).
   */
  private extensionHost(sessionId: string): ExtensionHost {
    const self = this;
    const runtime = this.modelManager;
    return {
      sessionId,
      // A session an extension creates runs for the same party as the one it acts from: it gets that
      // session's directory and owner, and what that session needed live must be provided for it too.
      createSession: async (options, extensionId = "unknown") =>
        self.createFrom(
          { ...(options?.title !== undefined ? { title: options.title } : {}), ...(options?.config !== undefined ? { config: options.config } : {}), origin: { kind: "extension", extensionId } },
          await self.sourceOf(sessionId),
        ),
      forkSession: (options, extensionId = "unknown") =>
        self.forkSession(sessionId, { ...(options?.title !== undefined ? { title: options.title } : {}), ...(options?.config !== undefined ? { config: options.config } : {}), origin: { kind: "extension", extensionId } }),
      resumeSession: (id, extensionId = "unknown") => self.resumeFrom(id, undefined, { kind: "extension", extensionId }),
      listSessions: () => self.listSessions(),
      registerProvider: (provider) => {
        runtime.models.setProvider(provider);
      },
      unregisterProvider: (id) => {
        runtime.models.deleteProvider(id);
      },
      services: {
        has: (name) => self.services.has(name),
        handle: <T = unknown>(name: string): T => self.services.handle<T>(name),
      },
      isIdle: () => self.activeSessions.get(sessionId)?.status.state !== "running",
      waitForIdle: async () => {
        const session = self.activeSessions.get(sessionId);
        // Taking and immediately releasing the run lock IS the wait: it can only be acquired
        // once the in-flight run has finished.
        if (session) await session.core.withRunLock(async () => undefined);
      },
    };
  }

  /** What a caller asked for on one open, read off its options. */
  private requestOf(opts: OpenSessionOptionsBase<TContext>): OpenRequest<TContext> {
    const bindings = opts.bindings ?? {};
    return {
      ...(opts.config !== undefined ? { config: this.validConfig(opts.config, "session config") } : {}),
      bindings, hasContext: hasOwnContext(bindings), origin: opts.origin ?? { kind: "host" },
    };
  }

  private validConfig(config: unknown, where: string): SessionConfig {
    try {
      return parseSessionConfig(config, where);
    } catch (error) {
      throw new HarnessConfigError(error instanceof Error ? error.message : String(error));
    }
  }

  /** The setup stored with a session: what it was explicitly configured with, and which kinds of
   *  live object it was opened on. A session from before this record existed has only its
   *  extension params, under their old key. */
  private async readStoredSetup(id: string, store: SessionStore): Promise<StoredSetup> {
    const raw = (await store.getState(SESSION_CONFIG_STATE_KEY)) as { readonly config?: unknown; readonly requires?: unknown } | null;
    if (raw !== null && typeof raw === "object") {
      let config: SessionConfig;
      try {
        config = parseSessionConfig(raw.config, `the stored setup of session "${id}"`);
      } catch (error) {
        throw new HarnessConfigError(error instanceof Error ? error.message : String(error));
      }
      const requires = Array.isArray(raw.requires) ? raw.requires.filter((key): key is SessionBindingKey => SESSION_BINDING_KEYS.includes(key as SessionBindingKey)) : [];
      return { config, requires, present: true };
    }
    const params = (await store.getState(EXTENSION_PARAMS_STATE_KEY)) as Record<string, unknown> | null;
    return { config: params !== null && typeof params === "object" ? { extensions: params } : {}, requires: [], present: false };
  }

  /** A fork does not inherit the parameters of an extension that says they identify one session. */
  private forkedSetup(config: SessionConfig): SessionConfig {
    if (config.extensions === undefined) return config;
    const dropped = new Set(this.allDefinitions().filter((definition) => definition.forkParams === "drop").map((definition) => definition.id));
    if (dropped.size === 0) return config;
    const extensions = Object.fromEntries(Object.entries(config.extensions).filter(([id]) => !dropped.has(id)));
    const { extensions: _extensions, ...rest } = config;
    return Object.keys(extensions).length > 0 ? { ...rest, extensions } : rest;
  }

  /**
   * The one way a session comes to exist in this process, shared by create, resume and fork: read
   * the stored setup, let the host resolve what cannot be stored, compute the configuration the
   * session runs on, check it against policy, assemble, wire, and only then let it run. Any
   * failure undoes exactly what was built — including a record this open created and whatever the
   * host's bindings acquired.
   */
  private async assemble(args: AssembleArgs<TContext>): Promise<HarnessSession<TContext>> {
    const { operation, id, workDir, store, request } = args;
    const releases: (() => void | Promise<void>)[] = [];
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      for (const run of releases.reverse()) {
        try {
          await run();
        } catch (error) {
          this.logger.log("warn", "session bindings release failed", { sessionId: id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    if (request.bindings.release !== undefined) releases.push(() => request.bindings.release!());
    const disposers: (() => void | Promise<void>)[] = [];
    let projection: SessionProjection | undefined;
    let core: Session | undefined;
    let session: HarnessSession<TContext> | undefined;
    try {
      // A session's `session` reaches a harness half through its service, so none opens before the
      // harness halves have registered them.
      await this.sharedReady;
      const stored = await this.readStoredSetup(id, store);
      const [storedModel, storedPermission, storedThinking] = operation === "create" ? [null, null, null]
        : await Promise.all([store.getState(SESSION_MODEL_KEY), store.getState(SESSION_PERMISSION_KEY), store.getState(SESSION_THINKING_KEY)]);
      const runtimeMode = (storedPermission as { readonly mode?: PermissionMode } | null)?.mode;
      const inherited = resolveSessionConfig(operation === "fork" ? this.forkedSetup(stored.config) : stored.config, {
        ...(typeof storedModel === "string" ? { model: storedModel } : {}),
        ...(typeof storedThinking === "string" ? { thinking: storedThinking as ThinkingLevel } : {}),
        ...(runtimeMode !== undefined ? { permission: { mode: runtimeMode } } : {}),
      });
      // What THIS call asked for.
      const asked = request.config ?? {};
      // Explicit configuration, by operation: a create has only what it was given; a resume keeps
      // the stored setup unless handed a `config`, which replaces it (the three runtime values a
      // setter owns survive when the new config does not name them); a fork adjusts its source's.
      let explicit: SessionConfig;
      if (operation === "create") explicit = asked;
      else if (operation === "restore" && request.config !== undefined) {
        const kept: SessionConfig = {
          ...(inherited.model !== undefined ? { model: inherited.model } : {}),
          ...(inherited.thinking !== undefined ? { thinking: inherited.thinking } : {}),
          ...(inherited.permission?.mode !== undefined ? { permission: { mode: inherited.permission.mode } } : {}),
        };
        explicit = resolveSessionConfig(kept, asked);
      } else explicit = resolveSessionConfig(inherited, asked);

      let bindings = request.bindings;
      let hasContext = request.hasContext;
      let fromResolver = false;
      const resolve = this.options.resolveSession;
      if (resolve !== undefined) {
        // The values a setter owns live in the core's own keys; the host sees them with the rest.
        const storedView = inherited;
        let resolution: SessionResolution<TContext> | undefined | void;
        {
          resolution = await this.resolving.run(id, () => resolve({
            operation,
            origin: request.origin,
            session: { id, workDir, ...(args.ownerKey !== undefined ? { ownerKey: args.ownerKey } : {}), ...(args.title !== undefined ? { title: args.title } : {}) },
            ...(args.source !== undefined
              ? { source: { id: args.source.id, workDir: args.source.workDir, ...(args.source.ownerKey !== undefined ? { ownerKey: args.source.ownerKey } : {}) } }
              : {}),
            requested: {
              ...(Object.keys(asked).length > 0 || request.config !== undefined ? { config: asked } : {}),
              bindings: request.bindings,
            },
            ...(operation !== "create" ? { stored: storedView } : {}),
            signal: this.abortController.signal,
          }));
        }
        if (resolution?.bindings !== undefined) {
          const resolved = resolution.bindings;
          if (resolved.release !== undefined) releases.push(() => resolved.release!());
          bindings = { ...bindings, ...resolved };
          hasContext = hasContext || hasOwnContext(resolved);
        }
        if (resolution?.config !== undefined) {
          try {
            explicit = parseSessionConfig(resolution.config, `resolveSession's result for session "${id}"`);
          } catch (error) {
            throw new HarnessConfigError(error instanceof Error ? error.message : String(error));
          }
          fromResolver = true;
        }
      }

      let effective = resolveSessionConfig(this.defaultConfig, explicit);
      const pluginServers = explicit.mcp === undefined && effective.mcp !== false ? this.infrastructure.pluginManager?.mcpServerConfigs() : undefined;
      if (pluginServers !== undefined) effective = { ...effective, mcp: { servers: { ...(effective.mcp && effective.mcp.servers), ...pluginServers } } };
      const strictPolicy = this.sessionPolicy.strictIsolation === true;
      const violation = sessionPolicyViolation(effective, this.sessionPolicy)
        ?? (strictPolicy && bindings.environment === undefined
          ? { field: "bindings.environment", reason: "this host isolates every session, so each one must be opened on its own environment; without one its tools would run in the harness's own" }
          : undefined);
      if (violation !== undefined) throw new SessionPolicyViolationError(id, violation.field, violation.reason);

      // What the session was created on must be provided again. A session an extension creates
      // from another must stay inside that one's execution boundary: where the source runs in an
      // environment of its own, so must this one (its agent, model and tools are its own affair).
      // Nothing here falls back to a default resource.
      const needed = operation === "create"
        ? (request.origin.kind === "extension" ? (args.source?.requires ?? []) : [])
        : stored.requires;
      const missing = needed.filter((key) => bindings[key] === undefined);
      if (missing.length > 0) throw new SessionDependencyMissingError(id, missing);

      // Names resolve against what is registered on the harness; an object given directly wins.
      const namedAgent = effective.agent !== undefined ? this.agents[effective.agent] : undefined;
      if (effective.agent !== undefined && bindings.agent === undefined && namedAgent === undefined) {
        const known = Object.keys(this.agents);
        throw new HarnessConfigError(`session "${id}" names the agent "${effective.agent}", which is not registered on this harness (registry.agents has ${known.length > 0 ? known.join(", ") : "none"})`);
      }
      const givenAgent = bindings.agent ?? namedAgent;
      if (givenAgent !== undefined) {
        assertNoDefaultAgentOptions(
          { modelSettings: effective.modelSettings, tools: bindings.tools ?? effective.tools, appendSystemPrompt: effective.appendSystemPrompt, maxStepsPerTurn: effective.limits?.maxStepsPerTurn },
          bindings.agent !== undefined || effective.agent !== undefined ? "this session" : "the harness",
        );
      }
      const sessionTools = bindings.tools ?? (effective.tools !== undefined ? this.toolsNamed(id, effective.tools) : undefined);

      // Store the setup: only what was explicitly configured (never the harness defaults, so a
      // change to those still reaches this session), and never what the host resolves each time.
      // A host's config replaces what is stored for THIS open only: a reopen keeps the setup it
      // had, and a create keeps what it was asked for — so what the caller set (an extension's
      // parameters for the session it spawns, say) survives a host that resolves every open.
      const storedConfig = withoutModel(fromResolver ? (operation === "create" ? asked : inherited) : explicit);
      const requires = SESSION_BINDING_KEYS.filter((key) => bindings[key] !== undefined || (operation !== "create" && stored.requires.includes(key)));
      const changed = JSON.stringify({ config: storedConfig, requires }) !== JSON.stringify({ config: stored.config, requires: stored.requires });
      if (changed) {
        // Checked before anything is connected; written only once the open has succeeded, so a
        // setup that cannot be assembled never replaces one that could.
        const secrets = inlineMcpSecretPaths(storedConfig);
        if (secrets.length > 0 && (strictPolicy || this.sessionPolicy.allowInlineMcpSecrets !== true)) {
          throw new HarnessConfigError(`session "${id}" would store MCP secrets as given (${secrets.join(", ")}). Read the token from the environment (bearerTokenEnvVar), hand credentials out per connect (bindings.mcpCredentials), or — on a single-user host whose session store is as trusted as its config file — set policy.allowInlineMcpSecrets.`);
        }
      }

      // From here the open is a transaction over live objects: the session is released to run only
      // once every step has succeeded.
      const events = new ListenerSink();
      const responder = new MutableResponder();
      // Environment: this open's → the harness's default → a LocalEnvironment at the session's own
      // workDir. The session only OPERATES a caller-supplied environment.
      const environment = bindings.environment ?? this.infrastructure.environment ?? new LocalEnvironment(workDir);
      // ONE open-time log read, shared: every shard from its newest checkpoint on (each
      // checkpoint carries the history and lifecycle before it). The projection seeds from it,
      // and Session.open receives it as `preloadedLog` so its capability restore + context
      // pre-build fold the same records — same IO, and the same `Message` objects.
      // Attach still happens BEFORE Session.open: no events flow yet, so the seed cannot
      // race the subscription, and anything capabilities emit during open is already folded.
      let preloadedLog = await readSessionTails(store);
      // A fresh session has an empty log; anything else is a reopen. Telemetry is the only reader.
      const resumed = preloadedLog.length > 0;
      projection = await SessionProjection.attach({ id, store, events }, preloadedLog);
      const interrupted = await store.getState(INTERRUPTION_STATE_KEY) !== null;
      if (!interrupted) {
        const recoveryRecords = await recoverOrphanedTurns(id, store, preloadedLog);
        if (recoveryRecords.length > 0) {
          for (const record of recoveryRecords) projection.applyRecord(record);
          preloadedLog = [...preloadedLog, ...recoveryRecords];
        }
      }
      const strictIsolation = strictPolicy;
      const capabilities = await this.resolveCapabilities(
        {
          sessionId: id,
          workDir,
          ...(args.ownerKey !== undefined ? { ownerKey: args.ownerKey } : {}),
          ownEnvironment: bindings.environment !== undefined,
          strictIsolation,
          // With a configured server set the overlay is already folded into it above.
          ...(bindings.mcpCredentials !== undefined ? { mcpCredentials: bindings.mcpCredentials } : {}),
          config: effective,
          bindings,
          shared: this.infrastructure,
          policy: this.sessionPolicy,
        },
        effective.extensions,
      );
      const publication = this.options.config?.eventPublication;
      const judge = this.options.autoApprover
        ?? (effective.permission?.mode === "auto" ? createAutoApprover() : undefined);
      const autoApprover = judge !== undefined && effective.permission?.autoApproval !== undefined
        ? { classify: (input: Parameters<AutoApprover["classify"]>[0]) => judge.classify({ ...input, autoApproval: effective.permission!.autoApproval }) }
        : judge;
      // Everything the session runs on, by value. The repository owns the store's lifetime.
      core = await Session.open({
        capabilities,
        preloadedLog,
        resumed,
        sessionId: id,
        store,
        events,
        responder,
        environment,
        permissionOptions: {
          mode: effective.permission?.mode ?? DEFAULT_PERMISSION_MODE,
          rules: [...(effective.permission?.rules ?? []), ...(this.sessionPolicy.permission?.rules ?? [])],
          ...(autoApprover !== undefined ? { autoApprover } : {}),
        },
        ...(this.infrastructure.logger !== undefined ? { logger: this.infrastructure.logger } : {}),
        ...(this.infrastructure.tracing !== undefined ? { tracing: this.infrastructure.tracing } : {}),
        ...(this.options.telemetry !== undefined ? { telemetry: this.options.telemetry } : {}),
        ...(publication !== undefined ? { eventPublication: publication } : {}),
      });
      // A custom capability factory may not honour policy; what it connected is still visible.
      const allowedTransports = strictIsolation && strictPolicy
        ? (this.sessionPolicy.allowedMcpTransports ?? ["http", "stdio"]).filter((kind) => kind === "http")
        : this.sessionPolicy.allowedMcpTransports;
      if (allowedTransports !== undefined) {
        const refused = (core.mcp?.list() ?? []).filter((view) => !allowedTransports.includes(view.transport));
        if (refused.length > 0) {
          throw new SessionPolicyViolationError(id, "mcp", `MCP server ${refused.map((view) => `"${view.name}"`).join(", ")} runs over ${refused[0]!.transport}, which this host does not allow`);
        }
      }
      if (givenAgent === undefined && this.defaultConfig.model === undefined && explicit.model === undefined && bindings.model === undefined && core.modelSetting === undefined) {
        throw new HarnessConfigError(`session "${id}" has no model: name one in the harness configuration (\`config.defaults.model\`, or \`model\`), in the session's own, or run a complete agent`);
      }
      const agent = givenAgent ?? (await this.buildDefaultAgent(effective, sessionTools));
      // A model the session names is set like `setModel`, so it is remembered with the session;
      // the harness default is not, and keeps reaching the session through its agent.
      if (bindings.model !== undefined) core.setModel(bindings.model);
      else if (explicit.model !== undefined && core.modelSetting !== explicit.model) core.setModel(explicit.model);
      if (explicit.thinking !== undefined) core.setThinking(explicit.thinking);
      else if (effective.thinking !== undefined) core.setDefaultThinking(effective.thinking);
      const built = new HarnessSession<TContext>({
        core,
        // The two caps land in different places: maxStepsPerTurn is an Agent property
        // (the Runner reads the agent's value first), maxTurns is a per-run option.
        agent,
        runner: this.runner,
        events,
        responder,
        projection,
        workDir,
        ...(args.ownerKey !== undefined ? { ownerKey: args.ownerKey } : {}),
        config: effective,
        requires,
        ...(this.sessionPolicy.permission?.allowedModes !== undefined ? { allowedModes: this.sessionPolicy.permission.allowedModes } : {}),
        context: hasContext ? bindings.context : this.options.context,
        runOverrides: this.runOverridesFor(effective, bindings, sessionTools),
        interrupted,
        mountExtension: (definition) => {
          const params = effective.extensions?.[definition.id];
          if (params === false) {
            throw new HarnessConfigError(`extension "${definition.id}" is opted out for this session (params["${definition.id}"] is false)`);
          }
          return extensionCapability(definition, { host: this.extensionHost(id), params, startReason: "attach" });
        },
        onClosed: async (sid) => {
          // Only THIS instance's registration goes — a later open under the same id (a resume
          // that waited for this close) must keep its own.
          for (const dispose of disposers.reverse()) {
            try {
              await dispose();
            } catch (error) {
              this.logger.log("warn", "session open listener cleanup failed", { sessionId: sid, error: error instanceof Error ? error.message : String(error) });
            }
          }
          await release();
          if (this.activeSessions.get(sid) === built) this.activeSessions.delete(sid);
        },
      });
      session = built;
      // Born gated: a session appearing while a reshape barrier holds must not start runs mid-swap.
      // Its quiescent is trivially settled — it has no run — so it never delays the rendezvous.
      if (this.activeBarrier !== undefined) this.activeBarrier.holds.set(id, built.holdAtBoundary());
      // A mode asked for on a reopen beats the one the session remembered, as a setter would.
      if (explicit.permission?.mode !== undefined) await built.setPermissionMode(explicit.permission.mode);
      // The mode a session remembered from a runtime switch is held to today's policy as well.
      const allowedModes = this.sessionPolicy.permission?.allowedModes;
      const mode = core.permissionModeSetting;
      if (allowedModes !== undefined && mode !== undefined && !allowedModes.includes(mode)) {
        throw new SessionPolicyViolationError(id, "permission.mode", `permission mode "${mode}", which this session was last switched to, is not allowed here (allowed: ${allowedModes.join(", ") || "none"}); restore it with a \`config.permission.mode\` that is`);
      }
      // Running subagents from a dead process (or copied by a fork) have no live task to reconnect to.
      if (operation !== "create") await built.background?.reconcileSubagents();
      // The host wires events and handlers now, while the session still cannot run.
      const info: SessionOpenInfo = {
        operation,
        origin: request.origin,
        ...(args.source !== undefined
          ? { source: { id: args.source.id, workDir: args.source.workDir, ...(args.source.ownerKey !== undefined ? { ownerKey: args.source.ownerKey } : {}) } }
          : {}),
      };
      for (const listener of [...this.openListeners]) {
        const dispose = await listener(built, info);
        if (typeof dispose === "function") disposers.push(dispose);
      }
      // Assembled and wired: this is the setup the session is restored from next time. It still
      // cannot run, so no turn precedes the record.
      if (changed) await store.putState(SESSION_CONFIG_STATE_KEY, { version: 1, config: storedConfig, requires });
      // Let it run (a reshape barrier that took a hold above keeps its own).
      if (this.cancelledOpens.has(id)) throw new SessionClosedError(id);
      this.activeSessions.set(id, built);
      built.releaseBirthHold();
      return built;
    } catch (error) {
      if (session !== undefined) {
        // Closing runs the listeners' cleanups and releases the bindings.
        await session.close().catch((closeError: unknown) => {
          this.logger.log("warn", "closing a session whose open failed also failed", { sessionId: id, error: closeError instanceof Error ? closeError.message : String(closeError) });
        });
      } else {
        await this.rollbackOpen(id, { projection, core }, error);
        await release();
      }
      if (args.createdRecord) {
        // The record this open made describes a session that never existed.
        try {
          await (await this.repository()).delete(id, { purge: true });
        } catch (deleteError) {
          this.logger.log("warn", "removing the record of a session whose open failed also failed", { sessionId: id, error: deleteError instanceof Error ? deleteError.message : String(deleteError) });
        }
      }
      throw error;
    }
  }

  /** The registered tools with these names, as one session's palette. */
  private toolsNamed(id: string, names: readonly string[]): readonly Tool[] {
    const unknown = names.filter((name) => this.toolPalette[name] === undefined);
    if (unknown.length > 0) {
      throw new HarnessConfigError(`session "${id}" names tool${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `"${name}"`).join(", ")}, not registered on this harness (registry.tools has ${Object.keys(this.toolPalette).join(", ") || "none"})`);
    }
    return names.map((name) => this.toolPalette[name]!);
  }

  /**
   * Undo a failed `assemble`, newest artifact first. Every step runs even if an earlier one
   * throws (a cleanup failure is logged, never allowed to mask the open's own error).
   */
  private async rollbackOpen(
    id: string,
    built: { readonly projection?: SessionProjection; readonly core?: Session },
    cause: unknown,
  ): Promise<void> {
    const logger = this.infrastructure.logger;
    const attempt = async (step: string, run: () => void | Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        logger?.log("warn", `session open rollback: ${step} failed`, {
          sessionId: id,
          step,
          error: error instanceof Error ? error.message : String(error),
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
    };
    await attempt("detach projection", () => built.projection?.detach());
    if (built.core !== undefined) await attempt("close core", () => built.core!.close());
  }

  /** Every definition this harness mounts, by value then from files. */
  private allDefinitions(): ExtensionDefinition[] {
    return [...this.valueDefs.values(), ...(this.extensions?.sessionDefinitions() ?? [])];
  }

}

/** A reshape rendezvous that did not converge in time. Nothing was changed; the sessions that
 *  never reached their run boundary are named so the caller can act on them and retry. */
export class BarrierTimeout extends Error {
  readonly stuckSessionIds: readonly string[];
  constructor(stuckSessionIds: readonly string[]) {
    super(`reshape barrier timed out; still running: ${stuckSessionIds.join(", ")}`);
    this.name = "BarrierTimeout";
    this.stuckSessionIds = stuckSessionIds;
  }
}

/** Await every hold's quiescent within the budget; report who is still running on expiry. */
async function rendezvous(
  holds: ReadonlyMap<string, { readonly quiescent: Promise<void> }>,
  timeoutMs: number,
): Promise<readonly string[]> {
  if (holds.size === 0) return [];
  const remaining = new Set(holds.keys());
  for (const [id, hold] of holds) void hold.quiescent.then(() => remaining.delete(id));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.all([...holds.values()].map((hold) => hold.quiescent)).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return timedOut ? [...remaining] : [];
}

let commandRegistry: CommandRegistry | undefined;
function sharedCommands(): CommandRegistry {
  commandRegistry ??= createExtensionCommandRegistry();
  return commandRegistry;
}

function isServiceDescriptor(value: unknown): value is { instance: unknown } & ServiceOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    "instance" in value
  );
}

/** Every key `createHarness` takes. */
const HARNESS_OPTION_KEYS: ReadonlySet<string> = new Set([
  "config", "registry", "resolveSession", "context", "autoApprover", "modelManager", "infrastructure",
  "sessionCapabilities", "telemetry", "services", "extensions", "extensionDir", "extensionDataDir", "extensionSettings", "extraSubagentProfiles",
]);

/** Where each option `createHarness` used to take flat lives now. */
const MOVED_HARNESS_OPTIONS: Readonly<Record<string, string>> = {
  model: "config.defaults.model (a ChatModel object: bindings.model on the session)",
  modelSettings: "config.defaults.modelSettings",
  appendSystemPrompt: "config.defaults.appendSystemPrompt",
  agent: "registry.agents + config.defaults.agent (an Agent object for one session: bindings.agent)",
  tools: "registry.tools (+ config.defaults.tools to name a subset)",
  permission: "config.defaults.permission (the judge: autoApprover)",
  maxTurns: "config.defaults.limits.maxTurns",
  maxStepsPerTurn: "config.defaults.limits.maxStepsPerTurn",
  mcpServers: "config.defaults.mcp.servers",
  mcpCredentials: "bindings.mcpCredentials on the session, or resolveSession",
  environment: "infrastructure().environment, or bindings.environment on the session",
  extensionParams: "config.defaults.extensions",
  subagentProvider: "config.defaults.subagents = false, or bindings.subagentProvider on the session",
  workflowTool: "config.defaults.subagents.workflowTool",
  maxConcurrentSubagents: "config.defaults.subagents.maxConcurrent",
  strictIsolation: "config.policy.strictIsolation",
  eventPublication: "config.eventPublication",
  workDir: "config.workDir",
  sessionHost: "resolveSession + harness.onSessionOpened",
};

/**
 * An option this harness does not know is an error, never silently dropped: a `permission` or a
 * `strictIsolation` that quietly stops applying is a boundary that quietly stops existing.
 */
function assertHarnessOptions(options: object): void {
  const unknown = Object.keys(options).filter((key) => !HARNESS_OPTION_KEYS.has(key) && (options as Record<string, unknown>)[key] !== undefined);
  if (unknown.length === 0) return;
  const described = unknown.map((key) => (MOVED_HARNESS_OPTIONS[key] !== undefined ? `\`${key}\` (now ${MOVED_HARNESS_OPTIONS[key]})` : `\`${key}\``));
  throw new HarnessConfigError(`createHarness got unknown option${unknown.length > 1 ? "s" : ""} ${described.join(", ")}`);
}

export function createHarness<TContext = unknown, TOutput = unknown>(
  options: HarnessOptions<TContext>,
): Harness<TContext, TOutput> {
  return new Harness<TContext, TOutput>(options);
}

function hasOwnContext<TContext>(value: { readonly context?: TContext }): boolean {
  return Object.prototype.hasOwnProperty.call(value, "context");
}

/** An already-discriminated resume answer. ApprovalResponse has no `kind` field, so the
 *  presence of a valid discriminant is unambiguous. */
function isInterruptAnswer(answer: ApprovalResponse | InterruptAnswer): answer is InterruptAnswer {
  return "kind" in answer && (answer.kind === "approval" || answer.kind === "input");
}
