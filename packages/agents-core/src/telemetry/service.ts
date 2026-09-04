/**
 * TelemetryService — the `track()` facade.
 *
 * Deliberately thin: it merges context, drops `undefined`, stamps a timestamp and fans out to
 * appenders. No enrichment, no batching, no transport — those live in appenders, so a product can
 * swap the sink without touching a single call site.
 *
 * Context is environmental. `withContext({ session_id })` returns a forwarding VIEW: appenders, the
 * enabled switch, `flush` and `shutdown` stay on the root, so an appender added after boot applies
 * to every view already handed out (desktop attaches PostHog only once consent is known).
 *
 * `withRegistry(...)` is a type-only re-view: a product declares its own registry and tracks its
 * own events through the same root. Nothing is validated at runtime — the registry is a compile-time
 * contract — except the one thing types cannot see: a non-primitive value, which is dropped.
 */

import type { TelemetryAppender, TelemetryEvent } from "./appender.ts";
import { nullTelemetryAppender } from "./appender.ts";
import { FRAMEWORK_TELEMETRY_EVENTS, type Exact, type FrameworkTelemetryEvents, type PayloadOf, type TelemetryPrimitive, type TelemetryRegistry } from "./events.ts";

export type TelemetryContext = Readonly<Record<string, TelemetryPrimitive | undefined>>;

export interface TelemetryService<R extends TelemetryRegistry = FrameworkTelemetryEvents> {
  /** Record one event. Never throws, never awaits. A no-op while disabled or with no appender. */
  track<K extends keyof R & string, P extends PayloadOf<R[K]>>(name: K, properties: Exact<PayloadOf<R[K]>, P>): void;
  /** A view that prepends `context` to every event. Cheap; make one per session / agent. */
  withContext(context: TelemetryContext): TelemetryService<R>;
  /** The same root seen through another registry. Type-only. */
  withRegistry<R2 extends TelemetryRegistry>(registry: R2): TelemetryService<R2>;
  /** Attach an appender to the ROOT (views forward here). Returns a detach function. */
  addAppender(appender: TelemetryAppender): () => void;
  /** Master switch. Off = dropped at the root before any appender sees the event. */
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  flush(): Promise<void>;
  /** Drain every appender. Call before process exit or buffered events are lost. */
  shutdown(): Promise<void>;
}

export interface TelemetryServiceOptions {
  /** Clock for `TelemetryEvent.timestamp`. Tests inject a counter. */
  readonly now?: () => number;
  /** Where an appender's throw goes. Default: `console.warn`, once per appender. */
  readonly onError?: (error: unknown, appender: TelemetryAppender) => void;
  /** Initial switch position. Default `true`; a product with a consent gate starts `false`. */
  readonly enabled?: boolean;
}

type RawTrack = (name: string, properties: TelemetryContext, context: TelemetryContext) => void;

class Root {
  private appenders: TelemetryAppender[] = [];
  private readonly warned = new WeakSet<TelemetryAppender>();
  private readonly now: () => number;
  private readonly onError: (error: unknown, appender: TelemetryAppender) => void;
  enabled: boolean;

  constructor(options: TelemetryServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.enabled = options.enabled ?? true;
    this.onError =
      options.onError ??
      ((error, appender) => {
        if (this.warned.has(appender)) return;
        this.warned.add(appender);
        console.warn(`[telemetry] appender threw; further errors from it are silenced: ${String(error)}`);
      });
  }

  emit(name: string, properties: TelemetryContext, context: TelemetryContext): void {
    if (!this.enabled || this.appenders.length === 0) return;
    const merged: Record<string, TelemetryPrimitive> = {};
    // Context first, payload second: a payload key wins (the registry forbids overlap anyway).
    for (const source of [context, properties]) {
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") merged[key] = value;
        // Anything else is not representable on the wire; the types forbid it, so it is a bug in
        // a `withRegistry` product caller that cast its way past them. Drop, do not throw.
      }
    }
    const event: TelemetryEvent = { name, properties: merged, timestamp: this.now() };
    for (const appender of this.appenders) {
      try {
        appender.track(event);
      } catch (error) {
        this.onError(error, appender);
      }
    }
  }

  add(appender: TelemetryAppender): () => void {
    if (appender === nullTelemetryAppender) return () => {};
    this.appenders = [...this.appenders, appender];
    return () => {
      this.appenders = this.appenders.filter((a) => a !== appender);
    };
  }

  async flush(): Promise<void> {
    await Promise.all(this.appenders.map((a) => Promise.resolve(a.flush()).catch((error: unknown) => this.onError(error, a))));
  }

  async shutdown(): Promise<void> {
    const appenders = this.appenders;
    this.appenders = [];
    await Promise.all(appenders.map((a) => Promise.resolve(a.shutdown()).catch((error: unknown) => this.onError(error, a))));
  }
}

class View<R extends TelemetryRegistry> implements TelemetryService<R> {
  private readonly root: Root;
  private readonly context: TelemetryContext;
  private readonly raw: RawTrack;

  constructor(root: Root, context: TelemetryContext) {
    this.root = root;
    this.context = context;
    this.raw = (name, properties, context) => root.emit(name, properties, context);
  }

  track<K extends keyof R & string, P extends PayloadOf<R[K]>>(name: K, properties: Exact<PayloadOf<R[K]>, P>): void {
    this.raw(name, properties as TelemetryContext, this.context);
  }

  withContext(context: TelemetryContext): TelemetryService<R> {
    return new View<R>(this.root, { ...this.context, ...context });
  }

  withRegistry<R2 extends TelemetryRegistry>(_registry: R2): TelemetryService<R2> {
    return new View<R2>(this.root, this.context);
  }

  addAppender(appender: TelemetryAppender): () => void {
    return this.root.add(appender);
  }

  setEnabled(enabled: boolean): void {
    this.root.enabled = enabled;
  }

  get enabled(): boolean {
    return this.root.enabled;
  }

  flush(): Promise<void> {
    return this.root.flush();
  }

  shutdown(): Promise<void> {
    return this.root.shutdown();
  }
}

/** A root service with no appender: every `track` is a no-op until `addAppender`. */
export function createTelemetryService(options: TelemetryServiceOptions = {}): TelemetryService<FrameworkTelemetryEvents> {
  return new View<FrameworkTelemetryEvents>(new Root(options), {});
}

/** Shared no-op instance for the "nothing configured" path. `addAppender` on it is a bug; it throws. */
export const noopTelemetryService: TelemetryService<FrameworkTelemetryEvents> = (() => {
  const service = createTelemetryService({ enabled: false });
  const frozen: TelemetryService<FrameworkTelemetryEvents> = {
    track: () => {},
    withContext: () => frozen,
    withRegistry: <R2 extends TelemetryRegistry>() => frozen as unknown as TelemetryService<R2>,
    addAppender: () => {
      throw new Error("noopTelemetryService is shared and immutable; create one with createTelemetryService()");
    },
    setEnabled: () => {},
    get enabled() {
      return false;
    },
    flush: () => service.flush(),
    shutdown: () => service.shutdown(),
  };
  return frozen;
})();

/** Re-exported so `service.withRegistry(FRAMEWORK_TELEMETRY_EVENTS)` reads naturally at call sites. */
export { FRAMEWORK_TELEMETRY_EVENTS };
