/**
 * Scope-wiring helpers for tests and quick scripts (exported via `operon-agents-core/internal`).
 *
 * A test describes a session's objects as a flat options bag; these turn that bag into the
 * harness/session scopes the engine actually takes. Nothing here is a compatibility layer for
 * production code — hosts compose scopes through the harness hooks.
 */
import { Scope } from "./scope/scope.ts";
import { Tokens } from "./scope/tokens.ts";
import { Runner, type RunnerConfig } from "./agent/runner.ts";
import { Session, type SessionOpenOptions } from "./agent/session.ts";
import type { Environment, EnvironmentFactory } from "./tool/environment.ts";
import type { SessionStore, AgentRecord } from "./store/index.ts";
import { ListenerSink, type EventSink, type EventPublicationMode } from "./events/index.ts";
import type { TracingProcessor } from "./tracing/index.ts";
import type { Responder } from "./permission/types.ts";
import type { PermissionManagerOptions } from "./permission/manager.ts";
import type { Capability, ProvisionContext, RunContext } from "./capabilities/capability.ts";
import { assertDependencyTiers, resolveNeeds } from "./capabilities/needs.ts";
import type { Token } from "./scope/token.ts";
import { InjectionManager } from "./capabilities/injection.ts";
import { readLog } from "./capabilities/capability-state.ts";
import { SteerBus } from "./loop/steer.ts";
import type { BackgroundSpawner } from "./tool/background.ts";
import type { Logger } from "./logging/index.ts";
import { NullEnvironment } from "./tool/environment-null.ts";


export interface TestSessionWiring {
  readonly environment?: Environment | EnvironmentFactory;
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
  if (wiring.environment !== undefined) harness.register(Tokens.EnvironmentFactory, wiring.environment, { owned: false });
  if (wiring.tracing !== undefined) harness.register(Tokens.Tracing, wiring.tracing, { owned: false });
  if (wiring.logger !== undefined) harness.register(Tokens.Logger, wiring.logger, { owned: false });
  if (wiring.eventPublication !== undefined) harness.register(Tokens.EventPublication, wiring.eventPublication);
  return harness;
}

/** Register the session-tier parts of a wiring bag on a session scope (skipping what's set). */
export function wireTestSession(scope: Scope<"session">, wiring: TestSessionWiring): void {
  if (wiring.store !== undefined && !scope.hasLocal(Tokens.StoreBackend)) scope.register(Tokens.StoreBackend, wiring.store, { owned: false });
  if (wiring.events !== undefined && !scope.hasLocal(Tokens.Events)) scope.register(Tokens.Events, wiring.events, { owned: false });
  if (wiring.responder !== undefined && !scope.hasLocal(Tokens.Responder)) scope.register(Tokens.Responder, wiring.responder, { owned: false });
  if (wiring.permission !== undefined && !scope.hasLocal(Tokens.PermissionOptions)) scope.register(Tokens.PermissionOptions, wiring.permission);
  if (wiring.steer !== undefined && !scope.hasLocal(Tokens.Steer)) scope.register(Tokens.Steer, wiring.steer, { owned: false });
  if (wiring.background !== undefined && !scope.hasLocal(Tokens.BackgroundSpawner)) scope.register(Tokens.BackgroundSpawner, wiring.background, { owned: false });
}

/** `new Runner(...)` for tests: the wiring bag becomes a harness scope + a per-session hook. */
export function testRunner<TContext = unknown>(options: TestRunnerOptions<TContext> = {}): Runner<TContext> {
  const { environment, store, events, tracing, responder, permission, capabilities, steer, background, eventPublication, logger, session, ...config } = options;
  const wiring: TestSessionWiring = { environment, store, events, tracing, responder, permission, capabilities, steer, background, eventPublication, logger };
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
  wireTestSession(scope, wiring);
  return Session.open(scope, {
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(preloadedLog !== undefined ? { preloadedLog } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(wiring.store !== undefined ? { store: wiring.store } : {}),
  });
}

// ── capability-level helpers (a capability under test, without a Runner) ──────────────────

export interface TestCapabilityHandle {
  readonly ctx: ProvisionContext;
  /** The scope the capability was assembled in. The fixture holds it; `ctx` deliberately does not. */
  readonly scope: Scope<"session">;
  /** The last provision's instance (what `cap.service` used to be). */
  readonly service: unknown;
  close(): Promise<void>;
}

/** A session scope wired from the bag, with the defaults `Session.open` would provide. */
export function testSessionScope(wiring: TestSessionWiring = {}): Scope<"session"> {
  const scope = testHarnessScope(wiring).child("session");
  wireTestSession(scope, wiring);
  // No Session behind this scope, so nothing wraps the backend into `Tokens.Store` — the state a
  // capability under test expects to find. Point it at the backend directly.
  if (wiring.store !== undefined && !scope.hasLocal(Tokens.Store)) scope.register(Tokens.Store, wiring.store, { owned: false });
  scope.provide(Tokens.Events, () => new ListenerSink());
  scope.provide(Tokens.Steer, () => new SteerBus());
  scope.provide(Tokens.SessionSignal, () => new AbortController().signal);
  if (!scope.hasLocal(Tokens.Environment)) {
    const factory = scope.get(Tokens.EnvironmentFactory);
    if (factory !== undefined && typeof factory !== "function") scope.register(Tokens.Environment, factory, { owned: false });
  }
  scope.provide(Tokens.Environment, () => new NullEnvironment());
  scope.provide(Tokens.SessionLog, (s) => () => readLog(s.get(Tokens.Store) ?? s.get(Tokens.StoreBackend)));
  // A test scope has no Session behind it, so the controls are inert rather than absent: a
  // capability under test should find the field filled, as it would in a real session.
  scope.provide(Tokens.SessionControls, () => ({
    abort: () => undefined,
    compact: () => Promise.reject(new Error("no compaction in a test session scope")),
    getContextBreakdown: () => undefined,
    setModel: () => undefined,
    setThinking: () => undefined,
  }));
  return scope;
}

/** The session facts a provision gets, from an already-wired scope. */
export function testProvisionContextOn(scope: Scope<"session">): ProvisionContext {
  return { sessionId: "s", signal: scope.require(Tokens.SessionSignal) };
}

export function testProvisionContext(wiring: TestSessionWiring = {}): ProvisionContext {
  return testProvisionContextOn(testSessionScope(wiring));
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

/** Run one capability's provisions on a fresh session scope — what `Session.open` does for it. */
export async function provisionCapability(cap: Capability, wiring: TestSessionWiring = {}): Promise<TestCapabilityHandle> {
  const scope = testSessionScope(wiring);
  const ctx = testProvisionContextOn(scope);
  let service: unknown;
  for (const provision of cap.provides ?? []) {
    // Same order as `Session.open`: declarations checked, then dependencies resolved from the
    // scope that owns the service, so a capability under test fails here rather than inside
    // `create`. Workspace provisions resolve against this scope's chain, as they would live.
    assertDependencyTiers(cap.name, provision.token, provision.needs);
    const owner = scope.scopeOf(provision.token.scope) ?? scope;
    service = await provision.create(resolveNeeds(owner, provision.needs, cap.name), ctx as never);
    scope.register(provision.token as Token<unknown, "session">, service, provision.dispose !== undefined ? { dispose: provision.dispose as (i: unknown) => void | Promise<void> } : {});
  }
  return { ctx, scope, service, close: () => scope.close() };
}
