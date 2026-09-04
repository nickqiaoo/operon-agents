import type { ImageContent, Message, TextContent, ThinkingContent, ToolCall } from "../protocol/index.ts";
import type { ModelSettings } from "../llm/model.ts";
import type { ToolResult } from "../tool/types.ts";

export interface GenerationUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
  readonly cost_usd?: number;
}

/** Which request messages a generation span carries (see `TracingContentMode`). */
export type GenerationInputMode = "delta" | "full";

/**
 * The content parts a generation produced. Same shape as `AssistantMessage.content` — text,
 * thinking and tool calls, in model order.
 */
export type GenerationOutputPart = TextContent | ThinkingContent | ToolCall;

/**
 * Span payloads. The `type` discriminates; everything else is what the exporter needs to name,
 * measure and (with content enabled) replay the span. Content fields (`system`, `input`,
 * `output`, `args`, `result`, `content`) hold RAW references — the bridge attaches them only
 * when the processor opts in via `content`, and exporters serialize/cap them on the way out.
 */
export type SpanData =
  | {
      readonly type: "agent";
      readonly name: string;
      readonly handoffs?: readonly string[];
      readonly tools?: readonly string[];
      /** First user prompt of the run, trimmed to a line — names the root span in a trace list (content only). */
      readonly prompt?: string;
    }
  | {
      readonly type: "turn";
      readonly turnId: string;
      /** From `turn.ended`. */
      readonly reason?: string;
      readonly error?: string;
    }
  | {
      readonly type: "generation";
      readonly model?: string;
      readonly responseId?: string;
      readonly stopReason?: string;
      readonly usage?: GenerationUsage;
      // ── content (only with `content` enabled) ──
      /** System prompt as the model received it (after every hook). */
      readonly system?: string;
      /** Tool names offered on this request. */
      readonly toolNames?: readonly string[];
      readonly params?: ModelSettings;
      /** Request messages: everything since the previous assistant message (`delta`) or the whole context (`full`). */
      readonly input?: readonly Message[];
      readonly inputMode?: GenerationInputMode;
      /** What the model produced this step. */
      readonly output?: readonly GenerationOutputPart[];
    }
  | {
      readonly type: "tool";
      readonly name: string;
      readonly toolCallId: string;
      readonly isError?: boolean;
      // ── content ──
      readonly args?: unknown;
      readonly result?: ToolResult;
    }
  /** A non-model message entering the transcript (user prompt, injection, cron…). Instant span. */
  | {
      readonly type: "message";
      readonly role: "user";
      /** `PromptOrigin.kind` when the event carried one. */
      readonly origin?: string;
      // ── content ──
      readonly content?: string | readonly (TextContent | ImageContent)[];
    }
  | { readonly type: "handoff"; readonly from?: string; readonly to?: string }
  | { readonly type: "compaction"; readonly trigger?: string; readonly tokensBefore?: number; readonly tokensAfter?: number; readonly compactedCount?: number }
  | { readonly type: "custom"; readonly name: string; readonly data?: Record<string, unknown> };

export type SpanType = SpanData["type"];

export interface SpanError {
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

/** A point-in-time annotation on a span (a retry, a reset) — OTel span events, Jaeger "logs". */
export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
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
  readonly events?: readonly SpanEvent[];
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
  events: SpanEvent[] = [];

  constructor(args: { traceId: string; spanId: string; parentId: string | null; data: T }) {
    this.traceId = args.traceId;
    this.spanId = args.spanId;
    this.parentId = args.parentId;
    this.data = args.data;
  }

  get type(): SpanType {
    return this.data.type;
  }

  addEvent(name: string, timestamp: number, data?: Record<string, unknown>): void {
    this.events.push(data === undefined ? { name, timestamp } : { name, timestamp, data });
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
      ...(this.events.length > 0 ? { events: this.events } : {}),
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
