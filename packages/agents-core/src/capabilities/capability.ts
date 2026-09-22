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
import type { ScopeKind, Token } from "../scope/token.ts";
import type { Needs, Resolved } from "./needs.ts";

/**
 * The narrow slice of the owning Session a capability may ACT on (as opposed to observe).
 * Implemented by `Session`; registered as `Tokens.SessionControls` and handed to capabilities that
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
   * this aborts THAT run and leaves the session usable; from `Tokens.SessionControls` it aborts the
   * session. Either way the affected run(s) settle as `status: "aborted"`.
   */
  abort(reason?: string): void;
  compact(options?: CompactRequestOptions): Promise<PendingCompaction>;
  getContextBreakdown(): ContextBreakdown | undefined;
  setModel(model: string | ChatModel): void;
  setThinking(level: ThinkingLevel): void;
}

/** The tiers a capability may contribute a service to. The token picks one; see {@link Provision}. */
export type ProvisionKind = "session" | "workspace";

/**
 * The session FACTS a provision gets for free, as opposed to the SERVICES it gets by declaring
 * them in `needs`. Deliberately tiny: everything a capability depends on should be visible in
 * its `needs`, where the compiler and the assembler can both see it.
 *
 * There is deliberately no `scope` here. A lookup inside `create` is a dependency the compiler
 * cannot see, the assembler cannot pre-check and a reader has to hunt for — and it is also how
 * the tier rule gets bypassed, since a scope handed to a workspace factory can reach down into
 * the session that triggered it. Anything a provision needs goes in `needs`.
 */
export interface SessionProvisionContext {
  readonly sessionId: string;
  /** The session's signal (aborts when the session is cancelled). */
  readonly signal: AbortSignal;
}

/**
 * What a WORKSPACE provision gets. Pointedly not the session's: the service outlives whichever
 * session happened to build it, so there is no session id here, and the signal is the
 * workspace's — cancelling the session that triggered the build must not abort an object every
 * other session is about to share.
 */
export interface WorkspaceProvisionContext {
  /** Aborts when the WORKSPACE is torn down, never when one session is. */
  readonly signal: AbortSignal;
}

export type ContextFor<K extends ProvisionKind> = K extends "session" ? SessionProvisionContext : WorkspaceProvisionContext;

/** @deprecated Use {@link SessionProvisionContext}; kept so existing session provisions read unchanged. */
export type ProvisionContext = SessionProvisionContext;

/**
 * A service a capability contributes: what it needs, where it lives (the token's scope), how it
 * is built and how it is torn down. `Session.open` resolves `needs`, runs `create` with the
 * result and registers it under `token`; `scope.close()` disposes it in reverse order.
 *
 * `needs` is the point of the shape. Declared dependencies are resolved BEFORE `create` runs, so
 * a missing one fails here — naming the capability and the field — instead of at whatever later
 * call first touches it; and `create` is handed exactly what it asked for, so it cannot quietly
 * grow a dependency nobody declared.
 *
 * `create` may be async (it typically folds the session log, attaches to the store, or connects
 * to something). `dispose` defaults to `instance.close()` when present.
 *
 * Write one with {@link provision}, which infers `deps` from `needs`.
 */
export interface Provision<T = unknown, N extends Needs<any> = Needs<any>, K extends ProvisionKind = ProvisionKind> {
  /**
   * The token decides the LIFETIME, not this list. A session-tier token is built once per
   * session; a workspace-tier one is built by the first session that declares it and then shared
   * by every session in that working directory, living as long as the workspace does.
   *
   * That is what lets a capability own its whole assembly. A skill scan or an MCP connection is
   * shared by nature — it used to be hand-wired in the host, outside the capability that needed
   * it, so the two halves could drift apart and every new host had to wire them again. Declaring
   * both halves here keeps them together.
   */
  readonly token: Token<T, K>;
  /** Field name → token (or `optional(token)`). Resolved once, before `create` runs. */
  readonly needs?: N;
  create(deps: Resolved<N>, ctx: ContextFor<K>): T | Promise<T>;
  dispose?(instance: T): void | Promise<void>;
}

/**
 * Define a SESSION-tier provision, inferring `deps` from `needs` — `provision({ token, needs: {
 * environment: Tokens.Environment }, create: ({ environment }) => … })`. The function exists only
 * so TypeScript can tie the two together; a bare object literal in `provides` would widen `needs`
 * and leave `deps` untyped.
 *
 * A session service may name any tier: everything else outlives it.
 */
export function provision<T, const N extends Needs<"session"> = Record<string, never>>(
  spec: Provision<T, N, "session">,
): Provision<T, N, "session"> {
  return spec;
}

/**
 * Define a WORKSPACE-tier provision: built by the first session in the workspace that declares
 * it, shared by every session after, disposed with the workspace.
 *
 * A separate function rather than a flag, because the tier changes two things at once and both
 * are type-level: `needs` may only name workspace and harness services (a session one would be
 * gone while this object is still handed out), and `create` gets the workspace's context — no
 * session id, and a signal that belongs to the workspace.
 */
export function workspaceProvision<T, const N extends Needs<"workspace"> = Record<string, never>>(
  spec: Provision<T, N, "workspace">,
): Provision<T, N, "workspace"> {
  return spec;
}

/**
 * What a capability's per-run `start` (and its tool providers) receive. Services are NOT here:
 * a capability resolves its dependencies once, in its provision, and keeps them — a run is where
 * they are used, not where they are found. What is here is what only a run has.
 */
export interface RunContext extends SessionProvisionContext {
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
 * A detachable part of the engine. Two tiers of lifecycle:
 *  - SESSION — `provides`: the services this capability contributes for the session's lifetime,
 *    each registered in the session scope by `Session.open` and disposed by `scope.close()`.
 *  - RUN — `start` / `stop`: per-run wiring, driven by the assembler.
 * Everything else (tools, hooks, injectors, policies, gates) is static contribution.
 */
export interface Capability {
  readonly name: string;
  readonly tools?: readonly Tool[];
  readonly toolProviders?: readonly ToolProvider[];
  readonly toolFilters?: readonly ToolFilter[];
  /** Arbitration this capability wants a say in. See {@link CapabilityGates}. */
  readonly gates?: CapabilityGates;
  readonly policies?: readonly PermissionPolicy[];
  readonly hooks?: Partial<LoopHooks>;
  readonly injectors?: readonly Injector[];
  /** Session-lived services, in dependency order. See {@link Provision}. */
  readonly provides?: readonly Provision<any, any, any>[];
  /** Per-run startup. `signal` aborts when the assembler's start timeout expires — the
   *  timeout itself still wins the race (the capability is marked absent), but a
   *  signal-respecting implementation can release whatever it was holding. */
  start?(ctx: RunContext, signal?: AbortSignal): Promise<void> | void;
  /** Per-run teardown. `signal` aborts when the stop timeout expires; the run does not
   *  wait past the timeout either way, so use the signal to abandon slow flushes
   *  instead of leaking them into the background. */
  stop?(signal?: AbortSignal): Promise<void> | void;
}

export interface CapabilityDiagnostic {
  readonly capability: string;
  readonly phase: "register" | "start" | "stop";
  readonly level: "warn" | "error";
  readonly message: string;
}
