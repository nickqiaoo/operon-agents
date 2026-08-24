export interface GenerationUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
}

export type SpanData =
  | { readonly type: "agent"; readonly name: string; readonly handoffs?: readonly string[]; readonly tools?: readonly string[] }
  | { readonly type: "turn"; readonly turnId: string }
  | {
      readonly type: "generation";
      readonly model?: string;
      readonly responseId?: string;
      readonly stopReason?: string;
      readonly usage?: GenerationUsage;
    }
  | { readonly type: "tool"; readonly name: string; readonly toolCallId: string; readonly isError?: boolean }
  | { readonly type: "handoff"; readonly from?: string; readonly to?: string }
  | { readonly type: "compaction"; readonly trigger?: string; readonly tokensBefore?: number; readonly tokensAfter?: number; readonly compactedCount?: number }
  | { readonly type: "custom"; readonly name: string; readonly data?: Record<string, unknown> };

export type SpanType = SpanData["type"];

export interface SpanError {
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface SpanRecord {
  readonly object: "trace.span";
  readonly id: string;
  readonly trace_id: string;
  readonly parent_id: string | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly span_data: SpanData;
  readonly error: SpanError | null;
}

export interface TraceRecord {
  readonly object: "trace";
  readonly id: string;
  readonly group_id: string | null;
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
}

let spanCounter = 0;
let traceCounter = 0;

export function newTraceId(seed: number): string {
  traceCounter += 1;
  return `trace_${seed.toString(36)}${traceCounter.toString(36)}`;
}
export function newSpanId(seed: number): string {
  spanCounter += 1;
  return `span_${seed.toString(36)}${spanCounter.toString(36)}`;
}

export class Span<T extends SpanData = SpanData> {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId: string | null;
  startedAt: number | null = null;
  endedAt: number | null = null;
  error: SpanError | null = null;
  data: T;

  constructor(args: { traceId: string; spanId: string; parentId: string | null; data: T }) {
    this.traceId = args.traceId;
    this.spanId = args.spanId;
    this.parentId = args.parentId;
    this.data = args.data;
  }

  get type(): SpanType {
    return this.data.type;
  }

  toJSON(): SpanRecord {
    return {
      object: "trace.span",
      id: this.spanId,
      trace_id: this.traceId,
      parent_id: this.parentId,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      span_data: this.data,
      error: this.error,
    };
  }
}

export class Trace {
  readonly traceId: string;
  readonly groupId: string | null;
  name: string;
  metadata?: Record<string, unknown>;

  constructor(args: { traceId: string; name: string; groupId?: string | null; metadata?: Record<string, unknown> }) {
    this.traceId = args.traceId;
    this.name = args.name;
    this.groupId = args.groupId ?? null;
    this.metadata = args.metadata;
  }

  toJSON(): TraceRecord {
    return { object: "trace", id: this.traceId, group_id: this.groupId, name: this.name, metadata: this.metadata };
  }
}
