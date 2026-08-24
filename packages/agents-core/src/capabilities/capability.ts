import type { LoopHooks } from "../loop/types.ts";
import type { PermissionPolicy } from "../permission/types.ts";
import type { Message } from "../protocol/index.ts";
import type { Tool } from "../tool/types.ts";
import type { Machine } from "../tool/machine.ts";
import type { BackgroundSpawner } from "../tool/background.ts";
import type { EventSink } from "../events/index.ts";
import type { AgentRecord, SessionStore } from "../store/index.ts";
import type { SteerBus } from "../loop/steer.ts";
import type { Responder } from "../permission/types.ts";
import type { Injector } from "./injection.ts";
import type { ToolProvider } from "./tool-provider.ts";
import type { Logger } from "../logging/index.ts";
import type { ChatModel } from "../llm/define-model.ts";
import type { ThinkingLevel } from "../llm/model.ts";
import type { ContextBreakdown } from "../agent/context-report.ts";
import type { CompactRequestOptions, PendingCompaction } from "./compaction/index.ts";

/**
 * The narrow slice of the owning Session a capability may ACT on (as opposed to observe).
 * Implemented by `Session`; handed to capabilities that participate in the run rather than
 * just watching it — today the extension runtime's `ctx.actions`.
 *
 * Deliberately narrow: everything here is already a public Session operation, so nothing new
 * becomes reachable — a capability simply gets a typed handle instead of the whole Session.
 * Compaction-dependent calls throw when no compaction capability is open; callers are expected
 * to treat that as "unavailable", not as a fatal error.
 */
export interface SessionControls {
  /**
   * Cancel work. Scope depends on where the controls came from: from a `CapabilityContext`
   * (per run) this aborts THAT run and leaves the session usable; from a `SessionContext` it
   * aborts the session. Either way the affected run(s) settle as `status: "aborted"`.
   */
  abort(reason?: string): void;
  compact(options?: CompactRequestOptions): Promise<PendingCompaction>;
  getContextBreakdown(): ContextBreakdown | undefined;
  setModel(model: string | ChatModel): void;
  setThinking(level: ThinkingLevel): void;
}

export interface CapabilityContext {
  readonly sessionId: string;
  readonly machine: Machine;
  readonly store?: SessionStore;
  readonly events?: EventSink;
  readonly responder?: Responder;
  readonly signal: AbortSignal;
  readonly background?: BackgroundSpawner;
  readonly injection?: import("./injection.ts").InjectionManager;
  readonly steer?: SteerBus;
  readonly logger?: Logger;
  readonly controls?: SessionControls;
  /** Gates contributed by every capability in this run, for whoever needs to consult them. */
  readonly gates?: AssembledGates;
}

/** Collected gate implementations, in capability registration order. */
export interface AssembledGates {
  readonly compaction: readonly CompactionGate[];
}

export interface SessionContext {
  readonly sessionId: string;
  readonly machine: Machine;
  readonly store?: SessionStore;
  readonly events: EventSink;
  readonly signal: AbortSignal;
  readonly steer: SteerBus;
  readonly controls?: SessionControls;
  /** The session's records (append order), read once at open and memoized, so log-fold
   *  capabilities (goal/plan/todo) share one read instead of each calling `readLog`.
   *  Use `readSessionLog(ctx)` — it falls back to a direct read when this is absent. */
  readonly logRecords?: () => Promise<readonly AgentRecord[]>;
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
  readonly service?: unknown;
  /** Per-run startup. `signal` aborts when the assembler's start timeout expires — the
   *  timeout itself still wins the race (the capability is marked absent), but a
   *  signal-respecting implementation can release whatever it was holding. */
  start?(ctx: CapabilityContext, signal?: AbortSignal): Promise<void> | void;
  /** Per-run teardown. `signal` aborts when the stop timeout expires; the run does not
   *  wait past the timeout either way, so use the signal to abandon slow flushes
   *  instead of leaking them into the background. */
  stop?(signal?: AbortSignal): Promise<void> | void;
  openSession?(ctx: SessionContext): Promise<void> | void;
  closeSession?(): Promise<void> | void;
}

export interface CapabilityDiagnostic {
  readonly capability: string;
  readonly phase: "register" | "start" | "stop";
  readonly level: "warn" | "error";
  readonly message: string;
}
