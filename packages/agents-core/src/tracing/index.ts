export { Span, Trace, newSpanId, newTraceId } from "./spans.ts";
export type { SpanData, SpanType, SpanError, SpanRecord, TraceRecord, GenerationUsage } from "./spans.ts";
export {
  BatchTracingProcessor,
  ConsoleSpanExporter,
  consoleTracingProcessor,
  noopTracingProcessor,
} from "./processor.ts";
export type { TracingProcessor, TracingExporter, BatchTracingProcessorOptions, TraceOrSpan } from "./processor.ts";
export { eventSinkTracingBridge } from "./bridge.ts";
export type { TracingBridgeOptions } from "./bridge.ts";
export { OTelTracingProcessor } from "./otel.ts";
export type { FlushableTracerProvider, OTelTracingProcessorOptions } from "./otel.ts";
