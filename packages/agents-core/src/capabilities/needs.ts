/**
 * Declared dependencies: what a provision says it needs, resolved once before it is built.
 *
 * The difference from looking a service up inside `create` is not syntax, it is WHO KNOWS WHAT,
 * WHEN:
 *  - The compiler knows. `create` is handed exactly what `needs` declared, typed — it cannot
 *    reach a service it did not ask for, and it cannot forget that an optional one may be absent.
 *  - The assembler knows. `Session.open` resolves the whole map before calling `create`, so a
 *    missing dependency fails the capability at open, naming the capability, the field and the
 *    token — not on whatever later call first happened to touch it.
 *  - A reader knows. `needs` is data sitting next to the token, so "who depends on what" can be
 *    read, printed or checked without executing anything.
 *
 * A lookup inside `create` gives up all three: it is a request the type system cannot see, the
 * assembler cannot pre-check, and a reader has to go hunting in a function body for.
 *
 * The second thing declared here is TIER. A token says how long the object it names lives; that
 * alone does not keep the objects it DEPENDS on alive as long. A workspace service that captured
 * the first session's store outlives it and hands every later session a closed object. So the
 * visibility rule is the token's own tier, in both directions: a service may only depend on its
 * own tier and longer-lived ones, and it resolves them from ITS scope, never from the session
 * that happened to trigger the build.
 */
import { SCOPE_ORDER, type ScopeKind, type Token } from "../scope/token.ts";
import type { Scope } from "../scope/scope.ts";

const OPTIONAL = Symbol("optional-dependency");

/** A dependency the provision can do without. Resolves to `T | undefined`, never throws. */
export interface OptionalDependency<T, K extends ScopeKind = ScopeKind> {
  readonly [OPTIONAL]: true;
  readonly token: Token<T, K>;
}

/**
 * Mark a dependency as one this provision can run without — `store` for a capability that
 * degrades to memory, say. The resolved field is `T | undefined`, so the compiler makes you
 * decide what absence means instead of letting it surface as a crash later.
 *
 * It carries the token's TIER through, so it cannot be used to smuggle a session service into a
 * workspace provision's `needs`: optional means "may be absent", not "may be short-lived".
 */
export function optional<T, K extends ScopeKind>(tok: Token<T, K>): OptionalDependency<T, K> {
  return { [OPTIONAL]: true, token: tok };
}

function asOptional(dep: Dependency<ScopeKind>): OptionalDependency<unknown> | undefined {
  return (dep as { [OPTIONAL]?: true })[OPTIONAL] === true ? (dep as OptionalDependency<unknown>) : undefined;
}

/** The token behind a dependency, optional or not. */
function tokenOf(dep: Dependency<ScopeKind>): Token<unknown, ScopeKind> {
  return asOptional(dep)?.token ?? (dep as Token<unknown, ScopeKind>);
}

export type Dependency<K extends ScopeKind = ScopeKind> = Token<any, K> | OptionalDependency<any, K>;

/**
 * The tiers a `K`-tier service may depend on: its own and everything that outlives it. This is
 * the compile-time half of the lifetime rule; `assertDependencyTiers` is the runtime half, for
 * untyped callers and for `as any`.
 */
export type VisibleFrom<K extends ScopeKind> = K extends "session"
  ? ScopeKind
  : K extends "workspace"
    ? "workspace" | "harness"
    : "harness";

/**
 * Field name → what fills it. Field names are the provision's own vocabulary, so a capability
 * can call a token whatever reads best where it is used. `K` is the tier of the service being
 * built, which is what decides who it is allowed to name.
 */
export type Needs<K extends ScopeKind = ScopeKind> = Readonly<Record<string, Dependency<VisibleFrom<K>>>>;

/** What `create` receives: one field per declared dependency, optional ones widened. */
export type Resolved<N extends Needs<any>> = {
  readonly [F in keyof N]: N[F] extends OptionalDependency<infer T, any> ? T | undefined : N[F] extends Token<infer T, any> ? T : never;
};

/**
 * Thrown when a declared dependency has nobody to fill it. Says which capability wanted it and
 * under which field, because at open time that is the whole question — the token name alone
 * leaves you guessing which of the capabilities you passed in was the one that cared.
 */
export class MissingDependencyError extends Error {
  readonly capability: string;
  readonly field: string;
  readonly serviceName: string;
  constructor(capability: string, field: string, tok: Token<unknown>) {
    const from = tok.providedBy === undefined ? "" : `; it comes from ${tok.providedBy}`;
    super(`capability "${capability}" needs \`${field}\`, but service "${tok.name}" is not registered${from}`);
    this.name = "MissingDependencyError";
    this.capability = capability;
    this.field = field;
    this.serviceName = tok.name;
  }
}

/**
 * Thrown when a declaration would outlive what it depends on — a workspace service naming a
 * session one, say. Caught at assembly, before the factory runs, because the object it would
 * produce is exactly the one nobody can safely dispose: the session that built it closes, the
 * workspace keeps handing its remains to every later session.
 */
export class DependencyScopeError extends Error {
  readonly capability: string;
  readonly field: string;
  /** The service being BUILT (the provision's own token). */
  readonly serviceName: string;
  readonly serviceScope: ScopeKind;
  /** The service it tried to depend on. */
  readonly dependencyName: string;
  readonly dependencyScope: ScopeKind;
  constructor(capability: string, provided: Token<unknown, ScopeKind>, field: string, tok: Token<unknown, ScopeKind>) {
    super(
      `capability "${capability}": ${provided.scope} service "${provided.name}" cannot depend on ` +
        `${tok.scope} service "${tok.name}" through \`needs.${field}\` — it would outlive it`,
    );
    this.name = "DependencyScopeError";
    this.capability = capability;
    this.field = field;
    this.serviceName = provided.name;
    this.serviceScope = provided.scope;
    this.dependencyName = tok.name;
    this.dependencyScope = tok.scope;
  }
}

/**
 * The runtime half of the tier rule, checked on DECLARATIONS alone — no scope, no lookups, so it
 * runs even when the service already exists and the factory will be skipped. A shared service
 * that is already built must still not be DECLARED wrong: the next workspace to assemble it
 * would be the one that breaks.
 */
export function assertDependencyTiers(capability: string, provided: Token<unknown, ScopeKind>, needs: Needs<any> | undefined): void {
  const ownTier = SCOPE_ORDER.indexOf(provided.scope);
  for (const [field, dep] of Object.entries<Dependency<ScopeKind>>(needs ?? {})) {
    const tok = tokenOf(dep);
    if (SCOPE_ORDER.indexOf(tok.scope) > ownTier) throw new DependencyScopeError(capability, provided, field, tok);
  }
}

/**
 * Resolve a whole `needs` map from the scope that OWNS the service being built, or throw naming
 * the first field that cannot be filled.
 *
 * `owner` is the provision's own scope, not the session that triggered the build. For a session
 * service the two are the same; for a workspace one they are not, and resolving from the session
 * is how a shared object ends up holding one session's private state. Lookups still walk up from
 * there, so a workspace service reaches harness services as before — it just cannot see down.
 */
export function resolveNeeds<N extends Needs<any>>(owner: Scope, needs: N | undefined, capability: string): Resolved<N> {
  const out: Record<string, unknown> = {};
  for (const [field, dep] of Object.entries<Dependency<ScopeKind>>(needs ?? {})) {
    const opt = asOptional(dep);
    if (opt !== undefined) {
      out[field] = owner.get(opt.token);
      continue;
    }
    const tok = dep as Token<unknown>;
    const value = owner.get(tok);
    if (value === undefined) throw new MissingDependencyError(capability, field, tok);
    out[field] = value;
  }
  return out as Resolved<N>;
}
