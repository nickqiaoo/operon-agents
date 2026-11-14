import type { BackgroundTaskSettlement, BackgroundTaskSink } from "./task.ts";

/** The mutable half of a {@link SwappableSink}: where settlement currently goes. */
interface SinkDownstream {
  update?(): Promise<void>;
  settle(settlement: BackgroundTaskSettlement): Promise<boolean>;
}

/**
 * A {@link BackgroundTaskSink} whose settlement downstream can be swapped atomically at
 * runtime while the `signal` stays fixed. Output is never switched: it already lives at the
 * task's durable output location. On detach only lifecycle ownership moves to the manager.
 */
export class SwappableSink implements BackgroundTaskSink {
  readonly signal: AbortSignal;
  #downstream: SinkDownstream | undefined;

  constructor(signal: AbortSignal) {
    this.signal = signal;
  }

  /** Point settlement at a new downstream. The previous one stops receiving. */
  setDownstream(downstream: SinkDownstream): void {
    this.#downstream = downstream;
  }

  async update(): Promise<void> { await this.#downstream?.update?.(); }

  settle(settlement: BackgroundTaskSettlement): Promise<boolean> {
    return this.#downstream === undefined ? Promise.resolve(false) : this.#downstream.settle(settlement);
  }
}
