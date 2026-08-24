/**
 * Process-level service registry with handle indirection — the substrate for hot-swapping
 * shared instances (design: docs/architecture.md §5.5).
 *
 * Consumers never hold a service instance. `handle()` returns a stable Proxy that resolves
 * the CURRENT table entry on every method call and holds a lease for exactly that call, so
 * replacing a provider is a registry-local act — swap the entry, drain the old instance's
 * leases, dispose it — with no session participation at all. The invariant this file exists
 * to keep: at any moment only one generation of a service is being handed out.
 *
 * Handles expose METHODS ONLY. A method's return value must not carry the instance (no
 * `return this`, no objects closing over it) — that is the one leak the Proxy cannot stop.
 */

export type ServiceUnavailableReason = "missing" | "draining";

export class ServiceUnavailableError extends Error {
  readonly serviceName: string;
  readonly reason: ServiceUnavailableReason;
  constructor(serviceName: string, reason: ServiceUnavailableReason) {
    super(
      reason === "missing"
        ? `service "${serviceName}" is not registered`
        : `service "${serviceName}" is shutting down`,
    );
    this.name = "ServiceUnavailableError";
    this.serviceName = serviceName;
    this.reason = reason;
  }
}

export interface ServiceOptions {
  /** Absent/false = `replace()` rejects; swapping this service means restarting the process. */
  readonly replaceable?: boolean;
  /** Called once the old instance has drained. Default: call `instance.close()` when present. */
  readonly dispose?: (instance: unknown) => void | Promise<void>;
}

interface ServiceEntry {
  readonly instance: unknown;
  readonly generation: number;
  leases: number;
  /** Draining refuses new leases; in-flight calls that already hold one run to completion. */
  draining: boolean;
  onDrained?: () => void;
  readonly replaceable: boolean;
  readonly dispose?: (instance: unknown) => void | Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export class ServiceRegistry {
  private readonly table = new Map<string, ServiceEntry>();
  private readonly handles = new Map<string, unknown>();
  /** Per-name op chain: concurrent replace/unregister serialize instead of interleaving. */
  private readonly ops = new Map<string, Promise<unknown>>();
  private readonly warn: (message: string) => void;

  constructor(options: { readonly warn?: (message: string) => void } = {}) {
    this.warn = options.warn ?? ((message) => console.warn(`[services] ${message}`));
  }

  /** Register a service under a unique name. Duplicate names fail closed — an extension that
   *  wants to take over an existing name must go through `replace`, never shadow. */
  register(name: string, instance: unknown, options: ServiceOptions = {}): void {
    if (name.length === 0) throw new Error("service name must be non-empty");
    if (this.table.has(name)) throw new Error(`service "${name}" is already registered`);
    this.table.set(name, {
      instance,
      generation: 1,
      leases: 0,
      draining: false,
      replaceable: options.replaceable === true,
      ...(options.dispose !== undefined ? { dispose: options.dispose } : {}),
    });
  }

  has(name: string): boolean {
    const entry = this.table.get(name);
    return entry !== undefined && !entry.draining;
  }

  /**
   * The stable handle for a service — safe to take before the service is registered and to
   * keep across replaces. Property access requires a method (a non-function property throws:
   * replaceable services expose methods only); availability is judged at CALL time, so a
   * handle taken during early setup never explodes on mere property access.
   */
  handle<T = unknown>(name: string): T {
    const cached = this.handles.get(name);
    if (cached !== undefined) return cached as T;
    const registry = this;
    const proxy = new Proxy(Object.create(null) as object, {
      get(_target, prop) {
        // Probe surface reads as undefined (await, JSON.stringify, inspect, test utilities —
        // see isProbeProperty): probes must never throw or receive a fake method.
        if (isProbeProperty(prop)) return undefined;
        const key = prop as string; // symbols were filtered by the probe check
        const entry = registry.table.get(name);
        if (entry !== undefined) {
          const value = (entry.instance as Record<string, unknown>)[key];
          // Absent entirely → undefined (probe-safe, and a typo'd method fails naturally at
          // the call site). Present but NOT a method → the discipline throw: field access is
          // the one real violation ("replaceable services expose methods only").
          if (value === undefined && !(key in (entry.instance as object))) return undefined;
          if (typeof value !== "function") {
            throw new TypeError(
              `service "${name}": "${key}" is not a method — replaceable services expose methods only`,
            );
          }
        }
        return (...args: unknown[]) => registry.invoke(name, key, args);
      },
      has(_target, prop) {
        const entry = registry.table.get(name);
        return (
          entry !== undefined &&
          typeof prop === "string" &&
          typeof (entry.instance as Record<string, unknown>)[prop] === "function"
        );
      },
    });
    this.handles.set(name, proxy);
    return proxy as T;
  }

  /**
   * Swap the provider behind a name. Atomic from the consumers' side: the very next handle
   * call lands on `next`; calls already in flight finish on the old instance, which is
   * disposed once its leases drain (or after `drainTimeoutMs`, logged, default 10s).
   *
   * `force` skips the `replaceable` gate. It exists for ONE caller — `harness.replaceExtension`,
   * where the extension that OWNS this service is being replaced along with it, inside the
   * barrier's quiet moment. The gate guards the other case (a host swapping an instance under a
   * live owner that never agreed to it), which is why it stays closed by default.
   */
  replace(
    name: string,
    next: unknown,
    options: { readonly drainTimeoutMs?: number; readonly force?: boolean } = {},
  ): Promise<void> {
    return this.enqueueOp(name, async () => {
      const old = this.table.get(name);
      if (old === undefined) throw new Error(`cannot replace service "${name}": not registered`);
      if (!old.replaceable && options.force !== true) {
        throw new Error(
          `service "${name}" is not replaceable — register it with { replaceable: true }, or restart the process to change it`,
        );
      }
      this.table.set(name, {
        instance: next,
        generation: old.generation + 1,
        leases: 0,
        draining: false,
        replaceable: old.replaceable,
        ...(old.dispose !== undefined ? { dispose: old.dispose } : {}),
      });
      await this.retire(old, name, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    });
  }

  /**
   * Remove a service entirely (extension unload). Unlike `replace`, callers see "draining"
   * during the drain and "missing" after — there is deliberately no replaceable gate here:
   * unload is the host/loader tearing an extension's service down, not swapping code under consumers.
   */
  unregister(name: string, options: { readonly drainTimeoutMs?: number } = {}): Promise<void> {
    return this.enqueueOp(name, async () => {
      const entry = this.table.get(name);
      if (entry === undefined) return;
      entry.draining = true;
      await this.drainLeases(entry, name, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
      this.table.delete(name);
      await this.disposeOf(entry, name);
    });
  }

  private invoke(name: string, prop: string, args: unknown[]): unknown {
    const entry = this.table.get(name);
    if (entry === undefined || entry.draining) {
      throw new ServiceUnavailableError(name, entry === undefined ? "missing" : "draining");
    }
    const fn = (entry.instance as Record<string, unknown>)[prop];
    if (typeof fn !== "function") {
      throw new TypeError(
        `service "${name}": "${prop}" is not a method — replaceable services expose methods only`,
      );
    }
    // The lease covers exactly this call. Resolve-at-call is what makes a swap between two
    // calls land the next call on the new instance with zero consumer cooperation.
    entry.leases += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.leases -= 1;
      if (entry.leases === 0 && entry.draining) entry.onDrained?.();
    };
    let result: unknown;
    try {
      result = (fn as (...a: unknown[]) => unknown).apply(entry.instance, args);
    } catch (error) {
      release();
      throw error;
    }
    if (isPromiseLike(result)) return Promise.resolve(result).finally(release);
    release();
    return result;
  }

  private enqueueOp(name: string, run: () => Promise<void>): Promise<void> {
    const prev = this.ops.get(name) ?? Promise.resolve();
    const next = prev.then(
      () => run(),
      () => run(),
    );
    // The chain must survive a rejected op; the rejection still reaches that op's caller.
    this.ops.set(name, next.catch(() => undefined));
    return next;
  }

  private async retire(old: ServiceEntry, name: string, drainTimeoutMs: number): Promise<void> {
    old.draining = true;
    await this.drainLeases(old, name, drainTimeoutMs);
    await this.disposeOf(old, name);
  }

  private async drainLeases(entry: ServiceEntry, name: string, timeoutMs: number): Promise<void> {
    if (entry.leases === 0) return;
    const drained = new Promise<void>((resolve) => {
      entry.onDrained = resolve;
    });
    // Re-check after wiring the callback: the last lease may have released in between.
    if (entry.leases === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      drained.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.warn(
        `service "${name}": disposing with ${entry.leases} lease(s) still outstanding after ${timeoutMs}ms drain timeout`,
      );
    }
  }

  private async disposeOf(entry: ServiceEntry, name: string): Promise<void> {
    try {
      if (entry.dispose !== undefined) {
        await entry.dispose(entry.instance);
      } else {
        const close = (entry.instance as { close?: unknown } | null | undefined)?.close;
        if (typeof close === "function") await (close as () => void | Promise<void>).call(entry.instance);
      }
    } catch (error) {
      this.warn(`service "${name}": dispose failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A handle whose every call throws "missing" — handed to detached extensions and to
 *  extensions on hosts that expose no services, mirroring the actions revocation collar. */
export function deadServiceHandle<T = unknown>(name: string): T {
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (isProbeProperty(prop)) return undefined;
      return () => {
        throw new ServiceUnavailableError(name, "missing");
      };
    },
    // `in` is the registration probe (thin shells use it to fall back to a direct instance);
    // a dead handle answers no to everything.
    has() {
      return false;
    },
  }) as T;
}

/**
 * Properties a proxy must NEVER intercept with a throw or a fake method — the probe surface
 * generic JS pokes at (await → `then`, JSON.stringify → `toJSON` via the absent-property rule,
 * class checks → `prototype`/`constructor`, test/inspect utilities → `_`-prefixed, serializers →
 * numeric indices, symbols everywhere). Cordis's reflect layer converged on this exact list
 * over years of proxy bugs (`isSpecialProperty`); we adopt it wholesale.
 */
export function isProbeProperty(prop: string | symbol): boolean {
  return (
    typeof prop === "symbol" ||
    prop === "then" ||
    prop === "toJSON" ||
    prop === "prototype" ||
    prop === "constructor" ||
    String(parseInt(prop, 10)) === prop ||
    prop.startsWith("_")
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
