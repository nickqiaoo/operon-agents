/**
 * Extension services, by NAME, over the harness-tier {@link Scope}.
 *
 * Framework objects are addressed by typed tokens (`T.Machine`, `T.Goal`, …). Extension
 * services are the one place a string is the natural key: an extension is loaded by its id
 * (from a file, or by value), publishes its `create` result under that id, and other extensions
 * name it in `uses`. This facade maps those ids onto harness-tier tokens, so extension services
 * live in the same scope — same lease / drain / replace machinery, same teardown order — as
 * everything else the harness owns (design: docs/architecture.md §5.5).
 *
 * Handles expose METHODS ONLY. A method's return value must not carry the instance (no
 * `return this`, no objects closing over it) — that is the one leak the Proxy cannot stop.
 */
import { Scope, ServiceUnavailableError, deadHandle, isProbeProperty, token, type RegisterOptions, type Token } from "operon-agents-core";

export { ServiceUnavailableError, isProbeProperty };
export type { ServiceUnavailableReason } from "operon-agents-core";

export type ServiceOptions = Pick<RegisterOptions, "replaceable" | "dispose">;

function serviceToken<T = unknown>(name: string): Token<T, "harness"> {
  if (name.length === 0) throw new Error("service name must be non-empty");
  return token<T, "harness">(name, "harness");
}

export class ServiceRegistry {
  readonly scope: Scope<"harness">;

  /** Over the given harness scope, or a fresh standalone one (tests, thin hosts) — optionally
   *  with its own `warn` sink. */
  constructor(scopeOrOptions: Scope<"harness"> | { readonly warn?: (message: string) => void; readonly scope?: Scope<"harness"> } = {}) {
    const scope = scopeOrOptions instanceof Scope
      ? scopeOrOptions
      : scopeOrOptions.scope ?? new Scope("harness" as const, undefined, scopeOrOptions.warn !== undefined ? { warn: scopeOrOptions.warn } : {});
    if (scope.kind !== "harness") throw new Error("extension services live in the harness scope");
    this.scope = scope;
  }

  /** Register a service under a unique name. Duplicate names fail closed — an extension that
   *  wants to take over an existing name must go through `replace`, never shadow. */
  register(name: string, instance: unknown, options: ServiceOptions = {}): void {
    this.scope.register(serviceToken(name), instance, options);
  }

  has(name: string): boolean {
    return this.scope.has(serviceToken(name));
  }

  /** The stable handle for a service — safe to take before the service is registered and to
   *  keep across replaces; see `Scope.handle`. */
  handle<T = unknown>(name: string): T {
    return this.scope.handle(serviceToken<T>(name));
  }

  /** Swap the provider behind a name; see `Scope.replace`. */
  replace(
    name: string,
    next: unknown,
    options: { readonly drainTimeoutMs?: number; readonly force?: boolean } = {},
  ): Promise<void> {
    return this.scope.replace(serviceToken(name), next, options);
  }

  /** Remove a service entirely (extension unload); see `Scope.unregister`. */
  unregister(name: string, options: { readonly drainTimeoutMs?: number } = {}): Promise<void> {
    return this.scope.unregister(serviceToken(name), options);
  }
}

/** A handle whose every call throws "missing" — handed to detached extensions and to
 *  extensions on hosts that expose no services, mirroring the actions revocation collar. */
export function deadServiceHandle<T = unknown>(name: string): T {
  return deadHandle<T>(serviceToken<T>(name));
}
