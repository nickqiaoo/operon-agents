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
import type { Scope } from "../scope/scope.ts";
import type { Token } from "../scope/token.ts";

/**
 * The narrow slice of the owning Session a capability may ACT on (as opposed to observe).
 * Implemented by `Session`; registered as `T.SessionControls` and handed to capabilities that
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
   * this aborts THAT run and leaves the session usable; from `T.SessionControls` it aborts the
   * session. Either way the affected run(s) settle as `status: "aborted"`.
   */
  abort(reason?: string): void;
  compact(options?: CompactRequestOptions): Promise<PendingCompaction>;
  getContextBreakdown(): ContextBreakdown | undefined;
  setModel(model: string | ChatModel): void;
  setThinking(level: ThinkingLevel): void;
}

/**
 * What a capability's `Provision.create` receives: the session scope (everything the session
 * registered — `T.Machine`, `T.Store`, `T.Events`, `T.Steer`, `T.SessionLog`,
 * `T.SessionControls`, plus whatever earlier capabilities provided) and the two values every
 * provision needs. Everything else is a `ctx.scope.get(T.…)` away.
 */
export interface ProvisionContext {
  readonly scope: Scope;
  readonly sessionId: string;
  /** The session's signal (aborts when the session is cancelled). */
  readonly signal: AbortSignal;
}

/**
 * A service a capability contributes, declaring where it lives (the token's scope), how it is
 * built and how it is torn down. `Session.open` runs `create` for each capability in order and
 * registers the result under `token`; `scope.close()` disposes it in reverse registration order.
 *
 * `create` may be async (it typically folds the session log, attaches to the store, or connects
 * to something). `dispose` defaults to `instance.close()` when present.
 */
export interface Provision<T = unknown> {
  readonly token: Token<T>;
  create(ctx: ProvisionContext): T | Promise<T>;
  dispose?(instance: T): void | Promise<void>;
}

/** What a capability's per-run `start` (and its tool providers) receive. */
export interface RunContext {
  readonly scope: Scope;
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
 * Narrows the assembled toolset just before a turn runs. The mirror image of `toolProviders`:
 * providers add, filters remove. Called once per turn with the complete registry (agent tools ∪
 * capability tools ∪ handoff/subagent tools), so a filter that drops a handoff tool is
 * responsible for what that does to the agent graph. A filter that throws is skipped.
 */
export type ToolFilter = (tools: readonly Tool[]) => readonly Tool[];

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
  readonly provides?: readonly Provision[];
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
