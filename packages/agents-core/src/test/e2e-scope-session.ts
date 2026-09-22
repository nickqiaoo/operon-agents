/**
 * Session over a Scope: what the opener registers wins, `open` fills the gaps, capability
 * provisions land in the session scope and are disposed in reverse, and the fallbacks
 * (NullEnvironment, in-memory workflow manager, env logger) apply only when nothing else does.
 */
import { openTestSession, testHarnessScope, wireTestSession } from "./faux.ts";
import {
  Scope,
  Session,
  ServiceUnavailableError,
  Tokens,
  token,
  LocalEnvironment,
  NullEnvironment,
  MemoryStore,
  goalCapability,
  GoalStore,
  workflowCapability,
  WorkflowManager,
  provision,
  optional,
  type Capability,
  type Dependency,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function testBareSession(): Promise<void> {
  const session = await Session.open(new Scope("session"));
  check("bare: a parentless session scope opens", session.id.length > 0);
  check("bare: no environment registered → NullEnvironment", session.environment instanceof NullEnvironment);
  check("bare: no harness above → Tokens.Logger is absent (env fallback in the session)", session.get(Tokens.Logger) === undefined);
  check("bare: Tokens.Store is absent for a storeless session", session.get(Tokens.Store) === undefined && session.store === undefined);
  check("bare: the session registered its own signal + controls", session.get(Tokens.SessionSignal) === session.signal && session.get(Tokens.SessionControls) !== undefined);
  check("bare: the workflow fallback is present without the capability", session.workflow instanceof WorkflowManager);
  const again = session.workflow;
  check("bare: the fallback is one instance per session", again === session.workflow);
  await session.close();
  check("bare: close() closes the scope the session owns", session.scope.closed);
}

async function testEnvironmentPrecedence(): Promise<void> {
  const harnessEnvironment = new LocalEnvironment(process.cwd());
  const sessionEnvironment = new LocalEnvironment(process.cwd());
  const factoryEnvironment = new LocalEnvironment(process.cwd());
  const harness = new Scope("harness");
  harness.register(Tokens.EnvironmentFactory, harnessEnvironment, { owned: false });

  const a = await Session.open(harness.child("session"));
  check("environment: the harness-level factory applies when the opener gave none", a.environment === harnessEnvironment);
  await a.close();

  const bScope = harness.child("session");
  bScope.register(Tokens.Environment, sessionEnvironment, { owned: false });
  const b = await Session.open(bScope);
  check("environment: the opener's registration wins over the harness factory", b.environment === sessionEnvironment);
  await b.close();

  const cScope = harness.child("session");
  let factoryCalls = 0;
  cScope.register(Tokens.SessionEnvironmentFactory, async ({ sessionId }) => {
    factoryCalls += 1;
    return sessionId.length > 0 ? factoryEnvironment : harnessEnvironment;
  });
  const c = await Session.open(cScope);
  check("environment: a per-session factory is resolved with the session id and wins over the harness one", c.environment === factoryEnvironment && factoryCalls === 1);
  await c.close();
  await harness.close();
}

async function testProvisionsAndDisposeOrder(): Promise<void> {
  const order: string[] = [];
  const First = token<{ close(): void }>("scope-session-first", "session");
  const Second = token<{ close(): void }>("scope-session-second", "session");
  let firstInstance: { close(): void } | undefined;
  const first: Capability = { name: "first", provides: [{ token: First, create: () => (firstInstance = { close: () => order.push("first") }) }] };
  const second: Capability = {
    name: "second",
    provides: [
      provision({
        token: Second,
        needs: { earlier: First },
        create: ({ earlier }) => {
          check("provision: a later capability DECLARES an earlier one's service and is handed it", earlier === firstInstance);
          return { close: () => order.push("second") };
        },
      }),
    ],
  };
  const goal = new GoalStore();
  const session = await openTestSession({ capabilities: [first, second, goalCapability(goal)] });
  check("provision: services land in the session scope under their tokens", session.get(First) !== undefined && session.get(Tokens.Goal) === goal);
  check("provision: require() resolves the same object", session.require(Tokens.Goal) === goal);
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
    await session.plan.data();
  } catch (error) {
    missing = error;
  }
  check("require: a convenience method over an absent capability throws ServiceUnavailableError('plan')", missing instanceof ServiceUnavailableError && missing.serviceName === "plan");
  check("require: the probe getter stays undefined", session.get(Tokens.Plan) === undefined);
  await session.close();
}

/**
 * `needs` is a contract in three directions, and each one is checked here: `create` is handed
 * exactly what it declared, an `optional` dependency arrives as `undefined` rather than as a
 * throw, and a REQUIRED one that nobody registered takes the capability out of the session with
 * a diagnostic that names the field — at open, not at first use.
 */
async function testDeclaredDependencies(): Promise<void> {
  const Probe = token<object>("scope-session-needs-probe", "session");
  let handed: Record<string, unknown> | undefined;
  const probe = (needs: Record<string, Dependency>): Capability => ({
    name: "probe",
    provides: [provision({ token: Probe, needs, create: (deps) => { handed = deps as Record<string, unknown>; return {}; } })],
  });

  const stored = await openTestSession({
    capabilities: [probe({ environment: Tokens.Environment, events: Tokens.Events, store: optional(Tokens.Store) })],
    store: new MemoryStore(),
  });
  check("needs: `create` is handed one field per declared dependency, and nothing else", handed !== undefined && Object.keys(handed).sort().join(",") === "environment,events,store");
  check("needs: a required dependency arrives resolved", handed?.environment === stored.environment);
  check("needs: an optional one arrives filled when it is there", handed?.store !== undefined);
  await stored.close();

  handed = undefined;
  const storeless = await openTestSession({ capabilities: [probe({ store: optional(Tokens.Store) })] });
  check("needs: an optional dependency with nobody to fill it is `undefined`, not a throw", handed !== undefined && "store" in handed && handed.store === undefined);
  check("needs: the capability opened anyway", storeless.get(Probe) !== undefined);
  await storeless.close();

  // The whole point of resolving before `create`: this fails at open, naming the field.
  handed = undefined;
  const broken = await openTestSession({ capabilities: [probe({ mustExist: Tokens.Goal })] });
  check("needs: an unsatisfiable REQUIRED dependency means `create` never ran", handed === undefined);
  check("needs: ...the capability is absent from the session", broken.get(Probe) === undefined);
  check(
    "needs: ...and the diagnostic names the capability, the field and where the service comes from",
    broken.drainDiagnostics().some((d) => d.capability === "probe" && d.message.includes("`mustExist`") && d.message.includes('the "goal" capability')),
  );
  await broken.close();
}

/**
 * A workspace-tier provision: the half of a capability that is SHARED. The workspace scope opens
 * before anyone knows which capabilities its sessions will carry, so the first session that
 * declares one builds it — and every later session in that directory finds the same instance,
 * which then lives and dies with the workspace, not with whichever session happened to be first.
 */
async function testWorkspaceTierProvision(): Promise<void> {
  const Shared = token<{ id: number; close(): void }>("scope-session-shared", "workspace");
  const PerSession = token<{ shared: { id: number } }>("scope-session-perssn", "session");
  let builds = 0;
  let disposed = 0;
  const cap = (): Capability => ({
    name: "two-halves",
    provides: [
      provision({
        token: Shared,
        create: () => {
          builds += 1;
          return { id: builds, close: () => (disposed += 1) };
        },
      }),
      // The session half DECLARES the shared half — the two are tied together here, in the
      // capability, instead of by a host remembering to register one before the other.
      provision({ token: PerSession, needs: { shared: Shared }, create: ({ shared }) => ({ shared }) }),
    ],
  });

  const harness = new Scope("harness");
  const workspace = harness.child("workspace");
  const a = await openTestSession({ parent: workspace, capabilities: [cap()] });
  const b = await openTestSession({ parent: workspace, capabilities: [cap()] });
  check("workspace provision: built once, by whichever session got there first", builds === 1);
  check("workspace provision: every session in the workspace sees the same instance", a.get(PerSession)?.shared === b.get(PerSession)?.shared);
  check("workspace provision: it landed in the WORKSPACE scope, not the session's", workspace.hasLocal(Shared) && !a.scope.hasLocal(Shared));

  await a.close();
  await b.close();
  check("workspace provision: closing every session does NOT dispose it", disposed === 0);
  await workspace.close();
  check("workspace provision: the workspace closing does", disposed === 1);
  await harness.close();

  // Without a workspace above it, a workspace-tier provision has nowhere to go — say so rather
  // than silently demoting it into the session and giving it the wrong lifetime.
  const orphan = await openTestSession({ capabilities: [cap()] });
  check(
    "workspace provision: a session with no workspace above it is diagnosed, not silently demoted",
    orphan.get(PerSession) === undefined && orphan.drainDiagnostics().some((d) => d.message.includes("no workspace scope above it")),
  );
  await orphan.close();
}

async function testStoreIsThePublishingWrapper(): Promise<void> {
  const backend = new MemoryStore();
  const scope = testHarnessScope({}).child("session");
  wireTestSession(scope, { store: backend });
  const session = await Session.open(scope);
  check("store: the opener registers the backend, the session publishes Tokens.Store on top of it", session.get(Tokens.StoreBackend) === backend && session.get(Tokens.Store) === session.store && session.store !== backend);
  await session.close();
}

async function main(): Promise<void> {
  await testBareSession();
  await testEnvironmentPrecedence();
  await testProvisionsAndDisposeOrder();
  await testProvisionFaultIsolation();
  await testWrongTierProvision();
  await testRequireErrors();
  await testDeclaredDependencies();
  await testWorkspaceTierProvision();
  await testStoreIsThePublishingWrapper();
  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SCOPE-SESSION E2E PASS — bare open + environment precedence + provisions + fault isolation + tier check + declared dependencies + workspace-tier provisions + store wrapper");
  } else {
    console.log("❌ SCOPE-SESSION E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
