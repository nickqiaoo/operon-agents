// Tracing to Langfuse. The framework already produces an OpenTelemetry span tree per run --
// agent → turn → generation | tool | message, one trace per prompt, the session id on every
// span -- with the GenAI semantic-convention attributes Langfuse reads (model, token usage,
// the messages, tool arguments and results). What this file adds is the transport
// (`LangfuseSpanProcessor`: OTLP over HTTP with the project's keys) and the two things Langfuse
// cannot infer: which of its observation types each span is, and the session id under its own
// attribute name, so one Linear issue's runs read as one Langfuse session.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Context } from "@opentelemetry/api";
import { NodeTracerProvider, type Span, type SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTelTracingProcessor, type TracingContentMode } from "operon-agents";

export interface LangfuseOptions {
  readonly publicKey: string;
  readonly secretKey: string;
  /** The Langfuse instance. The SDK's default is the EU cloud. */
  readonly baseUrl?: string;
  /**
   * How much of the conversation the spans carry. `delta` (the default): the system prompt,
   * the messages each model call was asked to answer, its output, tool arguments and results
   * -- a conversation replays in the trace viewer. `none`: names, timings and usage only.
   * `full`: the whole context on every call; for debugging prompt assembly.
   */
  readonly content?: TracingContentMode;
}

/** `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` switch tracing on; nothing else is required. */
export function langfuseFromEnv(env: NodeJS.ProcessEnv = process.env): LangfuseOptions | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return undefined;
  const content = env.LANGFUSE_TRACE_CONTENT || undefined;
  if (content !== undefined && content !== "none" && content !== "delta" && content !== "full") {
    throw new Error(`LANGFUSE_TRACE_CONTENT must be none, delta or full (got "${content}")`);
  }
  return {
    publicKey,
    secretKey,
    ...(env.LANGFUSE_BASE_URL ? { baseUrl: env.LANGFUSE_BASE_URL } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

export const LANGFUSE_DEFAULT_BASE_URL = "https://cloud.langfuse.com";

/** The tracing processor to register on the harness (`T.Tracing`); every session drives it. */
export function langfuseTracing(options: LangfuseOptions): OTelTracingProcessor {
  return otelTracing([langfuseAttributes(), langfuseExporter(options)], options);
}

/** The transport: batches spans and posts them to the project. Flushed on shutdown. */
export function langfuseExporter(options: LangfuseOptions): SpanProcessor {
  return new LangfuseSpanProcessor({
    publicKey: options.publicKey,
    secretKey: options.secretKey,
    baseUrl: options.baseUrl ?? LANGFUSE_DEFAULT_BASE_URL,
    // Every span on this provider is the agent's; the SDK's default filter keeps spans that
    // carry a `gen_ai.*` attribute, which is all of them, but say so rather than rely on it.
    shouldExportSpan: () => true,
  });
}

/**
 * The framework's OTel processor over a provider that ends in `sinks`, in order. Shutting the
 * processor down (the harness does, when it closes) flushes and shuts the provider down.
 */
export function otelTracing(sinks: readonly SpanProcessor[], options: { readonly content?: TracingContentMode } = {}): OTelTracingProcessor {
  const provider = new NodeTracerProvider({ spanProcessors: [...sinks] });
  return new OTelTracingProcessor({
    tracer: provider.getTracer("linear-github"),
    tracerProvider: provider,
    shutdownProvider: true,
    content: options.content ?? "delta",
    // The spans leave this machine: tokens, keys and email addresses in prompts, tool output
    // and results are masked before they do.
    redact: true,
  });
}

/** The framework's span types as Langfuse observation types. */
const OBSERVATION_TYPE: Readonly<Record<string, string>> = {
  agent: "agent",
  turn: "chain",
  generation: "generation",
  tool: "tool",
  message: "event",
  handoff: "event",
  compaction: "span",
  custom: "span",
};

/**
 * Stamps the Langfuse attributes on each span as it starts, from what the framework put there:
 * `langfuse.observation.type` from the span type (a generation is a generation, not a span
 * with a model on it), `langfuse.session.id` from `gen_ai.conversation.id` (the framework
 * session, which here is the Linear session), and for a message span -- a prompt, a reminder
 * the framework injected, a cron fire -- its content as the observation's input, since the
 * GenAI conventions have no name for a transcript message outside a model call. Model calls
 * and tool calls need nothing: Langfuse reads their `gen_ai.*` attributes as they are.
 */
export function langfuseAttributes(): SpanProcessor {
  return {
    onStart(span: Span, _parent: Context): void {
      const type = span.attributes["operon_agents.span.type"];
      const observation = typeof type === "string" ? OBSERVATION_TYPE[type] : undefined;
      if (observation !== undefined) span.setAttribute("langfuse.observation.type", observation);
      const session = span.attributes["gen_ai.conversation.id"];
      if (typeof session === "string") span.setAttribute("langfuse.session.id", session);
      const message = span.attributes["operon_agents.message.content"];
      if (typeof message === "string") span.setAttribute("langfuse.observation.input", message);
    },
    onEnd(): void {},
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
