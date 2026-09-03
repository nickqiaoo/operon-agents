/**
 * Extension services, by NAME, over the {@link Scope} tree.
 *
 * Framework objects are addressed by typed tokens (`T.Machine`, `T.Goal`, …). Extension
 * services are the one place a string is the natural key: an extension is loaded by its id
 * (from a file, or by value), publishes its shared half's result under that id, and other
 * extensions name it in `uses`. This facade maps those ids onto tokens, so extension services
 * live in the same scopes — same lease / drain / replace machinery, same teardown order — as
 * everything else the harness owns (design: docs/architecture.md §5.5, §5.7).
 *
 * A service lives at ONE tier, decided by which shared half produced it: a `harness` half's
 * result sits in the harness scope (one per process), a `workspace` half's in each workspace
 * scope (one per key). The registry remembers which names are workspace-tier — the harness
 * scope cannot answer that for itself — and resolves a name FROM a given scope (`hasFrom` /
 * `handleFrom`), so a session reaches either tier by walking up its own chain.
 *
 * Handles expose METHODS ONLY. A method's return value must not carry the instance (no
 * `return this`, no objects closing over it) — that is the one leak the Proxy cannot stop.
 */
import { Scope, ServiceUnavailableError, deadHandle, isProbeProperty, type RegisterOptions, type Token } from "operon-agents-core";

export { ServiceUnavailableError, isProbeProperty };
export type { ServiceUnavailableReason } from "operon-agents-core";

export type ServiceOptions = Pick<RegisterOptions, "replaceable" | "dispose">;

/** The tiers an extension service can live at — the tiers a shared half can run at. */
export type ServiceTier = "harness" | "workspace";

/**
 * A token literal, deliberately NOT `token()`: that call pins a name's tier process-wide at
 * declaration, and an extension id's tier is only known once its definition is read (a
 * `has("peers")` before the load must not decide what tier "peers" is). `Scope.register` still
 * checks the tier at registration — that is where the guarantee lives.
 */
function tokenAt<T, K extends ServiceTier>(name: string, tier: K): Token<T, K> {
  if (name.length === 0) throw new Error("service name must be non-empty");
  return Object.freeze({ name, scope: tier }) as Token<T, K>;
}

export class ServiceRegistry {
  readonly scope: Scope<"harness">;
  /** Names published at the workspace tier (a `workspace` half's id). Declared when the
   *  definition is registered, so a consumer's `uses` check passes before any workspace exists. */
  private readonly workspaceTier = new Set<string>();

  /** Over the given harness scope, or a fresh standalone one (tests, thin hosts) — optionally
   *  with its own `warn` sink. */
  constructor(scopeOrOptions: Scope<"harness"> | { readonly warn?: (message: string) => void; readonly scope?: Scope<"harness"> } = {}) {
    const scope = scopeOrOptions instanceof Scope
      ? scopeOrOptions
      : scopeOrOptions.scope ?? new Scope("harness" as const, undefined, scopeOrOptions.warn !== undefined ? { warn: scopeOrOptions.warn } : {});
    if (scope.kind !== "harness") throw new Error("extension services live in the harness scope");
    this.scope = scope;
  }

  /** Which tier `name` lives at: workspace once declared so, harness otherwise. */
  tierOf(name: string): ServiceTier {
    return this.workspaceTier.has(name) ? "workspace" : "harness";
  }

  /** The token a name resolves through, at its tier. */
  tokenFor<T = unknown>(name: string): Token<T> {
    return tokenAt<T, ServiceTier>(name, this.tierOf(name));
  }

  // ── harness tier ─────────────────────────────────────────────────────────────────────────

  /** Register a service under a unique name in the harness scope. Duplicate names fail closed —
   *  an extension that wants to take over an existing name must go through `replace`, never shadow. */
  register(name: string, instance: unknown, options: ServiceOptions = {}): void {
    if (this.workspaceTier.has(name)) throw new Error(`service "${name}" is workspace-scoped; it cannot also be registered in the harness scope`);
    this.scope.register(tokenAt(name, "harness"), instance, options);
  }

  /** Registered at either tier: in the harness scope, or declared workspace-tier (present in
   *  every workspace once it is composed). The registration check a `uses` consumer needs. */
  has(name: string): boolean {
    return (this.workspaceTier.has(name) && !this.scope.closed) || this.scope.has(tokenAt(name, "harness"));
  }

  /**
   * The stable handle for a HARNESS-tier service — safe to take before the service is registered
   * and to keep across replaces; see `Scope.handle`. A workspace-tier name has no single instance
   * to hand out: resolve it from a workspace or session scope (`handleFrom`, or the harness's
   * `workspaceService`).
   */
  handle<T = unknown>(name: string): T {
    if (this.workspaceTier.has(name)) {
      throw new Error(`service "${name}" is workspace-scoped — there is one per workspace, not one for the harness; resolve it from a workspace (harness.workspaceService) or from a session`);
    }
    return this.scope.handle(tokenAt<T, "harness">(name, "harness"));
  }

  /** Swap the provider behind a harness-tier name; see `Scope.replace`. */
  replace(
    name: string,
    next: unknown,
    options: { readonly drainTimeoutMs?: number; readonly force?: boolean } = {},
  ): Promise<void> {
    if (this.workspaceTier.has(name)) return Promise.reject(new Error(`service "${name}" is workspace-scoped; replace it per workspace`));
    return this.scope.replace(tokenAt(name, "harness"), next, options);
  }

  /** Remove a harness-tier service entirely (extension unload); see `Scope.unregister`. */
  unregister(name: string, options: { readonly drainTimeoutMs?: number } = {}): Promise<void> {
    return this.scope.unregister(tokenAt(name, "harness"), options);
  }

  // ── workspace tier ───────────────────────────────────────────────────────────────────────

  /** Declare `name` workspace-tier: from now on it resolves through workspace scopes and `has`
   *  answers true (its definition is registered; each workspace composes its own instance). */
  declareWorkspace(name: string): void {
    if (this.scope.has(tokenAt(name, "harness"))) throw new Error(`service "${name}" is registered in the harness scope; it cannot also be workspace-scoped`);
    this.workspaceTier.add(name);
  }

  /** Forget a workspace-tier declaration (its definition unloaded, or replaced by one without a
   *  `workspace` half). The caller unregisters the per-workspace instances. */
  undeclareWorkspace(name: string): void {
    this.workspaceTier.delete(name);
  }

  /** Register one workspace's instance of a workspace-tier service. */
  registerIn(scope: Scope<"workspace">, name: string, instance: unknown, options: ServiceOptions = {}): void {
    this.declareWorkspace(name);
    scope.register(tokenAt(name, "workspace"), instance, options);
  }

  /** Whether `scope` holds its own instance of `name` (not an ancestor's). */
  hasLocalIn(scope: Scope<"workspace">, name: string): boolean {
    return scope.hasLocal(tokenAt(name, "workspace"));
  }

  /** Swap one workspace's instance; see `Scope.replace`. */
  replaceIn(
    scope: Scope<"workspace">,
    name: string,
    next: unknown,
    options: { readonly drainTimeoutMs?: number; readonly force?: boolean } = {},
  ): Promise<void> {
    return scope.replace(tokenAt(name, "workspace"), next, options);
  }

  /** Remove one workspace's instance; see `Scope.unregister`. */
  unregisterIn(scope: Scope<"workspace">, name: string, options: { readonly drainTimeoutMs?: number } = {}): Promise<void> {
    return scope.unregister(tokenAt(name, "workspace"), options);
  }

  // ── from any scope ───────────────────────────────────────────────────────────────────────

  /** Registered at `name`'s tier somewhere up `scope`'s chain, and not draining. */
  hasFrom(scope: Scope, name: string): boolean {
    return scope.has(this.tokenFor(name));
  }

  /** The stable handle for `name` as seen from `scope`: resolution walks up the chain on every
   *  call, so a session's handle lands on its workspace's instance or the harness's, whichever
   *  tier the name lives at. */
  handleFrom<T = unknown>(scope: Scope, name: string): T {
    return scope.handle(this.tokenFor<T>(name));
  }
}

/** A handle whose every call throws "missing" — handed to detached extensions and to
 *  extensions on hosts that expose no services, mirroring the actions revocation collar. */
export function deadServiceHandle<T = unknown>(name: string): T {
  return deadHandle<T>(tokenAt<T, "harness">(name, "harness"));
}
