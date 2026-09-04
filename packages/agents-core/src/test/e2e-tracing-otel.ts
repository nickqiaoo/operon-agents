// OTelTracingProcessor end to end: bridge → OTel spans in an in-memory exporter. Checks parent
// linkage, gen_ai attributes, content serialization (JSON, image stripping, truncation), span
// events and error status — what Jaeger would show.
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ListenerSink, OTelTracingProcessor, eventSinkTracingBridge, type AgentEvent } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const processor = new OTelTracingProcessor({
    tracer: provider.getTracer("test"),
    tracerProvider: provider,
    providerName: "operon",
    content: "delta",
    contentMaxChars: 200,
  });
  const sink = new ListenerSink();
  let clock = 1_700_000_000_000;
  eventSinkTracingBridge(sink, processor, { now: () => (clock += 5) });
  const emit = (body: Record<string, unknown>, address = "main"): Promise<void> => sink.emit({ sessionId: "conv-1", address, ...body } as AgentEvent);

  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const image = { type: "image", data: "A".repeat(4000), mimeType: "image/png" };
  const u1 = { role: "user", content: [{ type: "text", text: "what is in this image?" }, image], timestamp: 0 };
  const a1 = { role: "assistant", content: [{ type: "text", text: "a cat" }], api: "x", provider: "x", model: "m1", usage, stopReason: "stop", timestamp: 0 };

  await emit({ type: "message.appended", message: u1, origin: { kind: "user" } });
  await emit({ type: "agent.started", agent: "main" });
  await emit({ type: "turn.started", turnId: "t1" });
  await emit({ type: "turn.step.started", turnId: "t1", step: 1, stepId: "t1.1" });
  await emit({ type: "model.request", turnId: "t1", step: 1, stepId: "t1.1", system: "sys " + "x".repeat(500), messages: [u1], toolNames: ["Bash"] });
  await emit({ type: "turn.step.retrying", turnId: "t1", step: 1, attempt: 1, maxAttempts: 3, delayMs: 10, reason: "429" });
  await emit({ type: "turn.step.completed", turnId: "t1", step: 1, stepId: "t1.1", usage, finishReason: "end_turn" });
  await emit({ type: "message.appended", message: a1 });
  await emit({ type: "tool.call.started", toolCallId: "tc1", toolName: "Bash", args: { cmd: "ls", token: "sk-ant-SECRET123456789012345" } });
  await emit({ type: "tool.result", toolCallId: "tc1", toolName: "Bash", result: { content: [{ type: "text", text: "nope" }], isError: true }, isError: true });
  await emit({ type: "agent.started", agent: "sub" }, "main/sub");
  await emit({ type: "agent.ended", agent: "sub" }, "main/sub");
  await emit({ type: "turn.ended", turnId: "t1", reason: "completed" });
  await emit({ type: "agent.ended", agent: "main" });
  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  const byName = (prefix: string) => spans.find((s) => s.name.startsWith(prefix));
  const root = byName("agent main");
  const turn = byName("turn t1");
  const gen = byName("gen_ai chat m1");
  const tool = byName("tool Bash");
  const msg = byName("user message");
  const sub = byName("agent sub");

  check("tree: one OTel trace, root has no parent", spans.length === 6 && new Set(spans.map((s) => s.spanContext().traceId)).size === 1 && root?.parentSpanId === undefined);
  check("tree: turn → root, gen/tool/message → turn, sub-agent → root", turn?.parentSpanId === root?.spanContext().spanId && [gen, tool, msg].every((s) => s?.parentSpanId === turn?.spanContext().spanId) && sub?.parentSpanId === root?.spanContext().spanId);
  check("root: named by the prompt, conversation id on every span", root?.name === "agent main: what is in this image?" && spans.every((s) => s.attributes["gen_ai.conversation.id"] === "conv-1"));
  check("gen: semconv attributes", gen?.attributes["gen_ai.operation.name"] === "chat" && gen.attributes["gen_ai.request.model"] === "m1" && gen.attributes["gen_ai.usage.input_tokens"] === 10 && gen.attributes["gen_ai.provider.name"] === "operon");
  const sys = String(gen?.attributes["gen_ai.system_instructions"] ?? "");
  check("gen: system prompt truncated at contentMaxChars with a marker", sys.length < 260 && sys.startsWith("sys xxx") && sys.includes("…[truncated 304 chars]"));
  const input = JSON.parse(String(gen?.attributes["gen_ai.input.messages"])) as Array<{ role: string; content: Array<{ type: string; bytes?: number; data?: string }> }>;
  check("gen: input messages are JSON with images reduced to size", input[0]?.role === "user" && input[0].content[1]?.type === "image" && input[0].content[1].bytes === 3000 && input[0].content[1].data === undefined);
  check("gen: output messages JSON", JSON.parse(String(gen?.attributes["gen_ai.output.messages"]))[0]?.text === "a cat");
  check("gen: retry is a span event with attributes", gen?.events.length === 1 && gen.events[0]?.name === "retry" && gen.events[0].attributes?.reason === "429");
  check("tool: args + result JSON, raw (no redaction by default)", String(tool?.attributes["gen_ai.tool.call.arguments"]).includes("sk-ant-SECRET") && JSON.parse(String(tool?.attributes["gen_ai.tool.call.result"])).isError === true);
  check("tool: error status carries the tool's text", tool?.status.code === 2 && tool.status.message === "nope" && tool.attributes["agent_framework.tool.is_error"] === true);
  check("message: content attribute + origin", typeof msg?.attributes["agent_framework.message.content"] === "string" && msg.attributes["agent_framework.message.origin"] === "user");
  check("timing: span times come from the bridge clock", root !== undefined && root.startTime[0] * 1000 + Math.round(root.startTime[1] / 1e6) >= 1_700_000_000_000);

  // Redaction opt-in.
  const exporter2 = new InMemorySpanExporter();
  const provider2 = new BasicTracerProvider();
  provider2.addSpanProcessor(new SimpleSpanProcessor(exporter2));
  const sink2 = new ListenerSink();
  eventSinkTracingBridge(sink2, new OTelTracingProcessor({ tracer: provider2.getTracer("t2"), content: "delta", redact: true }));
  const emit2 = (body: Record<string, unknown>): Promise<void> => sink2.emit({ sessionId: "c2", address: "main", ...body } as AgentEvent);
  await emit2({ type: "agent.started", agent: "main" });
  await emit2({ type: "tool.call.started", toolCallId: "x", toolName: "Bash", args: { token: "sk-ant-SECRET123456789012345" } });
  await emit2({ type: "tool.result", toolCallId: "x", toolName: "Bash", result: { content: [] }, isError: false });
  await emit2({ type: "agent.ended", agent: "main" });
  const redactedTool = exporter2.getFinishedSpans().find((s) => s.name === "tool Bash");
  const args = String(redactedTool?.attributes["gen_ai.tool.call.arguments"]);
  check("redact: opt-in masks secrets in content", args.includes("[REDACTED]") && !args.includes("SECRET123"));

  await provider.shutdown();
  await provider2.shutdown();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed === checks.length) {
    console.log("✅ TRACING OTEL E2E PASS — bridge → OTel spans with gen_ai attributes + content");
  } else {
    console.log("❌ TRACING OTEL E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ TRACING OTEL E2E ERROR:", error);
  process.exit(1);
});
