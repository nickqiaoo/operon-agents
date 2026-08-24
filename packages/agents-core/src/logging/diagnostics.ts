import type { CapabilityDiagnostic } from "../capabilities/capability.ts";
import type { LogLevel } from "./logger.ts";
import type { Sink } from "./sinks.ts";

/**
 * The troubleshooting channel — a sink-backed record of capability diagnostics, internal
 * errors, and ad-hoc notes, kept separate from the application log so support data survives
 * even when app logging is quiet. `flush()` settles pending writes.
 */
export class DiagnosticLog {
  private readonly sink: Sink;

  constructor(sink: Sink) {
    this.sink = sink;
  }

  /** Record a `CapabilityDiagnostic` (register/start/stop failure) raised by the assembler. */
  report(diagnostic: CapabilityDiagnostic): void {
    this.sink.write({
      level: diagnostic.level,
      message: `[${diagnostic.capability}/${diagnostic.phase}] ${diagnostic.message}`,
      fields: { capability: diagnostic.capability, phase: diagnostic.phase },
      timestamp: Date.now(),
    });
  }

  /** Record an error with its stack/cause, for post-hoc debugging. */
  error(message: string, error?: unknown, fields?: Record<string, unknown>): void {
    this.sink.write({
      level: "error",
      message,
      fields: { ...fields, ...(error !== undefined ? { error: errorInfo(error) } : {}) },
      timestamp: Date.now(),
    });
  }

  /** Record a free-form diagnostic note. */
  note(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    this.sink.write({ level, message, fields, timestamp: Date.now() });
  }

  async flush(): Promise<void> {
    await this.sink.flush();
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}

function errorInfo(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) };
  }
  return { value: String(error) };
}
