import { redactDeep, type RedactOptions } from "../logging/redact.ts";
import type { Span, SpanRecord, Trace, TraceRecord } from "./spans.ts";

export type TraceOrSpan = Trace | Span;

export interface TracingProcessor {
  onTraceStart(trace: Trace): void | Promise<void>;
  onTraceEnd(trace: Trace): void | Promise<void>;
  onSpanStart(span: Span): void | Promise<void>;
  onSpanEnd(span: Span): void | Promise<void>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TracingExporter {
  export(items: readonly (TraceRecord | SpanRecord)[]): void | Promise<void>;
}

export class ConsoleSpanExporter implements TracingExporter {
  private readonly write: (line: string) => void;
  constructor(write: (line: string) => void = (line) => console.error(line)) {
    this.write = write;
  }
  export(items: readonly (TraceRecord | SpanRecord)[]): void {
    for (const item of items) {
      if (item.object === "trace") {
        this.write(`[trace] ${item.id} "${item.name}"${item.group_id ? ` group=${item.group_id}` : ""}`);
      } else {
        const dur = item.started_at !== null && item.ended_at !== null ? `${item.ended_at - item.started_at}ms` : "—";
        const err = item.error ? ` error="${item.error.message}"` : "";
        this.write(`[span] ${item.span_data.type} ${item.id} parent=${item.parent_id ?? "·"} ${dur}${err}`);
      }
    }
  }
}

export interface BatchTracingProcessorOptions {
  readonly maxQueueSize?: number;
  readonly maxBatchSize?: number;
  readonly scheduleDelayMs?: number;
  readonly redact?: boolean | RedactOptions;
}

export class BatchTracingProcessor implements TracingProcessor {
  private readonly exporter: TracingExporter;
  private readonly maxQueueSize: number;
  private readonly maxBatchSize: number;
  private readonly scheduleDelayMs: number;
  private readonly redactOptions: RedactOptions | undefined;
  private buffer: TraceOrSpan[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private droppedCount = 0;

  constructor(exporter: TracingExporter, options: BatchTracingProcessorOptions = {}) {
    this.exporter = exporter;
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.scheduleDelayMs = options.scheduleDelayMs ?? 5000;
    this.redactOptions = options.redact === false ? undefined : typeof options.redact === "object" ? options.redact : {};
    if (this.scheduleDelayMs > 0) {
      this.timer = setInterval(() => void this.forceFlush().catch(() => {}), this.scheduleDelayMs);
      this.timer.unref?.();
    }
  }

  get dropped(): number {
    return this.droppedCount;
  }

  onTraceStart(trace: Trace): void {
    this.enqueue(trace);
  }
  onTraceEnd(): void {
    // Traces export on start (identity is known up front); nothing to do on end.
  }
  onSpanStart(): void {
    // Spans export on end (so duration/usage/error are populated).
  }
  onSpanEnd(span: Span): void {
    this.enqueue(span);
  }

  private enqueue(item: TraceOrSpan): void {
    if (this.buffer.length >= this.maxQueueSize) {
      this.droppedCount += 1;
      return;
    }
    this.buffer.push(item);
    if (this.buffer.length >= this.maxBatchSize) void this.forceFlush().catch(() => {});
  }

  async forceFlush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const records = batch.map((item) => {
      const record = item.toJSON();
      return this.redactOptions ? redactDeep(record, this.redactOptions) : record;
    });
    await this.exporter.export(records);
  }

  async shutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.forceFlush();
  }
}

export const noopTracingProcessor: TracingProcessor = {
  onTraceStart() {},
  onTraceEnd() {},
  onSpanStart() {},
  onSpanEnd() {},
  async forceFlush() {},
  async shutdown() {},
};

export function consoleTracingProcessor(options?: BatchTracingProcessorOptions): BatchTracingProcessor {
  return new BatchTracingProcessor(new ConsoleSpanExporter(), options);
}
