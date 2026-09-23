/**
 * Session-wiring helpers for tests and quick scripts (exported via `operon-agents-core/internal`).
 *
 * A test describes a session's objects as a flat options bag; these turn that bag into the
 * `Session.open` options the engine actually takes. Nothing here is a compatibility layer for
 * production code — hosts compose sessions through the harness hooks.
 */
import { Runner, type RunnerConfig } from "./agent/runner.ts";
import { Session, type SessionOpenOptions } from "./agent/session.ts";
import type { Environment, EnvironmentFactory } from "./tool/environment.ts";
import { DEFAULT_ADDRESS, type SessionStore, type AgentRecord } from "./store/index.ts";
import { ListenerSink, type EventSink, type EventPublicationMode } from "./events/index.ts";
import type { TracingProcessor } from "./tracing/index.ts";
import type { Responder } from "./permission/types.ts";
import type { PermissionManagerOptions } from "./permission/manager.ts";
import type { Capability, SessionContext, RunContext } from "./capabilities/capability.ts";
import { InjectionManager } from "./capabilities/injection.ts";
import { readLog } from "./capabilities/capability-state.ts";
import { CapabilityData } from "./capabilities/capability-data.ts";
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

/** A wiring bag as `Session.open` wants it. The bag's names are the older, shorter ones. */
export function sessionOptionsFrom(wiring: TestSessionWiring): SessionOpenOptions {
  return {
    ...(wiring.environment !== undefined ? { environment: wiring.environment } : {}),
    ...(wiring.store !== undefined ? { store: wiring.store } : {}),
    ...(wiring.events !== undefined ? { events: wiring.events } : {}),
    ...(wiring.tracing !== undefined ? { tracing: wiring.tracing } : {}),
    ...(wiring.responder !== undefined ? { responder: wiring.responder } : {}),
    ...(wiring.permission !== undefined ? { permissionOptions: wiring.permission } : {}),
    ...(wiring.steer !== undefined ? { steer: wiring.steer } : {}),
    ...(wiring.background !== undefined ? { spawner: wiring.background } : {}),
    ...(wiring.eventPublication !== undefined ? { eventPublication: wiring.eventPublication } : {}),
    ...(wiring.logger !== undefined ? { logger: wiring.logger } : {}),
    ...(wiring.capabilities !== undefined ? { capabilities: wiring.capabilities } : {}),
  };
}

/** `new Runner(...)` for tests: the wiring bag becomes the per-session options hook. */
export function testRunner<TContext = unknown>(options: TestRunnerOptions<TContext> = {}): Runner<TContext> {
  const { environment, store, events, tracing, responder, permission, capabilities, steer, background, eventPublication, logger, session, ...config } = options;
  const wiring: TestSessionWiring = { environment, store, events, tracing, responder, permission, capabilities, steer, background, eventPublication, logger };
  return new Runner<TContext>({
    ...config,
    session: async (ctx) => {
      const extra = session !== undefined ? await session(ctx) : {};
      return {
        ...sessionOptionsFrom(wiring),
        ...extra,
        capabilities: [...(capabilities ?? []), ...(extra.capabilities ?? [])],
      };
    },
  });
}

export interface TestSessionOptions extends TestSessionWiring, SessionOpenOptions {
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly preloadedLog?: readonly AgentRecord[];
}

/** `Session.open(...)` for tests, from a wiring bag. */
export async function openTestSession(options: TestSessionOptions = {}): Promise<Session> {
  const { sessionId, signal, capabilities, preloadedLog, ...wiring } = options;
  return Session.open({
    ...sessionOptionsFrom(wiring),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(preloadedLog !== undefined ? { preloadedLog } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
}

// ── capability-level helpers (a capability under test, without a Runner) ──────────────────

export interface TestCapabilityHandle {
  readonly ctx: SessionContext;
  /** What the capability published (`cap.service`). */
  readonly service: unknown;
  close(): Promise<void>;
}

/** The session context a capability's `openSession` gets, built from a wiring bag. */
export function testSessionContext(wiring: TestSessionWiring = {}): SessionContext {
  const store = wiring.store;
  const environment = wiring.environment !== undefined && typeof wiring.environment !== "function" ? wiring.environment : new NullEnvironment();
  return {
    sessionId: "s",
    environment,
    events: wiring.events ?? new ListenerSink(),
    signal: new AbortController().signal,
    steer: wiring.steer ?? new SteerBus(),
    logRecords: () => readLog(store),
    ...(store !== undefined ? { store } : {}),
    // The same partitioned view a real session hands a capability, owned by "test".
    ...capabilityDataView(store),
    ...(wiring.logger !== undefined ? { logger: wiring.logger } : {}),
    // No Session behind this context, so the controls are inert rather than absent: a capability
    // under test should find the field filled, as it would in a real session.
    controls: {
      abort: () => undefined,
      compact: () => Promise.reject(new Error("no compaction in a test session context")),
      getContextBreakdown: () => undefined,
      setModel: () => undefined,
      setThinking: () => undefined,
    },
  };
}

function capabilityDataView(store: SessionStore | undefined): Pick<SessionContext, "state" | "records" | "record"> {
  const data = new CapabilityData({
    ...(store !== undefined ? { store } : {}),
    readLog: () => readLog(store),
    append: (body) => {
      void store?.appendRecord({ time: Date.now(), address: DEFAULT_ADDRESS, ...body } as AgentRecord);
    },
  });
  return { state: data.stateFor("test"), records: data.recordsFor("test"), record: data.recorderFor("test") };
}

/** @deprecated The provision context is now the whole {@link SessionContext}. */
export const testProvisionContext = testSessionContext;

export function testRunContext(wiring: TestSessionWiring = {}): RunContext {
  const base = testSessionContext(wiring);
  return {
    sessionId: base.sessionId,
    signal: base.signal,
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

/** Open one capability against a fresh session context — what `Session.open` does for it. */
export async function provisionCapability(cap: Capability, wiring: TestSessionWiring = {}): Promise<TestCapabilityHandle> {
  const ctx = testSessionContext(wiring);
  await cap.openSession?.(ctx);
  return { ctx, service: cap.service, close: async () => await cap.closeSession?.() };
}
