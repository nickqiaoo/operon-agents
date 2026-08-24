/**
 * The low-latency path: events from whoever is running a session to whoever is watching it.
 *
 * The store is the source of truth, but it is a poor delivery channel — reading it to feed
 * subscribers makes read load scale with connected viewers rather than with data, and adds a
 * poll interval of latency to every token. A broadcast channel carries the same events on a
 * separate, faster path.
 *
 * ## It is deliberately unreliable, and that is what makes it cheap
 *
 * A dropped message costs nothing durable: the persisted half of the stream can always be
 * re-read, and clients reconcile by event id on reconnect. So this needs no acknowledgements,
 * no retries, no dead letters, and no durable queue — which is what keeps it swappable for a
 * Redis `PUBLISH` (or NATS, or nothing at all in a single process).
 *
 * ## Why everything goes through here, not just the ephemeral events
 *
 * It is tempting to send only live-only events (token deltas) this way and let persisted events
 * arrive via the store. That breaks ordering: a delta belongs to the message it precedes, and
 * two paths with different latencies deliver them out of order with no way for a client to
 * reassemble. One channel carries all of it; the store is used to fill the gap before the
 * subscription started, not to race it.
 */
import type { AgentEvent } from "operon-agents";

export type BroadcastListener = (event: AgentEvent) => void;

export interface EventBroadcaster {
  /**
   * Publish to whoever is listening. Returns nothing and never throws — a broadcaster that made
   * callers await it would put a best-effort side channel on the critical path of writing a turn.
   */
  publish(sessionId: string, event: AgentEvent): void;
  /** Listen until the returned function is called. */
  subscribe(sessionId: string, listener: BroadcastListener): () => void;
}

/**
 * Single-process broadcaster.
 *
 * Correct ONLY when the worker and the API surface share a process — a demo, a test, a
 * single-binary deployment. It is not a smaller version of the cross-process one: a worker
 * publishes into its own Map, and a subscriber in another process is looking at a different
 * Map, so nothing ever arrives.
 *
 * **That failure is completely silent.** No error, no warning, no dropped-connection — the
 * stream simply carries persisted events only, and live-only events (token deltas) never show
 * up. It reads exactly like "the model isn't streaming", which sends you looking in the wrong
 * place. In the deployment this framework is built for — API surface and workers as separate
 * services — this class is the wrong choice; use {@link RedisEventBroadcaster}.
 */
export class MemoryEventBroadcaster implements EventBroadcaster {
  private readonly listeners = new Map<string, Set<BroadcastListener>>();

  publish(sessionId: string, event: AgentEvent): void {
    const set = this.listeners.get(sessionId);
    if (set === undefined) return;
    // Copy before iterating: a listener may unsubscribe itself while being notified.
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not stop delivery to the others, and must not surface as an
        // error on the publishing side — the publisher is mid-turn and has nothing to do with it.
      }
    }
  }

  subscribe(sessionId: string, listener: BroadcastListener): () => void {
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(sessionId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }
}

/**
 * Minimal Redis surface for pub/sub, duck-typed the same way the core store's client is —
 * `ioredis` and `node-redis` both satisfy it, and neither becomes a dependency here.
 */
export interface BroadcastPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface BroadcastSubscriber {
  subscribe(channel: string, ...args: unknown[]): Promise<unknown>;
  unsubscribe(channel: string, ...args: unknown[]): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  off?(event: "message", listener: (channel: string, message: string) => void): unknown;
}

export interface RedisEventBroadcasterOptions {
  /** Any client. Used only for `PUBLISH`, so it can be the same pool everything else uses. */
  readonly publisher: BroadcastPublisher;
  /**
   * A SEPARATE connection. Redis puts a subscribed connection into a mode where it accepts
   * almost nothing else, so sharing one with normal commands breaks them — this is the single
   * most common way a first pub/sub integration goes wrong.
   */
  readonly subscriber: BroadcastSubscriber;
  readonly channelPrefix?: string;
  /** Called when a payload cannot be parsed or delivered. Defaults to silence. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Cross-process broadcaster.
 *
 * Required as soon as the API surface and the workers are separate processes — which is the
 * whole point of the architecture. With the in-memory implementation a worker publishes into
 * its own process and a subscriber on another node hears nothing, so live-only events (token
 * deltas) never arrive: the stream silently degrades to persisted events only, with no error
 * anywhere to notice.
 *
 * Still best-effort. Redis pub/sub drops messages for disconnected subscribers and does not
 * replay, which is exactly the contract this interface promises — durability lives in the log.
 */
export class RedisEventBroadcaster implements EventBroadcaster {
  private readonly publisher: BroadcastPublisher;
  private readonly subscriber: BroadcastSubscriber;
  private readonly prefix: string;
  private readonly onError: (error: unknown) => void;
  private readonly listeners = new Map<string, Set<BroadcastListener>>();
  private wired = false;

  constructor(options: RedisEventBroadcasterOptions) {
    this.publisher = options.publisher;
    this.subscriber = options.subscriber;
    this.prefix = options.channelPrefix ?? "session:events:";
    this.onError = options.onError ?? ((): void => undefined);
  }

  publish(sessionId: string, event: AgentEvent): void {
    // Fire-and-forget: the caller is mid-turn, and a side channel must never be able to slow
    // down or fail the work that produced the event.
    void Promise.resolve(this.publisher.publish(this.prefix + sessionId, JSON.stringify(event)))
      .catch(this.onError);
  }

  subscribe(sessionId: string, listener: BroadcastListener): () => void {
    this.wire();
    const channel = this.prefix + sessionId;
    let set = this.listeners.get(channel);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(channel, set);
      // One Redis subscription per session, regardless of how many local listeners it has.
      void Promise.resolve(this.subscriber.subscribe(channel)).catch(this.onError);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size > 0) return;
      this.listeners.delete(channel);
      void Promise.resolve(this.subscriber.unsubscribe(channel)).catch(this.onError);
    };
  }

  /** Attach the shared message handler once, not per subscription. */
  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.subscriber.on("message", (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (set === undefined || set.size === 0) return;
      let event: AgentEvent;
      try {
        event = JSON.parse(message) as AgentEvent;
      } catch (error) {
        this.onError(error);
        return;
      }
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch (error) {
          this.onError(error);
        }
      }
    });
  }
}
