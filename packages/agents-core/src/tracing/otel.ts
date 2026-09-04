import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span as OTelSpan,
  type Tracer,
} from "@opentelemetry/api";
import type { ImageContent, Message, TextContent, ThinkingContent, ToolCall } from "../protocol/index.ts";
import { redactDeep, type RedactOptions } from "../logging/redact.ts";
import type { ToolResult } from "../tool/types.ts";
import type { Span, Trace } from "./spans.ts";
import type { TracingContentMode, TracingProcessor } from "./processor.ts";

export interface FlushableTracerProvider {
  forceFlush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

export interface OTelTracingProcessorOptions {
  readonly tracer?: Tracer;
  readonly tracerProvider?: FlushableTracerProvider;
  readonly tracerName?: string;
  readonly tracerVersion?: string;
  readonly providerName?: string;
  readonly includeFrameworkIds?: boolean;
  readonly recordException?: boolean;
  readonly shutdownProvider?: boolean;
  /**
   * Attach conversation content (system prompt, messages, tool args/results) as span attributes.
   * Default `"none"`. See `TracingContentMode`; the bridge reads this off the processor.
   */
  readonly content?: TracingContentMode;
  /** Per-attribute cap for serialized content; longer values are cut with a marker. Default 32 000. */
  readonly contentMaxChars?: number;
  /**
   * Run content through `redactDeep` (tokens, emails, JWTs…) before it becomes an attribute.
   * Default `false`: this processor is for a LOCAL collector where the raw prompt is the point.
   * Set it when the exporter leaves the machine.
   */
  readonly redact?: boolean | RedactOptions;
}

const DEFAULT_CONTENT_MAX_CHARS = 32_000;

export class OTelTracingProcessor implements TracingProcessor {
  private readonly tracer: Tracer;
  private readonly tracerProvider: FlushableTracerProvider | undefined;
  private readonly providerName: string | undefined;
  private readonly includeFrameworkIds: boolean;
  private readonly recordException: boolean;
  private readonly shutdownProvider: boolean;
  readonly content: TracingContentMode;
  private readonly contentMaxChars: number;
  private readonly redactOptions: RedactOptions | undefined;
  private readonly activeTraces = new Map<string, { name: string; groupId: string | null; metadata?: Record<string, unknown> }>();
  private readonly activeSpans = new Map<string, { span: OTelSpan; context: Context }>();

  constructor(options: OTelTracingProcessorOptions = {}) {
    this.tracer = options.tracer ?? trace.getTracer(options.tracerName ?? "agent-framework", options.tracerVersion);
    this.tracerProvider = options.tracerProvider;
    this.providerName = options.providerName;
    this.includeFrameworkIds = options.includeFrameworkIds ?? true;
    this.recordException = options.recordException ?? true;
    this.shutdownProvider = options.shutdownProvider ?? false;
    this.content = options.content ?? "none";
    this.contentMaxChars = options.contentMaxChars ?? DEFAULT_CONTENT_MAX_CHARS;
    this.redactOptions = options.redact === undefined || options.redact === false ? undefined : options.redact === true ? {} : options.redact;
  }

  onTraceStart(traceRecord: Trace): void {
    this.activeTraces.set(traceRecord.traceId, {
      name: traceRecord.name,
      groupId: traceRecord.groupId,
      metadata: traceRecord.metadata,
    });
  }

  onTraceEnd(traceRecord: Trace): void {
    this.activeTraces.delete(traceRecord.traceId);
  }

  onSpanStart(span: Span): void {
    const traceRecord = this.activeTraces.get(span.traceId);
    const parent = span.parentId === null ? undefined : this.activeSpans.get(span.parentId);
    const parentContext = parent?.context ?? ROOT_CONTEXT;
    const attributes = this.attributesFor(span, traceRecord, "start");
    const otelSpan = this.tracer.startSpan(
      this.nameFor(span.data),
      {
        attributes,
        kind: SpanKind.INTERNAL,
        startTime: span.startedAt ?? undefined,
      },
      parentContext,
    );
    this.activeSpans.set(span.spanId, {
      span: otelSpan,
      context: trace.setSpan(parentContext, otelSpan),
    });
  }

  onSpanEnd(span: Span): void {
    const active = this.activeSpans.get(span.spanId);
    if (active === undefined) return;
    const traceRecord = this.activeTraces.get(span.traceId);
    active.span.setAttributes(this.attributesFor(span, traceRecord, "end"));
    active.span.updateName(this.nameFor(span.data));
    for (const event of span.events) {
      active.span.addEvent(event.name, event.data === undefined ? undefined : this.primitiveAttributes("", event.data), event.timestamp);
    }
    if (span.error !== null) {
      active.span.setStatus({ code: SpanStatusCode.ERROR, message: span.error.message });
      active.span.setAttribute("error.type", span.error.data?.type === undefined ? "Error" : String(span.error.data.type));
      if (this.recordException) active.span.recordException({ name: "Error", message: span.error.message });
    } else {
      active.span.setStatus({ code: SpanStatusCode.OK });
    }
    active.span.end(span.endedAt ?? undefined);
    this.activeSpans.delete(span.spanId);
  }

  async forceFlush(): Promise<void> {
    const provider = this.tracerProvider ?? flushableProvider(trace.getTracerProvider());
    const forceFlush = provider?.forceFlush;
    if (forceFlush !== undefined) await forceFlush.call(provider);
  }

  async shutdown(): Promise<void> {
    for (const [id, active] of [...this.activeSpans.entries()]) {
      active.span.setStatus({ code: SpanStatusCode.ERROR, message: "Tracing processor shutdown before span ended" });
      active.span.end();
      this.activeSpans.delete(id);
    }
    this.activeTraces.clear();
    const provider = this.tracerProvider ?? flushableProvider(trace.getTracerProvider());
    const shutdown = provider?.shutdown;
    if (this.shutdownProvider && shutdown !== undefined) {
      await shutdown.call(provider);
    } else {
      await this.forceFlush();
    }
  }

  private attributesFor(span: Span, traceRecord: { name: string; groupId: string | null; metadata?: Record<string, unknown> } | undefined, phase: "start" | "end"): Attributes {
    return {
      ...(this.includeFrameworkIds
        ? {
            "agent_framework.trace_id": span.traceId,
            "agent_framework.span_id": span.spanId,
            ...(span.parentId === null ? {} : { "agent_framework.parent_id": span.parentId }),
          }
        : {}),
      ...(traceRecord === undefined
        ? {}
        : {
            "agent_framework.trace.name": traceRecord.name,
            ...(traceRecord.groupId === null ? {} : { "gen_ai.conversation.id": traceRecord.groupId }),
            ...this.primitiveAttributes("agent_framework.trace.metadata", traceRecord.metadata),
          }),
      "agent_framework.span.type": span.data.type,
      "agent_framework.span.phase": phase,
      ...this.genAiAttributes(span.data),
      ...(this.content === "none" ? {} : this.contentAttributes(span.data)),
    };
  }

  private genAiAttributes(data: Span["data"]): Attributes {
    const provider = this.providerName === undefined ? {} : { "gen_ai.provider.name": this.providerName };
    switch (data.type) {
      case "agent":
        return {
          ...provider,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": data.name,
          ...(data.handoffs === undefined ? {} : { "agent_framework.agent.handoffs": [...data.handoffs] }),
          ...(data.tools === undefined ? {} : { "agent_framework.agent.tools": [...data.tools] }),
          ...(data.prompt === undefined ? {} : { "agent_framework.agent.prompt": data.prompt }),
        };
      case "turn":
        return {
          ...provider,
          "agent_framework.turn.id": data.turnId,
          ...(data.reason === undefined ? {} : { "agent_framework.turn.reason": data.reason }),
        };
      case "generation":
        return {
          ...provider,
          "gen_ai.operation.name": "chat",
          ...(data.model === undefined
            ? {}
            : {
                "gen_ai.request.model": data.model,
                "gen_ai.response.model": data.model,
              }),
          ...(data.responseId === undefined ? {} : { "gen_ai.response.id": data.responseId }),
          ...(data.stopReason === undefined
            ? {}
            : {
                "gen_ai.response.finish_reasons": [data.stopReason],
                "agent_framework.generation.stop_reason": data.stopReason,
              }),
          ...(data.usage?.input_tokens === undefined ? {} : { "gen_ai.usage.input_tokens": data.usage.input_tokens }),
          ...(data.usage?.output_tokens === undefined ? {} : { "gen_ai.usage.output_tokens": data.usage.output_tokens }),
          ...(data.usage?.total_tokens === undefined ? {} : { "agent_framework.usage.total_tokens": data.usage.total_tokens }),
          ...(data.usage?.cache_read_tokens === undefined ? {} : { "gen_ai.usage.cache_read.input_tokens": data.usage.cache_read_tokens }),
          ...(data.usage?.cache_write_tokens === undefined ? {} : { "gen_ai.usage.cache_creation.input_tokens": data.usage.cache_write_tokens }),
          ...(data.usage?.reasoning_tokens === undefined ? {} : { "agent_framework.usage.reasoning_tokens": data.usage.reasoning_tokens }),
          ...(data.usage?.cost_usd === undefined ? {} : { "agent_framework.usage.cost_usd": data.usage.cost_usd }),
          ...(data.toolNames === undefined ? {} : { "agent_framework.generation.tools": [...data.toolNames] }),
          ...(data.params?.temperature === undefined ? {} : { "gen_ai.request.temperature": data.params.temperature }),
          ...(data.params?.maxTokens === undefined ? {} : { "gen_ai.request.max_tokens": data.params.maxTokens }),
          ...(data.params?.thinking === undefined ? {} : { "agent_framework.generation.thinking": String(data.params.thinking) }),
        };
      case "tool":
        return {
          ...provider,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": data.name,
          "agent_framework.tool.call_id": data.toolCallId,
          ...(data.isError === undefined ? {} : { "agent_framework.tool.is_error": data.isError }),
        };
      case "message":
        return {
          ...provider,
          "agent_framework.message.role": data.role,
          ...(data.origin === undefined ? {} : { "agent_framework.message.origin": data.origin }),
        };
      case "handoff":
        return {
          ...provider,
          "gen_ai.operation.name": "invoke_agent",
          ...(data.from === undefined ? {} : { "agent_framework.handoff.from": data.from }),
          ...(data.to === undefined ? {} : { "agent_framework.handoff.to": data.to }),
        };
      case "compaction":
        return {
          "agent_framework.compaction.trigger": data.trigger ?? "unknown",
          ...(data.tokensBefore === undefined ? {} : { "agent_framework.compaction.tokens_before": data.tokensBefore }),
          ...(data.tokensAfter === undefined ? {} : { "agent_framework.compaction.tokens_after": data.tokensAfter }),
          ...(data.compactedCount === undefined ? {} : { "agent_framework.compaction.compacted_count": data.compactedCount }),
        };
      case "custom":
        return {
          "agent_framework.custom.name": data.name,
          ...this.primitiveAttributes("agent_framework.custom.data", data.data),
        };
    }
  }

  /**
   * Content attributes, named after the OTel GenAI semantic conventions where one exists
   * (`gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`,
   * `gen_ai.tool.call.arguments` / `.result`). Values are JSON strings, capped at
   * `contentMaxChars`; images are reduced to `{ type, mimeType, bytes }`.
   */
  private contentAttributes(data: Span["data"]): Attributes {
    switch (data.type) {
      case "generation":
        return {
          ...(data.system === undefined ? {} : { "gen_ai.system_instructions": this.text(data.system) }),
          ...(data.input === undefined ? {} : { "gen_ai.input.messages": this.json(data.input.map(serializeMessage)) }),
          ...(data.inputMode === undefined ? {} : { "agent_framework.generation.input_mode": data.inputMode }),
          ...(data.output === undefined ? {} : { "gen_ai.output.messages": this.json(data.output.map(serializePart)) }),
        };
      case "tool":
        return {
          ...(data.args === undefined ? {} : { "gen_ai.tool.call.arguments": this.json(data.args) }),
          ...(data.result === undefined ? {} : { "gen_ai.tool.call.result": this.json(serializeToolResult(data.result)) }),
        };
      case "message":
        return data.content === undefined
          ? {}
          : { "agent_framework.message.content": this.json(typeof data.content === "string" ? data.content : data.content.map(serializePart)) };
      default:
        return {};
    }
  }

  private text(value: string): string {
    const redacted = this.redactOptions === undefined ? value : String(redactDeep(value, this.redactOptions));
    return truncate(redacted, this.contentMaxChars);
  }

  private json(value: unknown): string {
    const redacted = this.redactOptions === undefined ? value : redactDeep(value, this.redactOptions);
    let serialized: string;
    try {
      serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
    } catch {
      serialized = String(redacted);
    }
    return truncate(serialized ?? "null", this.contentMaxChars);
  }

  private primitiveAttributes(prefix: string, data: Record<string, unknown> | undefined): Attributes {
    if (data === undefined) return {};
    const attributes: Record<string, AttributeValue> = {};
    for (const [key, value] of Object.entries(data)) {
      if (isAttributeValue(value)) attributes[prefix === "" ? key : `${prefix}.${key}`] = value;
    }
    return attributes;
  }

  private nameFor(data: Span["data"]): string {
    switch (data.type) {
      case "agent":
        return data.prompt === undefined ? `agent ${data.name}` : `agent ${data.name}: ${data.prompt}`;
      case "turn":
        return `turn ${data.turnId}`;
      case "generation":
        return data.model === undefined ? "gen_ai chat" : `gen_ai chat ${data.model}`;
      case "tool":
        return `tool ${data.name}`;
      case "message":
        return `${data.role} message`;
      case "handoff":
        return data.to === undefined ? "handoff" : `handoff ${data.to}`;
      case "compaction":
        return "compaction";
      case "custom":
        return data.name;
    }
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

type SerializedPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string; readonly redacted?: boolean }
  | { readonly type: "toolCall"; readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }
  | { readonly type: "image"; readonly mimeType: string; readonly bytes: number };

function serializePart(part: TextContent | ThinkingContent | ToolCall | ImageContent): SerializedPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "thinking":
      return { type: "thinking", thinking: part.thinking, ...(part.redacted === true ? { redacted: true } : {}) };
    case "toolCall":
      return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
    case "image":
      return { type: "image", mimeType: part.mimeType, bytes: Math.floor((part.data.length * 3) / 4) };
  }
}

function serializeMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: typeof message.content === "string" ? message.content : message.content.map(serializePart) };
    case "assistant":
      return {
        role: "assistant",
        model: message.model,
        content: message.content.map(serializePart),
        ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
      };
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        content: message.content.map(serializePart),
      };
  }
}

function serializeToolResult(result: ToolResult): Record<string, unknown> {
  return {
    content: result.content.map(serializePart),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.details === undefined ? {} : { details: result.details }),
  };
}

function isAttributeValue(value: unknown): value is AttributeValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

function flushableProvider(provider: unknown): FlushableTracerProvider | undefined {
  if (provider === null || typeof provider !== "object") return undefined;
  return provider as FlushableTracerProvider;
}
