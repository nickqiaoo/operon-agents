import { testRunner, openTestSession } from "./faux.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { existsSync } from "node:fs";
import {
  ServiceUnavailableError,
  T,
  token,
  defineModel,
  defineAgent,
  Runner,
  Session,
  LocalMachine,
  ListenerSink,
  writeTool,
  goalCapability,
  GoalStore,
  backgroundCapability,
  BackgroundManager,
  MemoryStore,
  type AgentEvent,
  type Capability,
  type MachineFactory,
  type ChatModel,
  type LlmRequest,
  type Logger,
  type Span,
  type Trace,
  type TracingProcessor,
} from "../index.ts";
import { setSessionCloseTimeoutsForTest } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface ProbeStats {
  openSession: number;
  closeSession: number;
  start: number;
  stop: number;
  activeRuns: number;
  maxConcurrentRuns: number;
}

const PROBE = token<object>("probe", "session");

function probeCapability(opts: { failOpen?: boolean } = {}): { capability: Capability; stats: ProbeStats } {
  const stats: ProbeStats = { openSession: 0, closeSession: 0, start: 0, stop: 0, activeRuns: 0, maxConcurrentRuns: 0 };
  const capability: Capability = {
    name: "probe",
    provides: [
      {
        token: PROBE,
        create: async () => {
          stats.openSession += 1;
          if (opts.failOpen) throw new Error("probe provision boom");
          return {};
        },
        dispose: async () => {
          stats.closeSession += 1;
        },
      },
    ],
    start: async () => {
      stats.start += 1;
      stats.activeRuns += 1;
      stats.maxConcurrentRuns = Math.max(stats.maxConcurrentRuns, stats.activeRuns);
      await tick(); // widen the window so an unlocked second run could overlap
    },
    stop: async () => {
      stats.stop += 1;
      stats.activeRuns -= 1;
    },
  };
  return { capability, stats };
}

function fauxModel(...texts: string[]) {
  const faux = registerFauxProvider();
  faux.setResponses(texts.map((t) => fauxAssistantMessage(t, { stopReason: "stop" })));
  return { faux, model: faux.getChatModel()! };
}

interface TracingStats {
  traceStart: number;
  traceEnd: number;
  spanStart: number;
  spanEnd: number;
  forceFlush: number;
  shutdown: number;
}

function recordingTracingProcessor(): { processor: TracingProcessor; stats: TracingStats } {
  const stats: TracingStats = { traceStart: 0, traceEnd: 0, spanStart: 0, spanEnd: 0, forceFlush: 0, shutdown: 0 };
  const processor: TracingProcessor = {
    onTraceStart(_trace: Trace): void {
      stats.traceStart += 1;
    },
    onTraceEnd(_trace: Trace): void {
      stats.traceEnd += 1;
    },
    onSpanStart(_span: Span): void {
      stats.spanStart += 1;
    },
    onSpanEnd(_span: Span): void {
      stats.spanEnd += 1;
    },
    async forceFlush(): Promise<void> {
      stats.forceFlush += 1;
    },
    async shutdown(): Promise<void> {
      stats.shutdown += 1;
    },
  };
  return { processor, stats };
}

function recordingModel(base: ChatModel): { model: ChatModel; lastReq: () => LlmRequest | undefined } {
  let last: LlmRequest | undefined;
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    last = req;
    return stream(req, call);
  };
  return { model, lastReq: () => last };
}

// 1. Session-tier lifecycle survives across runs; per-run lifecycle fires each run.
async function testCrossRunSurvival(machine: LocalMachine): Promise<void> {
  const { faux, model } = fauxModel("one", "two");
  const { capability, stats } = probeCapability();
  const agent = defineAgent({ name: "a", model, instructions: "x" });
  const session = await openTestSession({ machine, capabilities: [capability] });
  const runner = testRunner({ machine });

  check("cross-run: openSession once at open", stats.openSession === 1 && stats.closeSession === 0);

  await runner.run(agent, "run 1", { session });
  await runner.run(agent, "run 2", { session });
  faux.unregister();

  check("cross-run: openSession still once after 2 runs", stats.openSession === 1);
  check("cross-run: per-run start fired twice", stats.start === 2 && stats.stop === 2);
  check("cross-run: closeSession not called until session.close", stats.closeSession === 0);

  await session.close();
  check("cross-run: closeSession once at close", stats.closeSession === 1);
}

// 2. Single active run — two concurrent runs on one session never overlap (Invariant 2).
async function testSingleActiveRun(machine: LocalMachine): Promise<void> {
  const { faux, model } = fauxModel("a", "b");
  const { capability, stats } = probeCapability();
  const agent = defineAgent({ name: "a", model, instructions: "x" });
  const session = await openTestSession({ machine, capabilities: [capability] });
  const runner = testRunner({ machine });

  const [r1, r2] = await Promise.all([
    runner.run(agent, "concurrent 1", { session }),
    runner.run(agent, "concurrent 2", { session }),
  ]);
  faux.unregister();
  await session.close();

  check("single-run: both runs completed", r1.status === "completed" && r2.status === "completed");
  check("single-run: never more than one active run", stats.maxConcurrentRuns === 1);
  check("single-run: both runs actually ran", stats.start === 2);
}

async function testOneShotLifecycle(machine: LocalMachine): Promise<void> {
  const { faux, model } = fauxModel("done");
  const { capability, stats } = probeCapability();
  const agent = defineAgent({ name: "a", model, instructions: "x" });
  // Capabilities passed to the Runner → folded into the one-shot Session it builds.
  const runner = testRunner({ machine, capabilities: [capability] });

  const result = await runner.run(agent, "one-shot");
  faux.unregister();

  check("one-shot: run completed", result.status === "completed");
  check("one-shot: openSession + closeSession exactly once", stats.openSession === 1 && stats.closeSession === 1);
  check("one-shot: per-run start/stop once", stats.start === 1 && stats.stop === 1);
}

async function testTracingLifecycle(machine: LocalMachine): Promise<void> {
  // Direct Session.open wiring: the session event bus drives the tracing bridge.
  {
    const { processor, stats } = recordingTracingProcessor();
    const session = await openTestSession({ machine, tracing: processor });
    await session.events.emit({ type: "agent.started", agent: "main", address: "main", sessionId: session.id });
    await session.events.emit({ type: "agent.ended", agent: "main", address: "main", sessionId: session.id });
    await session.close();

    check("tracing: session events drive trace start/end", stats.traceStart === 1 && stats.traceEnd === 1);
    check("tracing: session events drive span start/end", stats.spanStart === 1 && stats.spanEnd === 1);
    check("tracing: session close flushes but does not shutdown", stats.forceFlush === 1 && stats.shutdown === 0);
  }

  // Runner one-shot wiring: tracing passed to Runner is folded into the Session it opens.
  {
    const { faux, model } = fauxModel("done");
    const { processor, stats } = recordingTracingProcessor();
    const agent = defineAgent({ name: "a", model, instructions: "x" });
    const result = await testRunner({ machine, tracing: processor }).run(agent, "one-shot tracing");
    faux.unregister();

    check("tracing: runner one-shot run completes", result.status === "completed");
    check("tracing: runner config auto-wires spans", stats.traceStart === 1 && stats.spanStart > 0 && stats.spanEnd > 0);
    check("tracing: runner-owned one-shot session flushes", stats.forceFlush === 1);
  }
}

// 4. Session-tier fault isolation: openSession throws → capability absent + diagnostic.
async function testSessionFaultIsolation(machine: LocalMachine): Promise<void> {
  const { faux, model } = fauxModel("survived");
  const { capability, stats } = probeCapability({ failOpen: true });
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const events: AgentEvent[] = [];
  const bus = new ListenerSink();
  bus.subscribe((e) => void events.push(e));

  const session = await openTestSession({ machine, events: bus, capabilities: [capability] });
  check("fault: session still opens despite a broken capability", session.capabilities.length === 0);

  const runner = testRunner({ machine });
  const result = await runner.run(agent, "go", { session });
  faux.unregister();
  await session.close();

  const diag = events.find((e) => e.type === "error" && e.message.includes("probe"));
  check("fault: run completes despite broken capability", result.status === "completed");
  check("fault: broken capability never assembled per-run (start=0)", stats.start === 0);
  check("fault: diagnostic surfaced to the bus", diag !== undefined);
}

async function testSessionHandles(machine: LocalMachine): Promise<void> {
  const goal = new GoalStore();
  const bg = new BackgroundManager();
  const session = await openTestSession({
    machine,
    capabilities: [goalCapability(goal), backgroundCapability(bg)],
  });

  check("handles: session.get(T.Goal) returns the GoalStore", session.get(T.Goal) === goal);
  check("handles: session.background unifies the BackgroundManager", session.background === bg);
  check("handles: session.require(T.Goal) also resolves", session.require(T.Goal) === goal);
  check("handles: unknown service is undefined", session.get(token("nope", "session")) === undefined);

  await session.close();
}

// 6. A machine factory is a FACTORY, not a lifecycle owner: a session opens a machine,
// operates it, and leaves its disposal to whoever created it. The regression this locks is
// that closing one session must not disturb a machine other sessions still hold, and that
// nothing about the machine leaks into the session's durable state (which a fork copies).
async function testMachineFactoryIsFactoryOnly(machine: LocalMachine): Promise<void> {
  const store = new MemoryStore();
  let open = 0;
  let sawStoreField = false;

  const factory: MachineFactory = (ctx) => {
    open += 1;
    sawStoreField = "store" in (ctx as Record<string, unknown>);
    return machine;
  };

  const session = await openTestSession({ machine: factory, store });
  check("machine-factory: opened once", open === 1);
  check("machine-factory: factory returns the Machine itself", session.machine === machine);
  check("machine-factory: open context carries no store (no machine state to persist)", !sawStoreField);

  await session.close();

  // Nothing machine-shaped may sit in the KV that `SessionRepository.fork` copies wholesale —
  // that is exactly how a fork used to end up sharing one sandbox with its source.
  const keys = await store.listStateKeys?.();
  check("machine-factory: no machine state persisted on close", !(keys ?? []).includes("machine"));
  // The machine survives its session: still usable for the next one.
  check("machine-factory: machine still usable after session.close", machine.getcwd().length > 0);

  // A plain Machine is the common case and must take the same path.
  const direct = await openTestSession({ machine, store: new MemoryStore() });
  check("machine-factory: a plain Machine passes straight through", direct.machine === machine);
  await direct.close();
}

// resolveExposedPort is an OPERATION on the machine, so it forwards to the backend and
// degrades to undefined on backends that cannot expose a port (local, ssh, null).
async function testExposedPortForwarding(machine: LocalMachine): Promise<void> {
  const withPort = Object.create(machine) as LocalMachine & { exposedPortUrl(p: number): Promise<string | undefined> };
  withPort.exposedPortUrl = async (p: number) => `https://sbx-${String(p)}.example.dev`;

  const exposing = await openTestSession({ machine: withPort });
  check("exposed-port: forwarded to the machine", (await exposing.resolveExposedPort(3000)) === "https://sbx-3000.example.dev");
  await exposing.close();

  const plain = await openTestSession({ machine });
  check("exposed-port: undefined when the backend has no mapping", (await plain.resolveExposedPort(3000)) === undefined);
  await plain.close();
}

// 7. Close hang isolation: a hung store.flush / tracing.forceFlush / machine saveState/close
// must not wedge session.close() — every exit times out and surfaces a diagnostic.
async function testCloseHangIsolation(machine: LocalMachine): Promise<void> {
  setSessionCloseTimeoutsForTest({ close: 100, storeFlush: 150 });
  try {
    const never = new Promise<never>(() => {});
    class HangingFlushStore extends MemoryStore {
      flush(): Promise<void> {
        return never;
      }
    }
    const { processor } = recordingTracingProcessor();
    const hangingTracing: TracingProcessor = { ...processor, forceFlush: () => never };
    const warnings: string[] = [];
    const logger: Logger = {
      log(level, message, fields) {
        if (level === "warn") warnings.push(`${message} ${JSON.stringify(fields ?? {})}`);
      },
    };

    const session = await openTestSession({ machine, store: new HangingFlushStore(), tracing: hangingTracing, logger });
    const t0 = Date.now();
    await session.close();
    const elapsed = Date.now() - t0;

    check("close-hang: close() returns within the deadlines despite hung flush/save/close", elapsed < 2_000);
    check(
      "close-hang: tracing and store timeouts surface as warnings",
      warnings.some((w) => w.includes("forceFlush") && w.includes("timed out")) && warnings.some((w) => w.includes("store flush") && w.includes("timed out")),
    );
  } finally {
    setSessionCloseTimeoutsForTest({ close: 5_000, storeFlush: 15_000 });
  }
}

async function testRuntimeModelAndThinking(machine: LocalMachine): Promise<void> {
  {
    const { faux, model } = fauxModel("ignored");
    const agentModel = recordingModel(model);
    const overrideModel = recordingModel(model);
    const agent = defineAgent({ name: "a", model: agentModel.model, instructions: "x" });
    const session = await openTestSession({ machine });
    session.setModel(overrideModel.model);
    await testRunner({ machine }).run(agent, "go", { session });
    faux.unregister();
    await session.close();
    check("setModel: override model was used", overrideModel.lastReq() !== undefined);
    check("setModel: agent's own model was bypassed", agentModel.lastReq() === undefined);
  }
  // setThinking: the level flows into the LLM request params.
  {
    const { faux, model } = fauxModel("ok");
    const rec = recordingModel(model);
    const agent = defineAgent({ name: "a", model: rec.model, instructions: "x" });
    const session = await openTestSession({ machine });
    session.setThinking("high");
    await testRunner({ machine }).run(agent, "go", { session });
    faux.unregister();
    await session.close();
    check("setThinking: thinking reached request.params", rec.lastReq()?.params?.thinking === "high");
  }
}

async function testRuntimePermissionMode(machine: LocalMachine): Promise<void> {
  const file = `${machine.getcwd()}/mode.txt`;
  const faux = registerFauxProvider();
  // run1 (manual): one tool call → interrupt. run2 (yolo): tool call → runs → stop.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "hi\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "hi\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("wrote it", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "w", model, instructions: "x", tools: [writeTool] });
  // No responder → manual mode bubbles a durable interrupt instead of running the tool.
  const session = await openTestSession({ machine, permission: { mode: "manual" } });
  const runner = testRunner({ machine });

  const first = await runner.run(agent, "write it", { session });
  check("setPermissionMode: manual run interrupts on the asking tool", first.status === "interrupted");

  // Awaitable persistence: the returned promise resolves once the mode is journaled
  // (in-memory effect is immediate either way; storeless sessions resolve right away).
  await session.setPermissionMode("yolo");
  const second = await runner.run(agent, "write it now", { session });
  faux.unregister();
  await session.close();

  check("setPermissionMode: yolo run completes", second.status === "completed");
  check("setPermissionMode: file actually written under yolo", existsSync(file));
}

async function testSessionIdConflict(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("hi", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "c", model, instructions: "x" });
  const session = await openTestSession({ machine });
  const runner = testRunner({ machine });

  let conflict: unknown;
  try {
    await runner.run(agent, "go", { session, sessionId: "some-other-id" });
  } catch (e) {
    conflict = e;
  }
  check("session+sessionId: contradictory pair throws", conflict instanceof Error && conflict.message.includes("disagree"));

  // A MATCHING sessionId is redundant but harmless.
  const ok = await runner.run(agent, "go", { session, sessionId: session.id });
  check("session+sessionId: matching pair is accepted", ok.status === "completed");

  // REQUIRE-tier capability methods throw the TYPED error; the probe getter stays undefined.
  let missing: unknown;
  try {
    await session.getPlan();
  } catch (e) {
    missing = e;
  }
  check("capability-missing: probe getter returns undefined", session.get(T.Plan) === undefined);
  check(
    "capability-missing: require method throws ServiceUnavailableError with the service name",
    missing instanceof ServiceUnavailableError && missing.serviceName === "plan",
  );
  faux.unregister();
  await session.close();
}

/** A runner-owned session whose hook or open fails must not leave its scope (and what the hook
 *  already registered) hanging off the runner's scope. */
async function testOwnedScopeClosedOnOpenFailure(): Promise<void> {
  const { faux, model } = fauxModel("never");
  const Probe = token<{ close(): void }>("session-e2e-open-fail-probe", "session");
  let disposed = 0;
  let hookScope: { readonly state: string } | undefined;
  const harnessScope = new (await import("../index.ts")).Scope("harness");
  const runner = new Runner(harnessScope, {
    session: (scope) => {
      hookScope = scope;
      scope.register(Probe, { close: () => void (disposed += 1) });
      throw new Error("session hook boom");
    },
  });
  const agent = defineAgent({ name: "a", model, instructions: "x" });
  let error: unknown;
  await runner.run(agent, "hi").catch((e) => { error = e; });
  check("owned open failure: the run rejects with the hook's error", error instanceof Error && error.message === "session hook boom");
  check("owned open failure: the runner closed the scope it created", hookScope?.state === "closed");
  check("owned open failure: what the hook registered was disposed", disposed === 1);
  faux.unregister();
  await harnessScope.close();
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-session-e2e-"));
  const machine = new LocalMachine(dir);
  try {
    await testOwnedScopeClosedOnOpenFailure();
    await testCrossRunSurvival(machine);
    await testSingleActiveRun(machine);
    await testOneShotLifecycle(machine);
    await testTracingLifecycle(machine);
    await testSessionFaultIsolation(machine);
    await testSessionHandles(machine);
    await testMachineFactoryIsFactoryOnly(machine);
    await testExposedPortForwarding(machine);
    await testCloseHangIsolation(machine);
    await testSessionIdConflict(machine);
    await testRuntimeModelAndThinking(machine);
    await testRuntimePermissionMode(machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SESSION E2E PASS — cross-run survival + single-active-run + one-shot lifecycle + tracing + fault isolation + machine factory + §8.6 handles + runtime setters");
  } else {
    console.log("❌ SESSION E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ SESSION E2E ERROR:", error);
  process.exit(1);
});
