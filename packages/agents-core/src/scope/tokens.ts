/**
 * Every framework token, by tier. `T.Machine`, `T.Goal`, … are the keys the harness, sessions,
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
import type { Machine, MachineFactory } from "../tool/machine.ts";
import type { EventPublicationMode, EventSink } from "../events/index.ts";
import type { SessionEventPublisher } from "../events/publisher.ts";
import type { TracingProcessor } from "../tracing/processor.ts";
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
import { token } from "./token.ts";

/** The session's whole append log, read once at open and memoized (see `Session.open`). */
export type SessionLogReader = () => Promise<readonly AgentRecord[]>;

export const T = Object.freeze({
  // ── harness tier: one per process ──────────────────────────────────────────────────────
  Logger: token<Logger>("logger", "harness"),
  SessionRepository: token<SessionRepository>("session-repository", "harness"),
  ModelRuntime: token<ModelRuntime>("model-runtime", "harness"),
  PluginManager: token<PluginManager>("plugin-manager", "harness"),
  /** Harness-level default machine (an instance or a per-session factory). */
  MachineFactory: token<Machine | MachineFactory>("machine-factory", "harness"),
  EventPublication: token<EventPublicationMode>("event-publication", "harness"),
  Tracing: token<TracingProcessor>("tracing", "harness"),

  // ── workspace tier: one per working directory (or tenant / environment on a server) ─────
  McpServers: token<McpServersHandle>("mcp", "workspace"),
  SkillRegistry: token<SkillRegistry>("skill-registry", "workspace"),
  McpOAuth: token<McpOAuthService>("mcp-oauth", "workspace"),
  /** Workspace-level default machine; consulted before the harness-level one. */
  WorkspaceMachineFactory: token<Machine | MachineFactory>("workspace-machine-factory", "workspace"),

  // ── session tier: identity and infrastructure ──────────────────────────────────────────
  SessionId: token<string>("session-id", "session"),
  /** Upstream cancellation the session's own signal is derived from. Optional. */
  HostSignal: token<AbortSignal>("host-signal", "session"),
  /** The session's signal (host signal ∪ `session.abort()`); registered by `Session.open`. */
  SessionSignal: token<AbortSignal>("session-signal", "session"),
  /** The durable store the OPENER registers (disk / Pg / Redis / memory). Absent = a storeless
   *  (in-memory) session. Capabilities never read this one — see `Store`. */
  StoreBackend: token<SessionStore>("store-backend", "session"),
  /** The store everything in the session writes through: `StoreBackend` wrapped so that
   *  record-backed events are published on `Events` when an append commits. Registered by
   *  `Session.open`; absent when there is no backend. */
  Store: token<SessionStore>("store", "session"),
  /** This session's own machine factory (a `createSession({ machine })` override); wins over the
   *  workspace- and harness-level ones. */
  SessionMachineFactory: token<Machine | MachineFactory>("session-machine-factory", "session"),
  /** Per-session override of the harness-level `EventPublication`. */
  SessionEventPublication: token<EventPublicationMode>("session-event-publication", "session"),
  Machine: token<Machine>("machine", "session"),
  Events: token<EventSink>("events", "session"),
  Steer: token<SteerBus>("steer", "session"),
  EventPublisher: token<SessionEventPublisher>("event-publisher", "session"),
  Responder: token<Responder>("responder", "session"),
  /** Host-injected spawner used when no background capability is open. */
  BackgroundSpawner: token<BackgroundSpawner>("background-spawner", "session"),
  PermissionOptions: token<PermissionManagerOptions>("permission-options", "session"),
  Permission: token<PermissionManager>("permission", "session"),
  SessionLog: token<SessionLogReader>("session-log", "session"),
  SessionControls: token<SessionControls>("session-controls", "session"),

  // ── session tier: capability services (name = capability name) ─────────────────────────
  Goal: token<GoalStore>("goal", "session"),
  Plan: token<PlanMode>("plan", "session"),
  Todo: token<TodoStore>("todo", "session"),
  Task: token<TaskStore>("task", "session"),
  Workflow: token<WorkflowManager>("workflow", "session"),
  Background: token<BackgroundManager>("background", "session"),
  Compaction: token<CompactionService>("compaction", "session"),
  Skills: token<SkillsService>("skills", "session"),
  /** `mcpServersCapability` (config-driven controllers). */
  Mcp: token<McpServersHandle>("mcp-session", "session"),
  /** `mcpCapability` (caller-built `MCPServer` instances). */
  McpRaw: token<readonly MCPServer[]>("mcp-raw", "session"),
  Plugins: token<PluginManager>("plugins", "session"),
  HookEngine: token<HookEngine>("user-hooks", "session"),
});
