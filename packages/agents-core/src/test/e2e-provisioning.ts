/**
 * Assembly and lifetime: the rules that decide WHO a provision may depend on, WHERE those
 * dependencies come from, and what happens to objects that are half-built or half-registered.
 *
 * Each block below was a reproduced leak before it was a test:
 *  - a workspace service resolved its dependencies from the session that triggered it, captured
 *    that session's private objects, and kept handing them out after the session closed;
 *  - a capability whose second provision threw left its first service registered, so the NEXT
 *    capability could depend on a capability that is not open;
 *  - a factory that returned after `close()` had its result dropped without disposal.
 */
import {
  Scope,
  Session,
  Tokens,
  token,
  provision,
  workspaceProvision,
  optional,
  assertDependencyTiers,
  DependencyScopeError,
  type Capability,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface Closable {
  readonly id: string;
  closed: boolean;
}
const closable = (id: string): Closable => ({ id, closed: false });
const closeIt = (i: Closable): void => {
  i.closed = true;
};

// ── tier rule ────────────────────────────────────────────────────────────────────────────────
const Priv = token<Closable>("prov-priv", "session");
const Shared = token<{ boundTo: Closable }>("prov-shared", "workspace");
const SharedOk = token<{ built: number }>("prov-shared-ok", "workspace");
const HarnessThing = token<{ tag: string }>("prov-harness", "harness");

async function testTierRule(): Promise<void> {
  // The declaration alone is the violation: the factory must never run.
  let ran = 0;
  const bad: Capability = {
    name: "bad",
    provides: [
      provision({ token: Priv, create: () => closable("private"), dispose: closeIt }),
      // Only reachable by lying to the compiler — which is the point of the runtime check.
      workspaceProvision({
        token: Shared,
        needs: { priv: Priv as never },
        create: ({ priv }) => {
          ran += 1;
          return { boundTo: priv as Closable };
        },
      }),
    ],
  };

  const harness = new Scope("harness");
  const workspace = harness.child("workspace");
  const a = await Session.open(workspace.child("session"), { capabilities: [bad] });
  check("tier: a workspace service may not depend on a session one — the factory never ran", ran === 0);
  check("tier: the shared service was not registered", workspace.get(Shared) === undefined);
  check("tier: the capability is absent from the session", a.get(Priv) === undefined);
  await a.close();
  await harness.close();

  // The same check, called directly, names both sides.
  let err: unknown;
  try {
    assertDependencyTiers("bad", Shared, { priv: Priv } as never);
  } catch (error) {
    err = error;
  }
  const scoped = err instanceof DependencyScopeError ? err : undefined;
  check(
    "tier: the error names the capability, both services and both tiers",
    scoped?.capability === "bad" && scoped.serviceScope === "workspace" && scoped.dependencyScope === "session" && scoped.field === "priv",
  );
  check("tier: optional() cannot smuggle a session token past the check", (() => {
    try {
      assertDependencyTiers("bad", Shared, { priv: optional(Priv) } as never);
      return false;
    } catch (error) {
      return error instanceof DependencyScopeError;
    }
  })());
}

// ── workspace ownership ──────────────────────────────────────────────────────────────────────
async function testWorkspaceOwnership(): Promise<void> {
  let built = 0;
  let sawSessionId: unknown = "unset";
  let abortedWithSession = false;
  const cap = (): Capability => ({
    name: "shared",
    provides: [
      workspaceProvision({
        token: SharedOk,
        needs: { harnessThing: optional(HarnessThing) },
        create: (_deps, ctx) => {
          built += 1;
          sawSessionId = (ctx as { sessionId?: unknown }).sessionId;
          ctx.signal.addEventListener("abort", () => {
            abortedWithSession = true;
          });
          return { built };
        },
      }),
    ],
  });

  const harness = new Scope("harness");
  harness.register(HarnessThing, { tag: "h" });
  const workspace = harness.child("workspace");

  const a = await Session.open(workspace.child("session"), { capabilities: [cap()] });
  const b = await Session.open(workspace.child("session"), { capabilities: [cap()] });
  check("workspace: the shared service is built once for the workspace", built === 1);
  check("workspace: its context carries no session id", sawSessionId === undefined);
  check("workspace: it may depend on a harness service", workspace.get(SharedOk) !== undefined);

  await a.close();
  check("workspace: closing the session that built it does not abort its signal", abortedWithSession === false);
  check("workspace: B still sees the shared service after A closed", workspace.get(SharedOk)?.built === 1);
  await b.close();
  await harness.close();
  check("workspace: the workspace teardown aborts the build signal", abortedWithSession === true);
}

// ── reuse skips resolution ───────────────────────────────────────────────────────────────────
const SharedReuse = token<{ n: number }>("prov-shared-reuse", "workspace");
const WorkspaceOnly = token<{ v: string }>("prov-workspace-only", "workspace");

async function testReuseSkipsResolution(): Promise<void> {
  let factoryRuns = 0;
  const cap = (): Capability => ({
    name: "reuse",
    provides: [
      workspaceProvision({
        token: SharedReuse,
        needs: { dep: WorkspaceOnly },
        create: ({ dep }) => {
          factoryRuns += 1;
          return { n: dep.v.length };
        },
      }),
    ],
  });

  const harness = new Scope("harness");
  const workspace = harness.child("workspace");
  workspace.register(WorkspaceOnly, { v: "abc" });
  const a = await Session.open(workspace.child("session"), { capabilities: [cap()] });
  check("reuse: the first session builds it", factoryRuns === 1 && workspace.get(SharedReuse)?.n === 3);

  // Remove the dependency: a second session must NOT re-resolve it, because nothing is built.
  await workspace.unregister(WorkspaceOnly);
  const b = await Session.open(workspace.child("session"), { capabilities: [cap()] });
  check("reuse: an existing shared service is reused without resolving its dependencies", factoryRuns === 1);
  check("reuse: the capability still opened for the second session", b.get(SharedReuse) !== undefined);
  await a.close();
  await b.close();
  await harness.close();
}

// ── rollback ─────────────────────────────────────────────────────────────────────────────────
const First = token<Closable>("prov-first", "session");
const Second = token<Closable>("prov-second", "session");
const Consumer = token<{ on: string }>("prov-consumer", "session");
const SharedKept = token<{ keep: true }>("prov-shared-kept", "workspace");

async function testRollback(): Promise<void> {
  const firsts: Closable[] = [];
  const broken: Capability = {
    name: "broken",
    provides: [
      workspaceProvision({ token: SharedKept, create: () => ({ keep: true as const }) }),
      provision({
        token: First,
        create: () => {
          const i = closable("first");
          firsts.push(i);
          return i;
        },
        dispose: closeIt,
      }),
      provision({
        token: Second,
        create: () => {
          throw new Error("boom");
        },
      }),
    ],
  };
  const consumer: Capability = {
    name: "consumer",
    provides: [provision({ token: Consumer, needs: { first: First }, create: ({ first }) => ({ on: first.id }) })],
  };

  const harness = new Scope("harness");
  const workspace = harness.child("workspace");
  const s = await Session.open(workspace.child("session"), { capabilities: [broken, consumer] });
  check("rollback: the failed capability's session service is gone", s.get(First) === undefined);
  check("rollback: it was disposed, not just unregistered", firsts.length === 1 && firsts[0]!.closed);
  check("rollback: the next capability cannot build on the remains", s.get(Consumer) === undefined);
  check("rollback: a workspace service it had already published survives", workspace.get(SharedKept)?.keep === true);
  await s.close();
  await harness.close();
}

// ── build ledger ─────────────────────────────────────────────────────────────────────────────
const Late = token<Closable>("prov-late", "session");
const Raced = token<Closable>("prov-raced", "session");
const Lent = token<Closable>("prov-lent", "session");

async function testBuildLedger(): Promise<void> {
  // 1. A factory that returns after close: the object is disposed exactly once, never registered.
  {
    const scope = new Scope("session");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let cancelled = false;
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const instance = closable("late");
    const pending = scope.ensure(Late, async (ctx) => {
      started();
      await gate;
      cancelled = ctx.signal.aborted;
      return instance;
    }, { dispose: closeIt });
    await running;
    const settled = pending.then(() => "registered").catch((e: Error) => e.message);
    const closing = scope.close({ buildTimeoutMs: 1_000 });
    release();
    await closing;
    check("ledger: the running factory sees the cancel", cancelled);
    check("ledger: a late result is disposed", instance.closed);
    check("ledger: and never registered", scope.get(Late) === undefined);
    check("ledger: the caller is told the scope closed", String(await settled).includes("closed") || String(await settled).includes("closing"));
  }

  // 2. A build that has not started yet when close begins is never started at all — there is
  //    nowhere to put what it would produce.
  {
    const scope = new Scope("session");
    let factoryRan = false;
    const pending = scope.ensure(Late, () => {
      factoryRan = true;
      return closable("never");
    }, { dispose: closeIt });
    await scope.close();
    await pending.catch(() => undefined);
    check("ledger: a build that had not started when close began never runs", factoryRan === false);
  }

  // 3. Concurrent ensure shares one build; a racing register wins and the loser is disposed.
  {
    const scope = new Scope("session");
    let runs = 0;
    const [a, b] = await Promise.all([
      scope.ensure(Raced, async () => {
        runs += 1;
        return closable("a");
      }),
      scope.ensure(Raced, async () => {
        runs += 1;
        return closable("b");
      }),
    ]);
    check("ledger: concurrent ensure runs the factory once and shares the result", runs === 1 && a === b);
    await scope.close();
  }
  {
    const scope = new Scope("session");
    const winner = closable("winner");
    const loser = closable("loser");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = scope.ensure(Raced, async () => {
      await gate;
      return loser;
    }, { dispose: closeIt });
    scope.register(Raced, winner, { dispose: closeIt });
    release();
    const got = await pending;
    check("ledger: a build that loses to a register returns the winner", got === winner);
    check("ledger: and disposes its own object", loser.closed && !winner.closed);
    await scope.close();
    check("ledger: the winner is disposed by the scope, once", winner.closed);
  }

  // 4. `owned: false` is honoured on the discard path too.
  {
    const scope = new Scope("session");
    const lent = closable("lent");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = scope.ensure(Lent, async () => {
      await gate;
      return lent;
    }, { owned: false, dispose: closeIt });
    const closing = scope.close({ buildTimeoutMs: 500 });
    release();
    await closing;
    await pending.catch(() => undefined);
    check("ledger: a lent object is not disposed even when it arrives too late", lent.closed === false);
  }

  // 5. `create` refuses a duplicate instead of silently reusing it.
  {
    const scope = new Scope("session");
    scope.register(Raced, closable("already"));
    let message = "";
    await scope.create(Raced, () => closable("second")).catch((e: Error) => (message = e.message));
    check("ledger: create refuses a token this scope already has", message.includes("already registered"));
    await scope.close();
  }
}

// ── session provision uses the same path ─────────────────────────────────────────────────────
const SlowService = token<Closable>("prov-slow", "session");

async function testSessionProvisionTracked(): Promise<void> {
  const instance = closable("slow");
  const slow: Capability = {
    name: "slow",
    provides: [
      provision({
        token: SlowService,
        create: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return instance;
        },
        dispose: closeIt,
      }),
    ],
  };
  const scope = new Scope("session");
  const session = await Session.open(scope, { capabilities: [slow] });
  check("session: a slow provision lands in the scope", session.get(SlowService) === instance);
  await session.close();
  check("session: and is disposed with it", instance.closed);
}

async function main(): Promise<void> {
  await testTierRule();
  await testWorkspaceOwnership();
  await testReuseSkipsResolution();
  await testRollback();
  await testBuildLedger();
  await testSessionProvisionTracked();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log(`❌ PROVISIONING E2E FAIL — ${failed.map(([l]) => l).join("; ")}`);
    process.exit(1);
  }
  console.log("✅ PROVISIONING E2E PASS — tier rule + workspace ownership + rollback + build ledger");
}

await main();
