import { redactDeep, redactText, type RedactOptions } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const noopLogger: Logger = { log() {} };

export interface ConsoleLoggerOptions {
  readonly minLevel?: LogLevel;
  readonly redact?: boolean | RedactOptions;
  readonly write?: (line: string) => void;
}

export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.minLevel ?? "info"];
  const write = options.write ?? ((line: string) => console.error(line));
  const redactOpts: RedactOptions | undefined =
    options.redact === false ? undefined : typeof options.redact === "object" ? options.redact : {};

  return {
    log(level, message, fields) {
      if (LEVEL_ORDER[level] < min) return;
      const msg = redactOpts ? redactText(message, redactOpts) : message;
      const safeFields = fields !== undefined && redactOpts ? redactDeep(fields, redactOpts) : fields;
      const suffix = safeFields !== undefined && Object.keys(safeFields).length > 0 ? ` ${safeJson(safeFields)}` : "";
      write(`[${level}] ${msg}${suffix}`);
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Build a console logger from the `AGENTS_LOG` env var so logging can be turned on without code:
 * `AGENTS_LOG=debug` (also `info` | `warn` | `error`, or `1`/`true` = debug). Returns `undefined`
 * when unset, so callers fall back to their own default (typically {@link noopLogger}).
 */
export function envLogger(): Logger | undefined {
  const v = process.env.AGENTS_LOG;
  if (v === undefined || v === "") return undefined;
  const raw = v === "1" || v === "true" || v === "yes" ? "debug" : v.toLowerCase();
  const minLevel: LogLevel = raw in LEVEL_ORDER ? (raw as LogLevel) : "debug";
  return consoleLogger({ minLevel });
}

export interface SinkLoggerOptions {
  readonly minLevel?: LogLevel;
  readonly redact?: boolean | RedactOptions;
}

/** A `Logger` that writes structured records to a {@link import("./sinks.ts").Sink}. */
export function sinkLogger(sink: import("./sinks.ts").Sink, options: SinkLoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.minLevel ?? "info"];
  const redactOpts: RedactOptions | undefined =
    options.redact === false ? undefined : typeof options.redact === "object" ? options.redact : {};
  return {
    log(level, message, fields) {
      if (LEVEL_ORDER[level] < min) return;
      const msg = redactOpts ? redactText(message, redactOpts) : message;
      const safeFields = fields !== undefined && redactOpts ? (redactDeep(fields, redactOpts) as Record<string, unknown>) : fields;
      sink.write({ level, message: msg, fields: safeFields, timestamp: Date.now() });
    },
  };
}
