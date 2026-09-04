/**
 * PostHogAppender — the framework's default telemetry sink (docs/telemetry.md §7).
 *
 * Two ways in, one path after:
 *
 *   (a) `{ apiKey, host, getDistinctId }` — the appender builds a `posthog-node` client. For
 *       products without their own analytics plumbing. `getDistinctId` is REQUIRED here and is a
 *       callback, not a value: sign-in / sign-out change it mid-process. Returning `undefined`
 *       DROPS the event — the framework never substitutes an id of its own.
 *
 *   (b) `{ client }` — the product injects anything with a `capture()`; identity, consent and
 *       buffering stay wherever the product already keeps them (operon desktop wraps its
 *       consent-gated main-process sink this way, so there is exactly one PostHog channel).
 *
 * Per event: redact → drop non-primitives (types forbid them; a cast can still sneak one in) →
 * enrich with app/framework identity → capture. Batching, retry and backoff are the client's.
 */

import { createRequire } from "node:module";
import { redactTelemetryProperties, type TelemetryAppender, type TelemetryEvent, type TelemetryPrimitive } from "operon-agents-core/telemetry";

/** The minimum a sink has to look like. `posthog-node`'s `PostHog` satisfies it as-is. */
export interface PostHogClientLike {
  capture(message: { readonly distinctId?: string; readonly event: string; readonly properties: Record<string, TelemetryPrimitive>; readonly timestamp?: Date }): void;
  flush?(): Promise<void> | void;
  shutdown?(timeoutMs?: number): Promise<void> | void;
}

export interface PostHogAppIdentity {
  /** Product name stamped on every event as `app_name` (e.g. `operon`). */
  readonly name: string;
  /** Product version stamped as `app_version`. */
  readonly version?: string;
}

interface PostHogAppenderBaseOptions {
  readonly app: PostHogAppIdentity;
  /** Who the event is about. Required in mode (a); optional in mode (b) where the client decides. */
  readonly getDistinctId?: () => string | undefined;
  /** Extra properties stamped on every event (a channel tag, say). Same red lines apply. */
  readonly commonProperties?: Readonly<Record<string, TelemetryPrimitive>>;
  /** Where dropped-event and client errors go. Default: `console.warn`, once per reason. */
  readonly warn?: (message: string) => void;
}

/** Mode (a): the appender owns a `posthog-node` client. */
export interface PostHogAppenderClientOptions extends PostHogAppenderBaseOptions {
  readonly apiKey: string;
  /** PostHog ingestion host, e.g. `https://us.i.posthog.com`. */
  readonly host: string;
  readonly getDistinctId: () => string | undefined;
  /** Client batching knobs; passed through. */
  readonly flushAt?: number;
  readonly flushIntervalMs?: number;
  /** Test seam: build the client from resolved options instead of `new PostHog(...)`. */
  readonly createClient?: (apiKey: string, options: { host: string; flushAt?: number; flushInterval?: number }) => PostHogClientLike;
}

/** Mode (b): the product injects the sink. */
export interface PostHogAppenderInjectedOptions extends PostHogAppenderBaseOptions {
  readonly client: PostHogClientLike;
}

export type PostHogAppenderOptions = PostHogAppenderClientOptions | PostHogAppenderInjectedOptions;

const SHUTDOWN_TIMEOUT_MS = 5_000;

function frameworkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isInjected(options: PostHogAppenderOptions): options is PostHogAppenderInjectedOptions {
  return "client" in options;
}

async function createNodeClient(apiKey: string, options: { host: string; flushAt?: number; flushInterval?: number }): Promise<PostHogClientLike> {
  // Loaded lazily so a product in mode (b) never pays for the module, and so the import lives
  // in one place if the client ever changes.
  const mod = await import("posthog-node");
  return new mod.PostHog(apiKey, { host: options.host, flushAt: options.flushAt, flushInterval: options.flushInterval, disableGeoip: true });
}

export class PostHogAppender implements TelemetryAppender {
  private client: PostHogClientLike | undefined;
  private readonly ready: Promise<void>;
  private readonly getDistinctId: (() => string | undefined) | undefined;
  private readonly requireDistinctId: boolean;
  private readonly common: Readonly<Record<string, TelemetryPrimitive>>;
  private readonly warn: (message: string) => void;
  private readonly warned = new Set<string>();
  /** Events that arrived before the lazy client resolved (mode (a) only). Bounded. */
  private pending: TelemetryEvent[] = [];
  private closed = false;
  private droppedCount = 0;

  constructor(options: PostHogAppenderOptions) {
    this.getDistinctId = options.getDistinctId;
    this.requireDistinctId = !isInjected(options);
    this.common = Object.freeze({
      app_name: options.app.name,
      app_version: options.app.version ?? null,
      framework_version: frameworkVersion(),
      platform: process.platform,
      ...(options.commonProperties ?? {}),
    });
    this.warn = options.warn ?? ((message) => console.warn(`[telemetry/posthog] ${message}`));

    if (isInjected(options)) {
      this.client = options.client;
      this.ready = Promise.resolve();
    } else {
      const create = options.createClient;
      const resolved = { host: options.host, flushAt: options.flushAt, flushInterval: options.flushIntervalMs };
      this.ready = (create === undefined ? createNodeClient(options.apiKey, resolved) : Promise.resolve(create(options.apiKey, resolved)))
        .then((client) => {
          this.client = client;
          const queued = this.pending;
          this.pending = [];
          for (const event of queued) this.send(event);
        })
        .catch((error: unknown) => {
          this.warnOnce("client-init", `client failed to initialise; events will be dropped: ${String(error)}`);
          this.pending = [];
        });
    }
  }

  /** Events dropped for lack of a distinct id, a closed appender, or a failed client. */
  get dropped(): number {
    return this.droppedCount;
  }

  track(event: TelemetryEvent): void {
    if (this.closed) {
      this.droppedCount += 1;
      return;
    }
    if (this.client === undefined) {
      if (this.pending.length >= 200) {
        this.droppedCount += 1;
        return;
      }
      this.pending.push(event);
      return;
    }
    this.send(event);
  }

  private send(event: TelemetryEvent): void {
    const client = this.client;
    if (client === undefined) return;
    const distinctId = this.getDistinctId?.();
    if (this.requireDistinctId && distinctId === undefined) {
      this.droppedCount += 1;
      this.warnOnce("no-distinct-id", "getDistinctId() returned undefined; event dropped (the framework never mints an id)");
      return;
    }
    const properties: Record<string, TelemetryPrimitive> = { ...this.common, ...redactTelemetryProperties(event.properties) };
    try {
      client.capture({
        ...(distinctId === undefined ? {} : { distinctId }),
        event: event.name,
        properties,
        timestamp: new Date(event.timestamp),
      });
    } catch (error) {
      this.warnOnce("capture", `client.capture threw: ${String(error)}`);
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  async flush(): Promise<void> {
    await this.ready;
    await Promise.resolve(this.client?.flush?.());
  }

  async shutdown(): Promise<void> {
    await this.ready;
    this.closed = true;
    await Promise.resolve(this.client?.shutdown?.(SHUTDOWN_TIMEOUT_MS));
  }
}
