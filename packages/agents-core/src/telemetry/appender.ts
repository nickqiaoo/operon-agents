import type { TelemetryPrimitive } from "./events.ts";

/** One event on the wire: name + merged (context ⊕ payload) properties + service clock. */
export interface TelemetryEvent {
  readonly name: string;
  readonly properties: Readonly<Record<string, TelemetryPrimitive>>;
  /** Epoch millis from the service clock. */
  readonly timestamp: number;
}

/**
 * Where events go. Plain objects, not scoped services: the service holds a list and fans out.
 *
 * Contract: `track` is synchronous and must not throw (the service isolates a throw, but an
 * appender that relies on that is a bug). Anything async — batching, HTTP — belongs in `flush`
 * and `shutdown`. `shutdown` drains; after it `track` may drop.
 */
export interface TelemetryAppender {
  track(event: TelemetryEvent): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** The default. A service with only this attached costs one array iteration per `track`. */
export const nullTelemetryAppender: TelemetryAppender = Object.freeze({
  track(): void {
    /* no-op */
  },
  flush(): Promise<void> {
    return Promise.resolve();
  },
  shutdown(): Promise<void> {
    return Promise.resolve();
  },
});

export interface ConsoleAppenderOptions {
  readonly write?: (line: string) => void;
}

/** Dev echo: one line per event. Does not redact — it is for the developer's own terminal. */
export class ConsoleAppender implements TelemetryAppender {
  private readonly write: (line: string) => void;

  constructor(options: ConsoleAppenderOptions = {}) {
    this.write = options.write ?? ((line) => console.error(line));
  }

  track(event: TelemetryEvent): void {
    this.write(`[telemetry] ${event.name} ${JSON.stringify(event.properties)}`);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Test seam and buffer: keeps every event it sees. */
export class MemoryAppender implements TelemetryAppender {
  readonly events: TelemetryEvent[] = [];
  flushCount = 0;
  shutdownCount = 0;

  track(event: TelemetryEvent): void {
    this.events.push(event);
  }

  flush(): Promise<void> {
    this.flushCount += 1;
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownCount += 1;
    return Promise.resolve();
  }
}
