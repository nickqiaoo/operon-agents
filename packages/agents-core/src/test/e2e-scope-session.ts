/**
 * Session over a Scope: what the opener registers wins, `open` fills the gaps, capability
 * provisions land in the session scope and are disposed in reverse, and the fallbacks
 * (NullMachine, in-memory workflow manager, env logger) apply only when nothing else does.
 */
import { openTestSession, testHarnessScope, wireTestSession } from "./faux.ts";
import {
  Scope,
  Session,
  ServiceUnavailableError,
  T,
  token,
  LocalMachine,
  NullMachine,
  MemoryStore,
  goalCapability,
  GoalStore,
  workflowCapability,
  WorkflowManager,
  type Capability,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function testBareSession(): Promise<void> {
  const session = await Session.open(new Scope("session"));
  check("bare: a parentless session scope opens", session.id.length > 0);
  check("bare: no machine registered → NullMachine", session.machine instanceof NullMachine);
  check("bare: no harness above → T.Logger is absent (env fallback in the session)", session.get(T.Logger) === undefined);
  check("bare: T.Store is absent for a storeless session", session.get(T.Store) === undefined && session.store === undefined);
  check("bare: the session registered its own signal + controls", session.get(T.SessionSignal) === session.signal && session.get(T.SessionControls) !== undefined);
  check("bare: the workflow fallback is present without the capability", session.workflow instanceof WorkflowManager);
  const again = session.workflow;
  check("bare: the fallback is one instance per session", again === session.workflow);
  await session.close();
  check("bare: close() closes the scope the session owns", session.scope.closed);
}

async function testMachinePrecedence(): Promise<void> {
  const harnessMachine = new LocalMachine(process.cwd());
  const sessionMachine = new LocalMachine(process.cwd());
  const factoryMachine = new LocalMachine(process.cwd());
  const harness = new Scope("harness");
  harness.register(T.MachineFactory, harnessMachine, { owned: false });

  const a = await Session.open(harness.child("session"));
  check("machine: the harness-level factory applies when the opener gave none", a.machine === harnessMachine);
  await a.close();

  const bScope = harness.child("session");
  bScope.register(T.Machine, sessionMachine, { owned: false });
  const b = await Session.open(bScope);
  check("machine: the opener's registration wins over the harness factory", b.machine === sessionMachine);
  await b.close();

  const cScope = harness.child("session");
  let factoryCalls = 0;
  cScope.register(T.SessionMachineFactory, async ({ sessionId }) => {
    factoryCalls += 1;
    return sessionId.length > 0 ? factoryMachine : harnessMachine;
  });
  const c = await Session.open(cScope);
  check("machine: a per-session factory is resolved with the session id and wins over the harness one", c.machine === factoryMachine && factoryCalls === 1);
  await c.close();
  await harness.close();
}

async function testProvisionsAndDisposeOrder(): Promise<void> {
  const order: string[] = [];
  const First = token<{ close(): void }>("scope-session-first", "session");
  const Second = token<{ close(): void }>("scope-session-second", "session");
  const first: Capability = { name: "first", provides: [{ token: First, create: () => ({ close: () => order.push("first") }) }] };
  const second: Capability = {
    name: "second",
    provides: [{ token: Second, create: (ctx) => { check("provision: a later capability sees an earlier one's service", ctx.scope.has(First)); return { close: () => order.push("second") }; } }],
  };
  const goal = new GoalStore();
  const session = await openTestSession({ capabilities: [first, second, goalCapability(goal)] });
  check("provision: services land in the session scope under their tokens", session.get(First) !== undefined && session.get(T.Goal) === goal);
  check("provision: require() resolves the same object", session.require(T.Goal) === goal);
  await session.close();
  check("provision: disposed in reverse registration order", order.join(",") === "second,first");
}

async function testProvisionFaultIsolation(): Promise<void> {
  const Broken = token<object>("scope-session-broken", "session");
  const broken: Capability = { name: "broken", provides: [{ token: Broken, create: async () => { throw new Error("kapow"); } }] };
  const session = await openTestSession({ capabilities: [broken, goalCapability()] });
  check("fault: the broken capability is absent, the rest open", session.capabilities.map((c) => c.name).join(",") === "goal");
  check("fault: nothing registered for the broken token", session.get(Broken) === undefined);
  const diagnostics = session.drainDiagnostics();
  check("fault: a start-phase diagnostic names the capability", diagnostics.some((d) => d.capability === "broken" && d.phase === "start" && d.message.includes("kapow")));
  await session.close();
}

async function testWrongTierProvision(): Promise<void> {
  const Workspaceish = token<object>("scope-session-workspaceish", "workspace");
  const cap: Capability = { name: "wrong-tier", provides: [{ token: Workspaceish, create: () => ({}) }] };
  const session = await openTestSession({ capabilities: [cap] });
  const diagnostics = session.drainDiagnostics();
  check("tier: a workspace-scoped provision cannot land in a session (capability absent + diagnostic)", session.capabilities.length === 0 && diagnostics.some((d) => d.message.includes("workspace-scoped")));
  await session.close();
}

async function testRequireErrors(): Promise<void> {
  const session = await openTestSession({ capabilities: [workflowCapability()] });
  let missing: unknown;
  try {
    await session.getPlan();
  } catch (error) {
    missing = error;
  }
  check("require: a convenience method over an absent capability throws ServiceUnavailableError('plan')", missing instanceof ServiceUnavailableError && missing.serviceName === "plan");
  check("require: the probe getter stays undefined", session.get(T.Plan) === undefined);
  await session.close();
}

async function testStoreIsThePublishingWrapper(): Promise<void> {
  const backend = new MemoryStore();
  const scope = testHarnessScope({}).child("session");
  wireTestSession(scope, { store: backend });
  const session = await Session.open(scope);
  check("store: the opener registers the backend, the session publishes T.Store on top of it", session.get(T.StoreBackend) === backend && session.get(T.Store) === session.store && session.store !== backend);
  await session.close();
}

async function main(): Promise<void> {
  await testBareSession();
  await testMachinePrecedence();
  await testProvisionsAndDisposeOrder();
  await testProvisionFaultIsolation();
  await testWrongTierProvision();
  await testRequireErrors();
  await testStoreIsThePublishingWrapper();
  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SCOPE-SESSION E2E PASS — bare open + machine precedence + provisions + fault isolation + tier check + store wrapper");
  } else {
    console.log("❌ SCOPE-SESSION E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
