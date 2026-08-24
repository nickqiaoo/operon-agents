import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span as OTelSpan,
  type Tracer,
} from "@opentelemetry/api";
import type { Span, SpanData, Trace } from "./spans.ts";
import type { TracingProcessor } from "./processor.ts";

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
}

interface ActiveSpan {
  readonly span: OTelSpan;
  readonly context: Context;
}

interface ActiveTrace {
  readonly name: string;
  readonly groupId: string | null;
  readonly metadata?: Record<string, unknown>;
}

export class OTelTracingProcessor implements TracingProcessor {
  private readonly tracer: Tracer;
  private readonly tracerProvider: FlushableTracerProvider | undefined;
  private readonly providerName: string | undefined;
  private readonly includeFrameworkIds: boolean;
  private readonly recordException: boolean;
  private readonly shutdownProvider: boolean;
  private readonly activeTraces = new Map<string, ActiveTrace>();
  private readonly activeSpans = new Map<string, ActiveSpan>();

  constructor(options: OTelTracingProcessorOptions = {}) {
    this.tracer = options.tracer ?? trace.getTracer(options.tracerName ?? "agent-framework", options.tracerVersion);
    this.tracerProvider = options.tracerProvider;
    this.providerName = options.providerName;
    this.includeFrameworkIds = options.includeFrameworkIds ?? true;
    this.recordException = options.recordException ?? true;
    this.shutdownProvider = options.shutdownProvider ?? false;
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

  private attributesFor(span: Span, traceRecord: ActiveTrace | undefined, phase: "start" | "end"): Attributes {
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
            ...metadataAttributes(traceRecord.metadata),
          }),
      "agent_framework.span.type": span.data.type,
      "agent_framework.span.phase": phase,
      ...this.genAiAttributes(span.data),
    };
  }

  private genAiAttributes(data: SpanData): Attributes {
    const provider = this.providerName === undefined ? {} : { "gen_ai.provider.name": this.providerName };

    switch (data.type) {
      case "agent":
        return {
          ...provider,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": data.name,
          ...(data.handoffs === undefined ? {} : { "agent_framework.agent.handoffs": [...data.handoffs] }),
          ...(data.tools === undefined ? {} : { "agent_framework.agent.tools": [...data.tools] }),
        };
      case "turn":
        return {
          ...provider,
          "agent_framework.turn.id": data.turnId,
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
        };
      case "tool":
        return {
          ...provider,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": data.name,
          "agent_framework.tool.call_id": data.toolCallId,
          ...(data.isError === undefined ? {} : { "agent_framework.tool.is_error": data.isError }),
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
          ...customDataAttributes(data.data),
        };
    }
  }

  private nameFor(data: SpanData): string {
    switch (data.type) {
      case "agent":
        return `agent ${data.name}`;
      case "turn":
        return `turn ${data.turnId}`;
      case "generation":
        return data.model === undefined ? "gen_ai chat" : `gen_ai chat ${data.model}`;
      case "tool":
        return `tool ${data.name}`;
      case "handoff":
        return data.to === undefined ? "handoff" : `handoff ${data.to}`;
      case "compaction":
        return "compaction";
      case "custom":
        return data.name;
    }
  }
}

function metadataAttributes(metadata: Record<string, unknown> | undefined): Attributes {
  if (metadata === undefined) return {};
  return prefixedPrimitiveAttributes("agent_framework.trace.metadata", metadata);
}

function customDataAttributes(data: Record<string, unknown> | undefined): Attributes {
  if (data === undefined) return {};
  return prefixedPrimitiveAttributes("agent_framework.custom.data", data);
}

function prefixedPrimitiveAttributes(prefix: string, data: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(data)) {
    if (isAttributeValue(value)) attributes[`${prefix}.${key}`] = value;
  }
  return attributes;
}

function isAttributeValue(value: unknown): value is Attributes[string] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

function flushableProvider(provider: unknown): FlushableTracerProvider | undefined {
  if (provider === null || typeof provider !== "object") return undefined;
  return provider as FlushableTracerProvider;
}
