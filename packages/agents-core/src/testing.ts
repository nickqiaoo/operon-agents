/**
 * Scope-wiring helpers for tests and quick scripts (exported via `operon-agents-core/internal`).
 *
 * A test describes a session's objects as a flat options bag; these turn that bag into the
 * harness/session scopes the engine actually takes. Nothing here is a compatibility layer for
 * production code — hosts compose scopes through the harness hooks.
 */
import { Scope } from "./scope/scope.ts";
import { T } from "./scope/tokens.ts";
import { Runner, type RunnerConfig } from "./agent/runner.ts";
import { Session, type SessionOpenOptions } from "./agent/session.ts";
import type { Machine, MachineFactory } from "./tool/machine.ts";
import type { SessionStore, AgentRecord } from "./store/index.ts";
import { ListenerSink, type EventSink, type EventPublicationMode } from "./events/index.ts";
import type { TracingProcessor } from "./tracing/index.ts";
import type { Responder } from "./permission/types.ts";
import type { PermissionManagerOptions } from "./permission/manager.ts";
import type { Capability, ProvisionContext, RunContext } from "./capabilities/capability.ts";
import { InjectionManager } from "./capabilities/injection.ts";
import { readLog } from "./capabilities/capability-state.ts";
import { SteerBus } from "./loop/steer.ts";
import type { BackgroundSpawner } from "./tool/background.ts";
import type { Logger } from "./logging/index.ts";
import { NullMachine } from "./tool/machine-null.ts";


export interface TestSessionWiring {
  readonly machine?: Machine | MachineFactory;
  readonly store?: SessionStore;
  readonly events?: EventSink;
  readonly tracing?: TracingProcessor;
  readonly responder?: Responder;
  readonly permission?: PermissionManagerOptions;
  readonly capabilities?: readonly Capability[];
  readonly steer?: SteerBus;
  readonly background?: BackgroundSpawner;
  readonly eventPublication?: EventPublicationMode;
  readonly logger?: Logger;
}

export type TestRunnerOptions<TContext = unknown> = TestSessionWiring & RunnerConfig<TContext>;

/** A harness scope carrying the harness-tier parts of a wiring bag. */
export function testHarnessScope(wiring: TestSessionWiring = {}): Scope<"harness"> {
  const harness = new Scope("harness");
  if (wiring.machine !== undefined) harness.register(T.MachineFactory, wiring.machine, { owned: false });
  if (wiring.tracing !== undefined) harness.register(T.Tracing, wiring.tracing, { owned: false });
  if (wiring.logger !== undefined) harness.register(T.Logger, wiring.logger, { owned: false });
  if (wiring.eventPublication !== undefined) harness.register(T.EventPublication, wiring.eventPublication);
  return harness;
}

/** Register the session-tier parts of a wiring bag on a session scope (skipping what's set). */
export function wireTestSession(scope: Scope<"session">, wiring: TestSessionWiring): void {
  if (wiring.store !== undefined && !scope.hasLocal(T.StoreBackend)) scope.register(T.StoreBackend, wiring.store, { owned: false });
  if (wiring.events !== undefined && !scope.hasLocal(T.Events)) scope.register(T.Events, wiring.events, { owned: false });
  if (wiring.responder !== undefined && !scope.hasLocal(T.Responder)) scope.register(T.Responder, wiring.responder, { owned: false });
  if (wiring.permission !== undefined && !scope.hasLocal(T.PermissionOptions)) scope.register(T.PermissionOptions, wiring.permission);
  if (wiring.steer !== undefined && !scope.hasLocal(T.Steer)) scope.register(T.Steer, wiring.steer, { owned: false });
  if (wiring.background !== undefined && !scope.hasLocal(T.BackgroundSpawner)) scope.register(T.BackgroundSpawner, wiring.background, { owned: false });
}

/** `new Runner(...)` for tests: the wiring bag becomes a harness scope + a per-session hook. */
export function testRunner<TContext = unknown>(options: TestRunnerOptions<TContext> = {}): Runner<TContext> {
  const { machine, store, events, tracing, responder, permission, capabilities, steer, background, eventPublication, logger, session, ...config } = options;
  const wiring: TestSessionWiring = { machine, store, events, tracing, responder, permission, capabilities, steer, background, eventPublication, logger };
  return new Runner<TContext>(testHarnessScope(wiring), {
    ...config,
    session: async (scope, ctx) => {
      wireTestSession(scope, wiring);
      const extra = session !== undefined ? await session(scope, ctx) : [];
      return [...(capabilities ?? []), ...extra];
    },
  });
}

export interface TestSessionOptions extends TestSessionWiring, SessionOpenOptions {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  /** Reuse an existing harness scope (e.g. a runner's) instead of building one from the bag. */
  readonly parent?: Scope<"harness" | "workspace">;
  readonly preloadedLog?: readonly AgentRecord[];
}

/** `Session.open(...)` for tests: the wiring bag becomes a session scope under a harness scope. */
export async function openTestSession(options: TestSessionOptions = {}): Promise<Session> {
  const { sessionId, signal, parent, capabilities, preloadedLog, ...wiring } = options;
  const scope = (parent ?? testHarnessScope(wiring)).child("session");
  if (sessionId !== undefined) scope.register(T.SessionId, sessionId);
  if (signal !== undefined) scope.register(T.HostSignal, signal, { owned: false });
  wireTestSession(scope, wiring);
  return Session.open(scope, {
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(preloadedLog !== undefined ? { preloadedLog } : {}),
  });
}

// ── capability-level helpers (a capability under test, without a Runner) ──────────────────

export interface TestCapabilityHandle {
  readonly ctx: ProvisionContext;
  /** The last provision's instance (what `cap.service` used to be). */
  readonly service: unknown;
  close(): Promise<void>;
}

/** A session scope wired from the bag, with the defaults `Session.open` would provide. */
export function testSessionScope(wiring: TestSessionWiring = {}): Scope<"session"> {
  const scope = testHarnessScope(wiring).child("session");
  wireTestSession(scope, wiring);
  scope.provide(T.SessionId, () => "s");
  scope.provide(T.Events, () => new ListenerSink());
  scope.provide(T.Steer, () => new SteerBus());
  scope.provide(T.SessionSignal, () => new AbortController().signal);
  if (!scope.hasLocal(T.Machine)) {
    const factory = scope.get(T.MachineFactory);
    if (factory !== undefined && typeof factory !== "function") scope.register(T.Machine, factory, { owned: false });
  }
  scope.provide(T.Machine, () => new NullMachine());
  scope.provide(T.SessionLog, (s) => () => readLog(s.get(T.Store) ?? s.get(T.StoreBackend)));
  return scope;
}

export function testProvisionContext(wiring: TestSessionWiring = {}): ProvisionContext {
  const scope = testSessionScope(wiring);
  return { scope, sessionId: scope.require(T.SessionId), signal: scope.require(T.SessionSignal) };
}

export function testRunContext(wiring: TestSessionWiring = {}): RunContext {
  const base = testProvisionContext(wiring);
  return {
    ...base,
    injection: new InjectionManager(),
    gates: { compaction: [] },
    controls: {
      abort: () => undefined,
      compact: () => Promise.reject(new Error("no compaction in a test run context")),
      getContextBreakdown: () => undefined,
      setModel: () => undefined,
      setThinking: () => undefined,
    },
  };
}

/** Run a capability's provisions on a fresh session scope — what `Session.open` does for it. */
export async function openCapability(cap: Capability, wiring: TestSessionWiring = {}): Promise<TestCapabilityHandle> {
  const ctx = testProvisionContext(wiring);
  let service: unknown;
  for (const provision of cap.provides ?? []) {
    service = await provision.create(ctx);
    ctx.scope.register(provision.token, service, provision.dispose !== undefined ? { dispose: provision.dispose as (i: unknown) => void | Promise<void> } : {});
  }
  return { ctx, service, close: () => ctx.scope.close() };
}
