import type { LoopHooks } from "../loop/types.ts";
import type { PermissionPolicy } from "../permission/types.ts";
import type { Message } from "../protocol/index.ts";
import type { Tool } from "../tool/types.ts";
import type { Injector } from "./injection.ts";
import type { ToolProvider } from "./tool-provider.ts";
import type { ChatModel } from "../llm/define-model.ts";
import type { ThinkingLevel } from "../llm/model.ts";
import type { ContextBreakdown } from "../agent/context-report.ts";
import type { CompactRequestOptions, PendingCompaction } from "./compaction/index.ts";
import type { Environment } from "../tool/environment.ts";
import type { EventSink } from "../events/index.ts";
import type { AgentRecord, SessionStore } from "../store/index.ts";
import type { SteerBus } from "../loop/steer.ts";
import type { Logger } from "../logging/index.ts";

/**
 * The narrow slice of the owning Session a capability may ACT on (as opposed to observe).
 * Implemented by `Session`; handed to capabilities at `openSession` and to those that
 * participate in the run rather than just watching it — today the extension runtime's
 * `ctx.actions`.
 *
 * Deliberately narrow: everything here is already a public Session operation, so nothing new
 * becomes reachable — a capability simply gets a typed handle instead of the whole Session.
 * Compaction-dependent calls throw when no compaction capability is open; callers are expected
 * to treat that as "unavailable", not as a fatal error.
 */
export interface SessionControls {
  /**
   * Cancel work. Scope depends on where the controls came from: from a `RunContext` (per run)
   * this aborts THAT run and leaves the session usable; from `SessionContext.controls` it aborts the
   * session. Either way the affected run(s) settle as `status: "aborted"`.
   */
  abort(reason?: string): void;
  compact(options?: CompactRequestOptions): Promise<PendingCompaction>;
  getContextBreakdown(): ContextBreakdown | undefined;
  setModel(model: string | ChatModel): void;
  setThinking(level: ThinkingLevel): void;
}

/**
 * What a capability is handed when the session opens: the session's own objects, passed by
 * VALUE. There is no registry to look anything up in — a capability receives exactly what
 * `Session.open` decided to give it, and a dependency it did not receive is a dependency it
 * does not have.
 */
export interface SessionContext {
  readonly sessionId: string;
  readonly environment: Environment;
  readonly store?: SessionStore;
  readonly events: EventSink;
  /** Aborts when the SESSION is cancelled. */
  readonly signal: AbortSignal;
  readonly steer: SteerBus;
  readonly controls?: SessionControls;
  /** The session's logger, when the host gave it one. */
  readonly logger?: Logger;
  /**
   * The session's records (append order), read once at open and memoized, so the log-folding
   * capabilities (goal/plan/todo) share one read instead of each calling `readLog`.
   * Use `readSessionLog(ctx)` — it falls back to a direct read when this is absent.
   */
  readonly logRecords?: () => Promise<readonly AgentRecord[]>;
}

/**
 * What a capability's per-run `start` (and its tool providers) receive. Session-lived objects
 * are NOT here: a capability is handed those once, at `openSession`, and keeps them — a run is
 * where they are used, not where they are found. What is here is what only a run has.
 */
export interface RunContext {
  readonly sessionId: string;
  /** Aborts when this RUN is cancelled (downstream of the session signal). */
  readonly signal: AbortSignal;
  readonly injection: import("./injection.ts").InjectionManager;
  /** Gates contributed by every capability in this run, for whoever needs to consult them. */
  readonly gates: AssembledGates;
  /** Same operations as the session's controls, except `abort` is scoped to this run. */
  readonly controls: SessionControls;
}

/** Collected gate implementations, in capability registration order. */
export interface AssembledGates {
  readonly compaction: readonly CompactionGate[];
}

/**
 * Which frame a toolset is being assembled for. A capability's tools are visible to every agent
 * in the session — the main one and each subagent — and some of them should not be: a tool that
 * negotiates with the human (a plan to approve) or rewrites the conversation's own goal belongs
 * to the agent the human is talking to. That is a visibility question, distinct from who OWNS
 * the state behind the tool (docs/state-and-lifetime.md); a capability may need to answer both.
 */
export interface ToolFilterContext {
  /** The frame's journal address: `main` for the root agent, `main/<agentId>` for a subagent. */
  readonly address: string;
  /** True for the session's root agent — the one whose turns a human is watching. */
  readonly isRootAgent: boolean;
}

/**
 * Narrows the assembled toolset just before a turn runs. The mirror image of `toolProviders`:
 * providers add, filters remove. Called once per turn with the complete registry (agent tools ∪
 * capability tools ∪ handoff/subagent tools), so a filter that drops a handoff tool is
 * responsible for what that does to the agent graph. A filter that throws is skipped.
 */
export type ToolFilter = (tools: readonly Tool[], ctx: ToolFilterContext) => readonly Tool[];

/**
 * Gates are the one place where a capability ASKS other capabilities before acting, instead of
 * the engine asking capabilities. Every other extension point (`hooks`, `toolFilters`,
 * `injectors`) is engine-driven; compaction is not — it decides on its own that the context is
 * too big, so anyone who wants a say has to be consulted by it.
 *
 * Deliberately a named table rather than a generic string-keyed bus: this interface IS the
 * complete list of "things another capability may veto", and adding one requires changing core.
 * If it ever grows past a handful of entries, that is the signal to design a real middleware
 * mechanism rather than to keep extending this.
 */
export interface CompactionGateContext {
  readonly reason: "manual" | "auto";
  /** Full model-visible history at the moment compaction was triggered. */
  readonly messages: readonly Message[];
  /** How many leading messages the default strategy intends to fold into one summary. */
  readonly compactCount: number;
  readonly signal: AbortSignal;
}

export interface CompactionGateResult {
  /** Skip this compaction pass entirely. The context is left untouched. */
  readonly cancel?: boolean;
  /**
   * Supply the summary yourself instead of letting compaction call the model for it — e.g. a
   * rule-based digest, or a cheaper model. `count` defaults to the strategy's `compactCount`.
   *
   * This writes into durable history and shapes every later turn: a summary that drops load-
   * bearing context does not fail loudly, it makes the agent quietly forget. Own that.
   */
  readonly replacement?: { readonly summary: string; readonly count?: number };
}

export type CompactionGate = (ctx: CompactionGateContext) => Promise<CompactionGateResult | undefined>;

export interface CapabilityGates {
  compaction?: CompactionGate;
}

/**
 * What the engine promises a capability, and what it demands back. This is the ONE thing that
 * separates an engine part from behaviour written on top of it — not what either can reach.
 *
 *  - `invariant` — always present, never timed out, never detached; a failure fails the run.
 *    Reserved for the things whose absence is an INCIDENT rather than a missing feature:
 *    permission, compaction. Only these may contribute `policies`, and a file may not deliver
 *    one (dropping a file in a directory must not be able to rewrite the permission rules).
 *  - `detachable` — may be absent, may be hot-swapped, its hooks are timed and its failures are
 *    isolated to a log line. Almost everything is this.
 *
 * The test, in one question: if this were skipped once, is that a missing feature or an
 * incident? Missing feature → `detachable`. Incident → `invariant`.
 */
export type CapabilityContract = "invariant" | "detachable";

/**
 * A part of the engine, assembled into one session. Two tiers of lifecycle:
 *  - SESSION — `openSession` / `closeSession`: the session-lived wiring, driven by `Session.open`
 *    and `Session.close`. What it wants to publish goes in `service`.
 *  - RUN — `start` / `stop`: per-run wiring, driven by the assembler.
 * Everything else (tools, hooks, injectors, policies, gates) is static contribution.
 */
export interface Capability {
  readonly name: string;
  /** See {@link CapabilityContract}. Decides whether the engine may time this out, isolate its
   *  failures, and detach it — and whether it may contribute `policies`. */
  readonly contract: CapabilityContract;
  readonly tools?: readonly Tool[];
  readonly toolProviders?: readonly ToolProvider[];
  readonly toolFilters?: readonly ToolFilter[];
  /** Arbitration this capability wants a say in. See {@link CapabilityGates}. */
  readonly gates?: CapabilityGates;
  /** Permission rules. `invariant` only — a rule that can be timed out or detached is a rule
   *  that fails OPEN, which is how a dangerous tool runs anyway. */
  readonly policies?: readonly PermissionPolicy[];
  readonly hooks?: Partial<LoopHooks>;
  readonly injectors?: readonly Injector[];
  /**
   * What this capability publishes to the session, reachable as `session.service(name)` and
   * through the named accessors (`session.goal`, …). Built by `openSession`, torn down by
   * `closeSession`. One per capability: a capability that wants to publish two things publishes
   * one object with two properties.
   */
  readonly service?: unknown;
  /**
   * Session-lived setup: fold the log, attach to the store, connect. Runs once, at `Session.open`,
   * with everything the session decided to hand out. A `detachable` capability that throws here
   * is absent for the session (logged, run continues); an `invariant` one fails the open.
   */
  openSession?(ctx: SessionContext): Promise<void> | void;
  /** Session-lived teardown, in reverse registration order. */
  closeSession?(): Promise<void> | void;
  /** Per-run startup. `signal` aborts when the assembler's start timeout expires — the
   *  timeout itself still wins the race (the capability is marked absent), but a
   *  signal-respecting implementation can release whatever it was holding. */
  start?(ctx: RunContext, signal?: AbortSignal): Promise<void> | void;
  /** Per-run teardown. `signal` aborts when the stop timeout expires; the run does not
   *  wait past the timeout either way, so use the signal to abandon slow flushes
   *  instead of leaking them into the background. */
  stop?(signal?: AbortSignal): Promise<void> | void;
}

/** What a definition's process-shared half is handed. Aborts when the harness is torn down. */
export interface CapabilityHostContext {
  readonly signal: AbortSignal;
}

/**
 * The reusable half of a capability: what it is, how its configuration is validated, and how to
 * build one instance per session. Code configuration and a loaded file both produce THIS — the
 * single entry point, so there is no second assembly path with its own lifecycle to keep in
 * step with this one.
 *
 * The split matters. A definition is shared by every session; the `Capability` that `create`
 * returns — with its injectors, its closures, its `service` — belongs to exactly one. A module
 * that builds a stateful capability at import time and hands the same object to everyone has
 * session A's state showing up in session B, which is why `create` exists at all.
 *
 * `shared` is the escape hatch for what genuinely cannot be per-session (a connection pool, one
 * scan of a directory). It runs ONCE, when the harness starts — not lazily inside whichever
 * session happened to open first, so nothing about it depends on who got there first.
 */
export interface CapabilityDefinition<Config = unknown, Shared = void> {
  readonly id: string;
  /** See {@link CapabilityContract}. A loader must refuse an `invariant` definition. */
  readonly contract: CapabilityContract;
  /** Validate (and narrow) the configuration before anything is built from it. */
  parseConfig(value: unknown): Config;
  /** The process-shared half: once per harness, before any session opens. */
  shared?(config: Config, host: CapabilityHostContext): Shared | Promise<Shared>;
  /** The per-session half: one fresh `Capability` per session. */
  create(config: Config, ctx: { readonly shared: Shared }): Capability;
}

/** A definition plus the configuration it was registered with, and where it came from. */
export interface CapabilityRegistration<Config = unknown, Shared = void> {
  readonly definition: CapabilityDefinition<Config, Shared>;
  readonly config: unknown;
  readonly source: { readonly kind: "code" } | { readonly kind: "file"; readonly path: string; readonly version?: string };
}

export interface CapabilityDiagnostic {
  readonly capability: string;
  readonly phase: "register" | "start" | "stop";
  readonly level: "warn" | "error";
  readonly message: string;
}
