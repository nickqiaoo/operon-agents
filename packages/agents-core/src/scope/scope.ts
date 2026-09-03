/**
 * Scoped service registry with handle indirection — the one place that answers "who builds
 * this object, how many exist, how long does it live, and what tears it down before what".
 *
 * Three tiers, each a `Scope` with a parent: harness → workspace → session. A lookup walks up
 * the chain, so a session-scoped consumer reaches process-level services without anything
 * being threaded through by hand, and a child that registers the same token OVERRIDES its
 * parent's for everything under it. `register` takes a built instance; `provide` takes a
 * synchronous default factory that runs on first use in this scope. Register wins over provide.
 *
 * Hot swapping (design: docs/architecture.md §5.5): consumers never hold a service instance.
 * `handle()` returns a stable Proxy that resolves the CURRENT entry on every method call and
 * holds a lease for exactly that call, so replacing a provider is a registry-local act — swap
 * the entry, drain the old instance's leases, dispose it — with no consumer participation. The
 * invariant this file exists to keep: at any moment only one generation of a service is being
 * handed out.
 *
 * Handles expose METHODS ONLY. A method's return value must not carry the instance (no
 * `return this`, no objects closing over it) — that is the one leak the Proxy cannot stop.
 *
 * Teardown: `close()` closes children first (newest first), then this scope's own entries in
 * reverse registration order — drain, then dispose (default: `instance.close()` when present;
 * `owned: false` skips disposal for objects the registrant merely lent). Parents are untouched.
 */
import { SCOPE_ORDER, type ScopeKind, type Token } from "./token.ts";

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

export interface RegisterOptions {
  /** Absent/false = `replace()` rejects; swapping this service means restarting the process. */
  readonly replaceable?: boolean;
  /** Called once the old instance has drained. Default: call `instance.close()` when present. */
  readonly dispose?: (instance: unknown) => void | Promise<void>;
  /**
   * `false` = the scope does not own this object: it was lent by the registrant (a caller's
   * machine, a repository's store) and is never disposed here. Default `true`.
   */
  readonly owned?: boolean;
}

interface ServiceEntry {
  readonly instance: unknown;
  readonly generation: number;
  leases: number;
  /** Draining refuses new leases; in-flight calls that already hold one run to completion. */
  draining: boolean;
  onDrained?: () => void;
  readonly replaceable: boolean;
  readonly owned: boolean;
  readonly dispose?: (instance: unknown) => void | Promise<void>;
}

interface Provider {
  readonly create: (scope: Scope) => unknown;
  readonly options: RegisterOptions;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export interface CloseOptions {
  /** How long to wait for in-flight handle calls before disposing anyway. Default 10s. */
  readonly drainTimeoutMs?: number;
  /** Deadline for one entry's dispose; a straggler is abandoned (logged) so close() never hangs. */
  readonly disposeTimeoutMs?: number;
  /** Where a dispose failure/timeout goes. Default: the scope's `warn`. */
  readonly onDisposeError?: (name: string, error: unknown) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class Scope {
  readonly kind: ScopeKind;
  readonly parent: Scope | undefined;
  private readonly table = new Map<string, ServiceEntry>();
  private readonly providers = new Map<string, Provider>();
  /** Registration order (materialized providers included) — reversed by `close()`. */
  private readonly order: string[] = [];
  private readonly handles = new Map<string, unknown>();
  /** Per-name op chain: concurrent replace/unregister serialize instead of interleaving. */
  private readonly ops = new Map<string, Promise<unknown>>();
  private readonly children = new Set<Scope>();
  private readonly warn: (message: string) => void;
  private _closed = false;

  constructor(kind: ScopeKind, parent?: Scope, options: { readonly warn?: (message: string) => void } = {}) {
    this.kind = kind;
    this.parent = parent;
    this.warn = options.warn ?? parent?.warn ?? ((message) => console.warn(`[scope] ${message}`));
    parent?.children.add(this);
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Open a nested scope. Tiers only go down: harness → workspace | session, workspace → session. */
  child(kind: ScopeKind): Scope {
    this.assertOpen();
    if (SCOPE_ORDER.indexOf(kind) <= SCOPE_ORDER.indexOf(this.kind)) {
      throw new Error(`cannot open a ${kind} scope under a ${this.kind} scope`);
    }
    return new Scope(kind, this);
  }

  /** Register a built instance under a token. Duplicate names fail closed — a scope that wants
   *  to take over an existing name must go through `replace`, never shadow within one tier. */
  register<T>(tok: Token<T>, instance: T, options: RegisterOptions = {}): void {
    this.assertOpen();
    this.assertTier(tok);
    if (this.table.has(tok.name)) throw new Error(`service "${tok.name}" is already registered in this ${this.kind} scope`);
    this.providers.delete(tok.name);
    this.table.set(tok.name, entryOf(instance, options));
    this.order.push(tok.name);
  }

  /**
   * A default: `create` runs on the first `get` in THIS scope and the result is registered here
   * (and disposed here). A prior `register` or `provide` of the same token wins silently — that
   * is what "default" means; overriding is done with `register`.
   */
  provide<T>(tok: Token<T>, create: (scope: Scope) => T, options: RegisterOptions = {}): void {
    this.assertOpen();
    this.assertTier(tok);
    if (this.table.has(tok.name) || this.providers.has(tok.name)) return;
    this.providers.set(tok.name, { create, options });
  }

  /** This scope's entry, materializing a pending default, else the parent's. */
  get<T>(tok: Token<T>): T | undefined {
    const entry = this.lookup(tok.name);
    return entry === undefined || entry.draining ? undefined : (entry.instance as T);
  }

  require<T>(tok: Token<T>): T {
    const entry = this.lookup(tok.name);
    if (entry === undefined) throw new ServiceUnavailableError(tok.name, "missing");
    if (entry.draining) throw new ServiceUnavailableError(tok.name, "draining");
    return entry.instance as T;
  }

  /** Registered (or provided) here or in any ancestor, and not draining. */
  has<T>(tok: Token<T>): boolean {
    const entry = this.lookup(tok.name);
    return entry !== undefined && !entry.draining;
  }

  /** Registered or provided in THIS scope (a pending default counts). */
  hasLocal<T>(tok: Token<T>): boolean {
    return this.table.has(tok.name) || this.providers.has(tok.name);
  }

  /**
   * The stable handle for a service — safe to take before the service is registered and to
   * keep across replaces. Property access requires a method (a non-function property throws:
   * replaceable services expose methods only); availability is judged at CALL time, so a
   * handle taken during early setup never explodes on mere property access. Resolution walks
   * the scope chain on every call, so a parent-level replace lands on a child's handle too.
   */
  handle<T>(tok: Token<T>): T {
    const name = tok.name;
    const cached = this.handles.get(name);
    if (cached !== undefined) return cached as T;
    const scope = this;
    const proxy = new Proxy(Object.create(null) as object, {
      get(_target, prop) {
        // Probe surface reads as undefined (await, JSON.stringify, inspect, test utilities —
        // see isProbeProperty): probes must never throw or receive a fake method.
        if (isProbeProperty(prop)) return undefined;
        const key = prop as string; // symbols were filtered by the probe check
        const entry = scope.lookup(name);
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
        return (...args: unknown[]) => scope.invoke(name, key, args);
      },
      has(_target, prop) {
        const entry = scope.lookup(name);
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
   * Swap the provider behind a token registered in THIS scope. Atomic from the consumers'
   * side: the very next handle call lands on `next`; calls already in flight finish on the old
   * instance, which is disposed once its leases drain (or after `drainTimeoutMs`, logged,
   * default 10s).
   *
   * `force` skips the `replaceable` gate. It exists for ONE caller — `harness.replaceExtension`,
   * where the extension that OWNS this service is being replaced along with it, inside the
   * barrier's quiet moment. The gate guards the other case (a host swapping an instance under a
   * live owner that never agreed to it), which is why it stays closed by default.
   */
  replace<T>(
    tok: Token<T>,
    next: T,
    options: { readonly drainTimeoutMs?: number; readonly force?: boolean } = {},
  ): Promise<void> {
    const name = tok.name;
    return this.enqueueOp(name, async () => {
      const old = this.table.get(name);
      if (old === undefined) throw new Error(`cannot replace service "${name}": not registered in this ${this.kind} scope`);
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
        owned: old.owned,
        ...(old.dispose !== undefined ? { dispose: old.dispose } : {}),
      });
      await this.retire(old, name, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    });
  }

  /**
   * Remove a service of THIS scope entirely (extension unload). Unlike `replace`, callers see
   * "draining" during the drain and "missing" after — there is deliberately no replaceable gate
   * here: unload is the owner tearing its service down, not swapping code under consumers.
   */
  unregister<T>(tok: Token<T>, options: CloseOptions = {}): Promise<void> {
    const name = tok.name;
    return this.enqueueOp(name, async () => {
      this.providers.delete(name);
      const entry = this.table.get(name);
      if (entry === undefined) return;
      entry.draining = true;
      await this.drainLeases(entry, name, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
      this.table.delete(name);
      const at = this.order.lastIndexOf(name);
      if (at >= 0) this.order.splice(at, 1);
      await this.disposeOf(entry, name, options);
    });
  }

  /**
   * Tear the scope down: children first (newest first), then this scope's entries in reverse
   * registration order. Idempotent. Afterwards `register`/`provide`/`child` throw; `get` still
   * reads the parent chain. Parents are never touched.
   */
  async close(options: CloseOptions = {}): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    for (const child of [...this.children].reverse()) await child.close(options);
    this.children.clear();
    for (const name of [...this.order].reverse()) {
      await this.unregister({ name, scope: this.kind }, options);
    }
    this.providers.clear();
    this.parent?.children.delete(this);
  }

  private lookup(name: string): ServiceEntry | undefined {
    const local = this.table.get(name);
    if (local !== undefined) return local;
    const provider = this.providers.get(name);
    if (provider !== undefined) {
      this.providers.delete(name);
      const entry = entryOf(provider.create(this), provider.options);
      this.table.set(name, entry);
      this.order.push(name);
      return entry;
    }
    return this.parent?.lookup(name);
  }

  private invoke(name: string, prop: string, args: unknown[]): unknown {
    const entry = this.lookup(name);
    if (entry === undefined || entry.draining) {
      throw new ServiceUnavailableError(name, entry === undefined ? "missing" : "draining");
    }
    const fn = (entry.instance as Record<string, unknown>)[prop];
    if (typeof fn !== "function") {
      throw new TypeError(
        `service "${name}": "${prop}" is not a method — replaceable services expose methods only`,
      );
    }
    // The lease covers exactly this call, on the entry that answered it (possibly a parent's).
    // Resolve-at-call is what makes a swap between two calls land the next call on the new
    // instance with zero consumer cooperation.
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

  private async disposeOf(entry: ServiceEntry, name: string, options: CloseOptions = {}): Promise<void> {
    if (!entry.owned) return;
    try {
      const run = async (): Promise<void> => {
        if (entry.dispose !== undefined) {
          await entry.dispose(entry.instance);
        } else {
          const close = (entry.instance as { close?: unknown } | null | undefined)?.close;
          if (typeof close === "function") await (close as () => void | Promise<void>).call(entry.instance);
        }
      };
      await (options.disposeTimeoutMs === undefined ? run() : withTimeout(run(), options.disposeTimeoutMs));
    } catch (error) {
      if (options.onDisposeError !== undefined) options.onDisposeError(name, error);
      else this.warn(`service "${name}": dispose failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private assertOpen(): void {
    if (this._closed) throw new Error(`${this.kind} scope is closed`);
  }

  private assertTier(tok: Token<unknown>): void {
    if (tok.scope !== this.kind) {
      throw new Error(`token "${tok.name}" is declared ${tok.scope}-scoped; cannot register it in a ${this.kind} scope`);
    }
  }
}

function entryOf(instance: unknown, options: RegisterOptions): ServiceEntry {
  return {
    instance,
    generation: 1,
    leases: 0,
    draining: false,
    replaceable: options.replaceable === true,
    owned: options.owned !== false,
    ...(options.dispose !== undefined ? { dispose: options.dispose } : {}),
  };
}

/** A handle whose every call throws "missing" — handed to detached extensions and to
 *  extensions on hosts that expose no services, mirroring the actions revocation collar. */
export function deadHandle<T>(tok: Token<T>): T {
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (isProbeProperty(prop)) return undefined;
      return () => {
        throw new ServiceUnavailableError(tok.name, "missing");
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
