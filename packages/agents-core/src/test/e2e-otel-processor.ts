import { SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { OTelTracingProcessor, Span, Trace } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function start(span: Span, at: number, processor: OTelTracingProcessor): void {
  span.startedAt = at;
  processor.onSpanStart(span);
}

function end(span: Span, at: number, processor: OTelTracingProcessor): void {
  span.endedAt = at;
  processor.onSpanEnd(span);
}

async function main(): Promise<void> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

  const processor = new OTelTracingProcessor({
    tracer: provider.getTracer("agent-framework-test"),
    tracerProvider: provider,
    providerName: "anthropic",
  });

  const traceRecord = new Trace({
    traceId: "trace_test_1",
    name: "main",
    groupId: "session-1",
    metadata: { env: "test", ignoredNested: { x: 1 } },
  });
  processor.onTraceStart(traceRecord);

  const agent = new Span({
    traceId: traceRecord.traceId,
    spanId: "span_agent",
    parentId: null,
    data: { type: "agent", name: "main", tools: ["Bash"] },
  });
  start(agent, 10, processor);

  const turn = new Span({
    traceId: traceRecord.traceId,
    spanId: "span_turn",
    parentId: agent.spanId,
    data: { type: "turn", turnId: "turn-1" },
  });
  start(turn, 20, processor);

  const generation = new Span({
    traceId: traceRecord.traceId,
    spanId: "span_generation",
    parentId: turn.spanId,
    data: { type: "generation" },
  });
  start(generation, 30, processor);
  generation.data = {
    type: "generation",
    model: "claude-test",
    responseId: "resp-1",
    stopReason: "end_turn",
    usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
  };
  end(generation, 60, processor);

  const tool = new Span({
    traceId: traceRecord.traceId,
    spanId: "span_tool",
    parentId: turn.spanId,
    data: { type: "tool", name: "Bash", toolCallId: "tool-1" },
  });
  start(tool, 70, processor);
  tool.data = { type: "tool", name: "Bash", toolCallId: "tool-1", isError: true };
  tool.error = { message: "command failed", data: { type: "ToolError" } };
  end(tool, 90, processor);

  end(turn, 100, processor);
  end(agent, 110, processor);
  processor.onTraceEnd(traceRecord);
  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  const byFrameworkId = new Map<string, ReadableSpan>();
  for (const span of spans) byFrameworkId.set(String(span.attributes["agent_framework.span_id"]), span);

  const otelAgent = byFrameworkId.get("span_agent");
  const otelTurn = byFrameworkId.get("span_turn");
  const otelGeneration = byFrameworkId.get("span_generation");
  const otelTool = byFrameworkId.get("span_tool");

  check("exports four OTel spans", spans.length === 4);
  check("agent span carries GenAI agent name", otelAgent?.attributes["gen_ai.agent.name"] === "main");
  check("trace metadata primitives are included", otelAgent?.attributes["agent_framework.trace.metadata.env"] === "test");
  check("nested metadata is ignored", otelAgent?.attributes["agent_framework.trace.metadata.ignoredNested"] === undefined);

  const traceId = otelAgent?.spanContext().traceId;
  check(
    "all OTel spans share one OTel trace id",
    traceId !== undefined && [otelTurn, otelGeneration, otelTool].every((span) => span?.spanContext().traceId === traceId),
  );
  check("turn parents to agent", otelTurn?.parentSpanId === otelAgent?.spanContext().spanId);
  check("generation parents to turn", otelGeneration?.parentSpanId === otelTurn?.spanContext().spanId);
  check("tool parents to turn", otelTool?.parentSpanId === otelTurn?.spanContext().spanId);

  check("generation span name updates after model is known", otelGeneration?.name === "gen_ai chat claude-test");
  check("generation operation attribute is chat", otelGeneration?.attributes["gen_ai.operation.name"] === "chat");
  check("generation model attribute is filled", otelGeneration?.attributes["gen_ai.request.model"] === "claude-test");
  check("generation response id is filled", otelGeneration?.attributes["gen_ai.response.id"] === "resp-1");
  check("generation usage attributes are filled", otelGeneration?.attributes["gen_ai.usage.input_tokens"] === 11 && otelGeneration.attributes["gen_ai.usage.output_tokens"] === 22);
  check("conversation id is filled", otelGeneration?.attributes["gen_ai.conversation.id"] === "session-1");
  check("provider name is filled", otelGeneration?.attributes["gen_ai.provider.name"] === "anthropic");

  check("tool operation attribute is execute_tool", otelTool?.attributes["gen_ai.operation.name"] === "execute_tool");
  check("tool name attribute is filled", otelTool?.attributes["gen_ai.tool.name"] === "Bash");
  check("tool error status is set", otelTool?.status.code === SpanStatusCode.ERROR && otelTool.status.message === "command failed");

  await processor.shutdown();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ OTEL PROCESSOR E2E PASS — parent context + GenAI attributes + errors");
  } else {
    console.log("❌ OTEL PROCESSOR E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ OTEL PROCESSOR E2E ERROR:", error);
  process.exit(1);
});
