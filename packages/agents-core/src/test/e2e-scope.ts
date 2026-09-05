/**
 * Scope — the scoped service registry: tiers, parent lookup, overrides, defaults, handles that
 * survive a parent-level replace, and child-first / reverse-order teardown.
 */
import { Scope, ServiceUnavailableError, token, resetTokenDeclarationsForTest } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface Greeter {
  greet(name: string): string;
  close?(): void;
}

async function testLookupAndOverride(): Promise<void> {
  const HarnessThing = token<string>("scope-test-harness-thing", "harness");
  const SessionThing = token<string>("scope-test-session-thing", "session");
  const harness = new Scope("harness");
  harness.register(HarnessThing, "from-harness");
  const session = harness.child("session");
  check("lookup: a child reads its parent's registration", session.get(HarnessThing) === "from-harness");
  check("lookup: has() walks the chain", session.has(HarnessThing) && !session.hasLocal(HarnessThing));
  session.register(SessionThing, "from-session");
  check("lookup: a parent never sees a child's registration", harness.get(SessionThing) === undefined);
  let threw: unknown;
  try {
    session.register(HarnessThing, "wrong-tier");
  } catch (error) {
    threw = error;
  }
  check("tier: registering a harness token in a session scope throws", threw instanceof Error && threw.message.includes("harness-scoped"));
  threw = undefined;
  try {
    harness.child("harness");
  } catch (error) {
    threw = error;
  }
  check("tier: child() only goes down", threw instanceof Error);
  threw = undefined;
  try {
    session.require(token<string>("scope-test-absent", "session"));
  } catch (error) {
    threw = error;
  }
  check("require: missing → ServiceUnavailableError naming the token", threw instanceof ServiceUnavailableError && threw.serviceName === "scope-test-absent");
  await session.close();
  await harness.close();
}

async function testProvideDefaults(): Promise<void> {
  const Thing = token<{ id: number; close(): void }>("scope-test-provided", "session");
  const harness = new Scope("harness");
  const session = harness.child("session");
  let built = 0;
  let disposed = 0;
  session.provide(Thing, () => {
    built += 1;
    return { id: built, close: () => { disposed += 1; } };
  });
  check("provide: nothing is built before the first get", built === 0 && session.hasLocal(Thing));
  const first = session.get(Thing);
  const second = session.get(Thing);
  check("provide: built once on first get and cached", built === 1 && first === second);
  session.provide(Thing, () => { throw new Error("must not run"); });
  check("provide: a second provide of the same token is ignored", session.get(Thing) === first);
  await session.close();
  check("provide: the materialized default is disposed with the scope", disposed === 1);

  const other = harness.child("session");
  other.register(Thing, { id: 99, close: () => undefined });
  other.provide(Thing, () => { throw new Error("must not run"); });
  check("provide: register wins over a later provide", other.get(Thing)?.id === 99);
  await other.close();
  await harness.close();
}

async function testHandleAcrossParentReplace(): Promise<void> {
  const Greet = token<Greeter>("scope-test-greeter", "harness");
  const harness = new Scope("harness");
  const closed: string[] = [];
  harness.register(Greet, { greet: (n) => `v1 ${n}`, close: () => closed.push("v1") }, { replaceable: true });
  const session = harness.child("session");
  const handle = session.handle(Greet);
  check("handle: a child handle resolves the parent's instance", handle.greet("a") === "v1 a");
  await harness.replace(Greet, { greet: (n) => `v2 ${n}`, close: () => closed.push("v2") });
  check("handle: after a parent-level replace the same child handle lands on v2", handle.greet("a") === "v2 a");
  check("handle: the old instance was disposed after the swap", closed.join(",") === "v1");
  session.register(token<Greeter>("scope-test-greeter-local", "session"), { greet: (n) => `local ${n}` });
  await session.close();
  check("handle: closing the child leaves the parent's service in place", harness.has(Greet));
  await harness.close();
  check("handle: closing the parent disposes v2", closed.join(",") === "v1,v2");
}

async function testCloseOrder(): Promise<void> {
  const A = token<{ close(): void }>("scope-test-a", "harness");
  const B = token<{ close(): void }>("scope-test-b", "harness");
  const C = token<{ close(): void }>("scope-test-c", "session");
  const Lent = token<{ close(): void }>("scope-test-lent", "session");
  const order: string[] = [];
  const harness = new Scope("harness");
  harness.register(A, { close: () => order.push("A") });
  harness.register(B, { close: () => order.push("B") });
  const s1 = harness.child("session");
  s1.register(C, { close: () => order.push("s1.C") });
  s1.register(Lent, { close: () => order.push("s1.lent") }, { owned: false });
  const s2 = harness.child("session");
  s2.register(C, { close: () => order.push("s2.C") });
  await harness.close();
  check("close: children first (newest first), then own entries in reverse order", order.join(",") === "s2.C,s1.C,B,A");
  check("close: owned:false entries are never disposed", !order.includes("s1.lent"));
  check("close: closed scopes report it", harness.closed && s1.closed && s2.closed);
  let threw = false;
  try {
    s1.register(C, { close: () => undefined });
  } catch {
    threw = true;
  }
  check("close: registering on a closed scope throws", threw);
  await harness.close();
  check("close: idempotent", true);
}

async function testDisposeTimeout(): Promise<void> {
  const Slow = token<{ close(): Promise<void> }>("scope-test-slow", "session");
  const errors: string[] = [];
  const session = new Scope("session");
  session.register(Slow, { close: () => new Promise(() => undefined) });
  const started = Date.now();
  await session.close({ disposeTimeoutMs: 30, onDisposeError: (name, error) => errors.push(`${name}:${error instanceof Error ? error.message : String(error)}`) });
  check("dispose: a hanging dispose is abandoned at the deadline", Date.now() - started < 1000 && errors.some((e) => e.startsWith("scope-test-slow:") && e.includes("timed out")));
}

async function testCloseLifecycle(): Promise<void> {
  // ── Every close() call returns the SAME promise ──
  {
    const scope = new Scope("session");
    const first = scope.close();
    const second = scope.close();
    check("lifecycle: concurrent close() calls return the identical promise", first === second);
    await first;
    check("lifecycle: a later close() still returns that same promise", scope.close() === first);
    check("lifecycle: state ends at closed", scope.state === "closed");
  }

  // ── A parent closing while a child is mid-close WAITS for the child ──
  {
    const ParentThing = token<{ close(): void }>("scope-test-lc-parent", "harness");
    const ChildThing = token<{ close(): Promise<void> }>("scope-test-lc-child", "session");
    const order: string[] = [];
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const harness = new Scope("harness");
    harness.register(ParentThing, { close: () => order.push("parent") });
    const session = harness.child("session");
    session.register(ChildThing, {
      close: async () => {
        order.push("child:start");
        await childGate;
        order.push("child:end");
      },
    });
    const childClose = session.close();
    await Promise.resolve();
    check("lifecycle: the child reports closing while its disposer runs", session.state === "closing");
    const parentClose = harness.close();
    // Let the parent's close get as far as it can without the child releasing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    check("lifecycle: the parent has NOT disposed its own entries while the child is still closing", !order.includes("parent"));
    check("lifecycle: the parent reports closing meanwhile", harness.state === "closing");
    releaseChild();
    await Promise.all([childClose, parentClose]);
    check("lifecycle: teardown order is child:start,child:end,parent", order.join(",") === "child:start,child:end,parent");
    check("lifecycle: both report closed afterwards", harness.state === "closed" && session.state === "closed");
  }

  // ── No lazy default materializes once closing ──
  {
    const Eager = token<{ close(): void }>("scope-test-lc-eager", "session");
    const Lazy = token<{ ping(): string; close(): void }>("scope-test-lc-lazy", "session");
    let lazyCreated = 0;
    let lazyDisposed = 0;
    let seenDuringDispose: unknown = "unset";
    const session = new Scope("session");
    session.provide(Lazy, () => {
      lazyCreated += 1;
      return { ping: () => "pong", close: () => void (lazyDisposed += 1) };
    });
    session.register(Eager, {
      close: () => {
        // A disposer touching a never-materialized default during teardown.
        seenDuringDispose = session.get(Lazy);
      },
    });
    await session.close();
    check("lifecycle: a disposer reading an unmaterialized default gets undefined", seenDuringDispose === undefined);
    check("lifecycle: the default was never created behind the teardown's back", lazyCreated === 0 && lazyDisposed === 0);
    check("lifecycle: after close, get() of that default is still undefined (no orphan)", session.get(Lazy) === undefined);
  }

  // ── Materialized-before-close defaults are still reachable by disposers (and disposed) ──
  {
    const Eager = token<{ close(): void }>("scope-test-lc-eager2", "session");
    const Lazy = token<{ ping(): string; close(): void }>("scope-test-lc-lazy2", "session");
    let lazyDisposed = 0;
    let seen: unknown;
    const session = new Scope("session");
    session.provide(Lazy, () => ({ ping: () => "pong", close: () => void (lazyDisposed += 1) }));
    // The discipline: a dependency a disposer needs is established BEFORE the dependent
    // registers, so reverse-order teardown reaches the dependent first.
    session.get(Lazy);
    session.register(Eager, { close: () => { seen = session.get(Lazy)?.ping(); } });
    await session.close();
    check("lifecycle: a default materialized before its dependent registered stays readable for that disposer", seen === "pong");
    check("lifecycle: ...and is disposed exactly once", lazyDisposed === 1);
  }
}

function testTokenDeclarations(): void {
  const a = token<number>("scope-test-decl", "session");
  const b = token<number>("scope-test-decl", "session");
  check("token: redeclaring the same name + scope is equivalent (compares by name)", a.name === b.name && a.scope === b.scope);
  let threw = false;
  try {
    token<number>("scope-test-decl", "harness");
  } catch {
    threw = true;
  }
  check("token: redeclaring a name with another scope throws", threw);
  resetTokenDeclarationsForTest();
  token<number>("scope-test-decl", "harness");
  check("token: after the test reset the name can be re-declared", true);
}

async function main(): Promise<void> {
  await testLookupAndOverride();
  await testProvideDefaults();
  await testHandleAcrossParentReplace();
  await testCloseOrder();
  await testDisposeTimeout();
  await testCloseLifecycle();
  testTokenDeclarations();
  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SCOPE E2E PASS — lookup + tiers + provide + handles across replace + close order + dispose deadline");
  } else {
    console.log("❌ SCOPE E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
