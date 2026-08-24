import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogLevel } from "./logger.ts";

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
  readonly timestamp: number;
}

/** A destination for log records. `flush` settles pending async writes. */
export interface Sink {
  write(record: LogRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

function jsonLine(record: LogRecord): string {
  const base: Record<string, unknown> = { time: record.timestamp, level: record.level, msg: record.message };
  if (record.fields !== undefined && Object.keys(record.fields).length > 0) base["fields"] = record.fields;
  try {
    return JSON.stringify(base);
  } catch {
    return JSON.stringify({ time: record.timestamp, level: record.level, msg: record.message, fields: "[unserializable]" });
  }
}

export interface ConsoleSinkOptions {
  readonly write?: (line: string) => void;
}

/** Human-readable line to the console (default stderr). */
export class ConsoleSink implements Sink {
  private readonly out: (line: string) => void;
  constructor(options: ConsoleSinkOptions = {}) {
    this.out = options.write ?? ((line) => console.error(line));
  }
  write(record: LogRecord): void {
    const hasFields = record.fields !== undefined && Object.keys(record.fields).length > 0;
    const suffix = hasFields ? ` ${safeFields(record.fields!)}` : "";
    this.out(`[${record.level}] ${record.message}${suffix}`);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

function safeFields(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields);
  } catch {
    return "[unserializable]";
  }
}

export interface RotatingFileSinkOptions {
  readonly path: string;
  /** Rotate once the active file would exceed this many bytes. Default 5 MiB. */
  readonly maxBytes?: number;
  /** Keep this many rotated files (`path.1` … `path.N`). Default 3. */
  readonly maxFiles?: number;
  /** Override the on-disk line format. Default JSON line. */
  readonly format?: (record: LogRecord) => string;
  /** Notified when a line fails to reach disk (disk full, perms, missing dir). Lets a host
   *  observe log loss that flush()/close() otherwise hide — they still resolve, because a
   *  logging sink must never throw into its callers. */
  readonly onError?: (error: Error, droppedTotal: number) => void;
}

/** Appends JSON lines to a file, rotating `path` → `path.1` … `path.N` by size. Writes are
 *  serialized on an internal queue so order + the byte counter stay consistent. */
export class RotatingFileSink implements Sink {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly format: (record: LogRecord) => string;
  private readonly onError: ((error: Error, droppedTotal: number) => void) | undefined;
  private tail: Promise<void> = Promise.resolve();
  private currentBytes: number | undefined;
  private droppedWrites = 0;

  constructor(options: RotatingFileSinkOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, options.maxFiles ?? 3);
    this.format = options.format ?? jsonLine;
    this.onError = options.onError;
  }

  /** Count of log lines lost to write failures. Non-zero ⇒ the log is incomplete even though
   *  flush()/close() resolved (a sink must not throw into its callers). */
  get dropped(): number {
    return this.droppedWrites;
  }

  write(record: LogRecord): void {
    const line = `${this.format(record)}\n`;
    this.tail = this.tail.then(() => this.appendLine(line)).catch((error) => {
      this.droppedWrites += 1;
      this.onError?.(error instanceof Error ? error : new Error(String(error)), this.droppedWrites);
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private async appendLine(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (this.currentBytes === undefined) this.currentBytes = await fileSize(this.path);
    const bytes = Buffer.byteLength(line);
    if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes) {
      await this.rotate();
      this.currentBytes = 0;
    }
    await appendFile(this.path, line, { mode: 0o600 });
    this.currentBytes += bytes;
  }

  private async rotate(): Promise<void> {
    await rm(`${this.path}.${this.maxFiles}`, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      await rename(`${this.path}.${i}`, `${this.path}.${i + 1}`).catch(() => {});
    }
    await rename(this.path, `${this.path}.1`).catch(() => {});
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Fans one record out to several sinks. */
export class MultiSink implements Sink {
  private readonly sinks: readonly Sink[];
  constructor(sinks: readonly Sink[]) {
    this.sinks = sinks;
  }
  write(record: LogRecord): void {
    for (const sink of this.sinks) sink.write(record);
  }
  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush()));
  }
  async close(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.close()));
  }
}
