import type { Logger } from "../logging/index.ts";
import type { SessionStore, StateKey } from "../store/index.ts";

interface Slot {
  /** Settles when every write started for this key so far has (never rejects). */
  tail: Promise<void>;
  /** The write queued behind `tail` that has not started yet — a new change joins it. */
  waiting: Promise<void> | undefined;
}

/**
 * Writes current-state values to the store's key/value side, one key at a time.
 *
 * A write reads its value (`read()`) when it RUNS, not when it is asked for, so asking again
 * while a write is waiting to start changes nothing — that write will carry the newer value —
 * and writes for one key land in the order they were asked for. Nothing here touches the log.
 */
export class DurableStateWriter {
  private readonly slots = new Map<string, Slot>();
  private readonly store: SessionStore | undefined;
  private readonly logger: Logger;

  constructor(store: SessionStore | undefined, logger: Logger) {
    this.store = store;
    this.logger = logger;
  }

  /** Store `read()` under `key` (null/undefined removes it). See the class doc for ordering. */
  write(key: StateKey, read: () => unknown): Promise<void> {
    const store = this.store;
    if (store === undefined) return Promise.resolve();
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = { tail: Promise.resolve(), waiting: undefined };
      this.slots.set(key, slot);
    }
    if (slot.waiting !== undefined) return slot.waiting;
    const current = slot;
    const write = current.tail.then(async () => {
      // Running now: a change from here on must be carried by a write after this one.
      current.waiting = undefined;
      const value = read();
      if (value === undefined || value === null) await store.deleteState(key);
      else await store.putState(key, value);
    });
    current.waiting = write;
    current.tail = write.catch(() => undefined);
    write.catch((error: unknown) => {
      this.logger.log("warn", `failed to persist state "${key}"`, { error: error instanceof Error ? error.message : String(error) });
    });
    return write;
  }

  /** Settles once every write asked for `key` so far has finished (succeeded or failed). */
  settled(key: StateKey): Promise<void> {
    return this.slots.get(key)?.tail ?? Promise.resolve();
  }

  /** Settles once every write asked for so far has finished (succeeded or failed). */
  async flush(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => slot.tail));
  }
}
