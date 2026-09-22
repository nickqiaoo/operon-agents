/**
 * Every framework token, by tier. `Tokens.Environment`, `Tokens.Goal`, … are the keys the harness, sessions,
 * capabilities and hosts use to register and look things up in a {@link Scope}.
 *
 * Token names for capability services equal the capability's `name` ("goal", "plan", …).
 * A config VALUE (`EventPublication`, `PermissionOptions`) is a token too: it takes part in the
 * same "this call → the tier above → the default" resolution as the objects do.
 *
 * Only `import type` here — a token file that pulled in runtime modules would sit in the
 * middle of every dependency cycle in the package.
 */
import type { Logger } from "../logging/logger.ts";
import type { SessionRepository } from "../store/repository.ts";
import type { AgentRecord, SessionStore } from "../store/index.ts";
import type { ModelRuntime } from "../llm/runtime.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { Environment, EnvironmentFactory } from "../tool/environment.ts";
import type { EventPublicationMode, EventSink } from "../events/index.ts";
import type { SessionEventPublisher } from "../events/publisher.ts";
import type { TracingProcessor } from "../tracing/processor.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import type { McpServersHandle } from "../mcp/manager.ts";
import type { SkillRegistry } from "../capabilities/skills/registry.ts";
import type { McpOAuthService } from "../mcp/oauth/service.ts";
import type { SteerBus } from "../loop/steer.ts";
import type { Responder } from "../permission/types.ts";
import type { PermissionManager, PermissionManagerOptions } from "../permission/manager.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import type { SessionControls } from "../capabilities/capability.ts";
import type { GoalStore } from "../capabilities/goal/index.ts";
import type { PlanMode } from "../capabilities/plan/plan-mode.ts";
import type { TodoStore } from "../capabilities/todo/todo-store.ts";
import type { TaskStore } from "../capabilities/task/task-store.ts";
import type { WorkflowManager } from "../agent/workflow/manager.ts";
import type { BackgroundManager } from "../capabilities/background/manager.ts";
import type { CompactionService } from "../capabilities/compaction/service.ts";
import type { SkillsService } from "../capabilities/skills/service.ts";
import type { HookEngine } from "../capabilities/user-hooks/engine.ts";
import type { MCPServer } from "../mcp/server.ts";
import { capabilityToken, token } from "./token.ts";

/** The session's whole append log, read once at open and memoized (see `Session.open`). */
export type SessionLogReader = () => Promise<readonly AgentRecord[]>;

export const Tokens = Object.freeze({
  // ── harness tier: one per process ──────────────────────────────────────────────────────
  Logger: token<Logger, "harness">("logger", "harness", "the harness scope — register it when the harness is created"),
  SessionRepository: token<SessionRepository, "harness">("session-repository", "harness", "the harness scope — register it when the harness is created"),
  ModelRuntime: token<ModelRuntime, "harness">("model-runtime", "harness", "the harness scope — register it when the harness is created"),
  PluginManager: token<PluginManager, "harness">("plugin-manager", "harness", "the harness scope — register it when the harness is created"),
  /** Harness-level default environment (an instance or a per-session factory). */
  EnvironmentFactory: token<Environment | EnvironmentFactory, "harness">("environment-factory", "harness", "the harness scope — register it when the harness is created"),
  EventPublication: token<EventPublicationMode, "harness">("event-publication", "harness", "the harness scope — register it when the harness is created"),
  Tracing: token<TracingProcessor, "harness">("tracing", "harness", "the harness scope — register it when the harness is created"),
  /** Product telemetry (docs/telemetry.md). Absent = nothing is counted. */
  Telemetry: token<TelemetryService, "harness">("telemetry", "harness", "the harness scope — register it when the harness is created"),

  // ── workspace tier: one per working directory (or tenant / environment on a server) ─────
  McpServers: token<McpServersHandle, "workspace">("mcp", "workspace", "the workspace scope — register it when the workspace is opened"),
  SkillRegistry: token<SkillRegistry, "workspace">("skill-registry", "workspace", "the workspace scope — register it when the workspace is opened"),
  McpOAuth: token<McpOAuthService, "workspace">("mcp-oauth", "workspace", "the workspace scope — register it when the workspace is opened"),
  /** Workspace-level default environment; consulted before the harness-level one. */
  WorkspaceEnvironmentFactory: token<Environment | EnvironmentFactory, "workspace">("workspace-environment-factory", "workspace", "the workspace scope — register it when the workspace is opened"),

  // ── session tier: infrastructure ───────────────────────────────────────────────────────
  // What is NOT here is as deliberate as what is. A session's id, the host's signal and the
  // durable store are `Session.open` ARGUMENTS: nothing inherits them from a parent scope,
  // nothing else shares them, and they have no lifetime for a scope to manage. Its permission
  // manager and event publisher are its own FIELDS, for the same reason — one producer and one
  // consumer, both inside `Session`. Registering any of them would make this table double as a
  // parameter list, which is how it grew confusing in the first place.
  /** The session's signal (host signal ∪ `session.abort()`); registered by `Session.open`. */
  SessionSignal: token<AbortSignal, "session">("session-signal", "session", "`Session.open` — a session missing it is not open"),
  /** The store everything in the session writes through: `StoreBackend` wrapped so that
   *  record-backed events are published on `Events` when an append commits. Registered by
   *  `Session.open`; absent when there is no backend. */
  Store: token<SessionStore, "session">("store", "session", "`Session.open`, and only when the opener gave it a store — a storeless session has none"),
  /** This session's own environment factory (a `createSession({ environment })` override); wins over the
   *  workspace- and harness-level ones. */
  SessionEnvironmentFactory: token<Environment | EnvironmentFactory, "session">("session-environment-factory", "session", "the session opener — pass it to `createSession`"),
  /** Per-session override of the harness-level `EventPublication`. */
  SessionEventPublication: token<EventPublicationMode, "session">("session-event-publication", "session", "the session opener — pass it to `createSession`"),
  /**
   * The durable store the OPENER hands the session (disk / Pg / Redis / memory). Absent = a
   * storeless, in-memory session.
   *
   * The one parameter-shaped token that earns its place: a `Runner` opens the session, but the
   * store is chosen by the host's `session` hook, and a hook can only write to the scope. So this
   * is how the hook passes it along — `Session.open` prefers its own `store` option and falls back
   * to this. Capabilities never read it; they read `Tokens.Store`, the publishing wrapper.
   */
  StoreBackend: token<SessionStore, "session">("store-backend", "session", "the session opener — pass it to `createSession`"),
  Environment: token<Environment, "session">("environment", "session", "`Session.open` — a session missing it is not open"),
  Events: token<EventSink, "session">("events", "session", "`Session.open` — a session missing it is not open"),
  Steer: token<SteerBus, "session">("steer", "session", "`Session.open` — a session missing it is not open"),
  Responder: token<Responder, "session">("responder", "session", "the session opener — pass it to `createSession`"),
  /** Host-injected spawner used when no background capability is open. */
  BackgroundSpawner: token<BackgroundSpawner, "session">("background-spawner", "session", "the session opener — pass it to `createSession`"),
  PermissionOptions: token<PermissionManagerOptions, "session">("permission-options", "session", "the session opener — pass it to `createSession`"),
  SessionLog: token<SessionLogReader, "session">("session-log", "session", "`Session.open` — a session missing it is not open"),
  SessionControls: token<SessionControls, "session">("session-controls", "session", "`Session.open` — a session missing it is not open"),

  // ── session tier: capability services (name = capability name) ─────────────────────────
  Goal: capabilityToken<GoalStore>("goal"),
  Plan: capabilityToken<PlanMode>("plan"),
  Todo: capabilityToken<TodoStore>("todo"),
  Task: capabilityToken<TaskStore>("task"),
  Workflow: capabilityToken<WorkflowManager>("workflow"),
  Background: capabilityToken<BackgroundManager>("background"),
  Compaction: capabilityToken<CompactionService>("compaction"),
  Skills: capabilityToken<SkillsService>("skills"),
  /** `mcpServersCapability` — config-driven controllers, plus a view over `McpServers` when the
   *  workspace registered one. */
  Mcp: capabilityToken<McpServersHandle>("mcp-session", "mcp"),
  /**
   * `mcpCapability` (caller-built `MCPServer` instances). A LIFECYCLE ANCHOR, not a lookup: it
   * exists because `provides` is the only session-lived hook a capability has, and every
   * `Provision` needs a token. Nothing reads it, and it is deliberately NOT `Mcp`: a controller
   * reconnects by rebuilding its server from the config it holds, and an instance handed in from
   * outside has no config to rebuild from — so these servers have no control plane to expose, and
   * `session.mcp?.list() ?? []` does not see them. Same reason it cannot share `Mcp`'s name: two
   * MCP capabilities in one session would collide on it.
   */
  McpRaw: capabilityToken<readonly MCPServer[]>("mcp-raw", "mcp"),
  Plugins: capabilityToken<PluginManager>("plugins"),
  HookEngine: capabilityToken<HookEngine>("user-hooks"),
});
