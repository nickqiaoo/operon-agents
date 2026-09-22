/**
 * Compile-time contract for provisions. Nothing here runs: it is checked by `pnpm typecheck`
 * (this directory is inside the typecheck program and outside the build), and every
 * `@ts-expect-error` below FAILS THE BUILD if the thing it forbids starts compiling.
 *
 * The rules being pinned: a service may only depend on its own tier and longer-lived ones, a
 * workspace provision has no session to speak of, no provision gets the scope, and `create` sees
 * exactly the dependencies it declared — optional ones as possibly absent.
 */
import { optional, provision, workspaceProvision, token, type RunContext } from "../index.ts";

const SessionThing = token<{ s: string }>("type-test-session", "session");
const WorkspaceThing = token<{ w: string }>("type-test-workspace", "workspace");
const HarnessThing = token<{ h: string }>("type-test-harness", "harness");

// ── legal ────────────────────────────────────────────────────────────────────────────────────
provision({
  token: SessionThing,
  needs: { own: SessionThing, shared: WorkspaceThing, global: HarnessThing, maybe: optional(WorkspaceThing) },
  create: (deps, ctx) => {
    const _id: string = ctx.sessionId;
    const _aborts: AbortSignal = ctx.signal;
    return { s: `${deps.own.s}${deps.shared.w}${deps.global.h}${deps.maybe?.w ?? ""}${_id}${String(_aborts.aborted)}` };
  },
});

workspaceProvision({
  token: WorkspaceThing,
  needs: { shared: WorkspaceThing, global: HarnessThing },
  create: (deps, ctx) => {
    const _aborts: AbortSignal = ctx.signal;
    return { w: `${deps.shared.w}${deps.global.h}${String(_aborts.aborted)}` };
  },
});

// ── tier rule ────────────────────────────────────────────────────────────────────────────────
workspaceProvision({
  token: WorkspaceThing,
  // @ts-expect-error a workspace service outlives every session, so it may not depend on one
  needs: { session: SessionThing },
  create: () => ({ w: "" }),
});

workspaceProvision({
  token: WorkspaceThing,
  // @ts-expect-error `optional` means "may be absent", not "may be short-lived"
  needs: { session: optional(SessionThing) },
  create: () => ({ w: "" }),
});

// ── what the context carries ─────────────────────────────────────────────────────────────────
workspaceProvision({
  token: WorkspaceThing,
  create: (_deps, ctx) => {
    // @ts-expect-error a workspace provision belongs to no session
    ctx.sessionId;
    return { w: "" };
  },
});

provision({
  token: SessionThing,
  create: (_deps, ctx) => {
    // @ts-expect-error dependencies are declared in `needs`; there is no scope to look them up in
    ctx.scope;
    return { s: "" };
  },
});

declare const run: RunContext;
// @ts-expect-error a run context does not carry the scope either
run.scope;

// ── what `create` receives ───────────────────────────────────────────────────────────────────
provision({
  token: SessionThing,
  needs: { shared: WorkspaceThing },
  create: (deps) => {
    // @ts-expect-error `global` was never declared
    deps.global;
    return { s: "" };
  },
});

provision({
  token: SessionThing,
  needs: { maybe: optional(WorkspaceThing) },
  create: (deps) => {
    // @ts-expect-error an optional dependency is `T | undefined` — absence has to be handled
    const _w: string = deps.maybe.w;
    return { s: _w };
  },
});

