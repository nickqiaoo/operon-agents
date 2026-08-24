import {
  BatchTracingProcessor,
  ListenerSink,
  eventSinkTracingBridge,
  noopTracingProcessor,
  type AgentEvent,
  type SpanRecord,
  type TraceRecord,
  type TracingExporter,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const SECRET = "sk-ant-SECRETSECRETSECRET1234567890";

function msg(model: string, input: number, output: number): unknown {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model,
    responseId: "resp_1",
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function main(): Promise<void> {
  const sink = new ListenerSink();
  const exported: Array<TraceRecord | SpanRecord> = [];
  const exporter: TracingExporter = { export: (items) => void exported.push(...items) };
  const processor = new BatchTracingProcessor(exporter, { scheduleDelayMs: 0 }); // manual flush, no timer

  let clock = 0;
  const unsubscribe = eventSinkTracingBridge(sink, processor, { now: () => ++clock });

  const emit = async (body: Record<string, unknown>, address = "main"): Promise<void> => {
    await sink.emit({ sessionId: "s1", address, ...body } as AgentEvent);
  };

  // A realistic run: root agent + nested sub-agent, then a handoff to a fresh top-level shard.
  await emit({ type: "agent.started", agent: "main" });
  await emit({ type: "turn.started", turnId: "t1" });
  await emit({ type: "turn.step.started", turnId: "t1", step: 1, stepId: "t1.1" });
  await emit({ type: "message.appended", message: msg("test-model", 10, 20) });
  await emit({ type: "tool.call.started", toolCallId: "tc1", toolName: "Bash" });
  await emit({ type: "tool.call.started", toolCallId: "tc2", toolName: "Bash" }); // concurrent: both open
  await emit({ type: "tool.result", toolCallId: "tc1", toolName: "Bash", result: { content: [] } });
  await emit({ type: "tool.result", toolCallId: "tc2", toolName: "Bash", result: { content: [], isError: true } });
  await emit({ type: "error", message: `db failed token=${SECRET}` }); // attaches to the open turn span
  await emit({ type: "agent.started", agent: "sub" }, "main/sub"); // sub-agent nests under main
  await emit({ type: "agent.ended", agent: "sub" }, "main/sub");
  await emit({ type: "turn.ended", turnId: "t1" });
  await emit({ type: "agent.handoff", from: "main", to: "billing", handoffId: "handoff_1", fromAddress: "main", toAddress: "h_billing_1" });
  await emit({ type: "agent.started", agent: "billing" }, "h_billing_1");
  await emit({ type: "agent.ended", agent: "billing" }, "h_billing_1");

  await processor.forceFlush();
  unsubscribe();

  const trace = exported.find((r): r is TraceRecord => r.object === "trace");
  const spans = exported.filter((r): r is SpanRecord => r.object === "trace.span");
  const byType = (t: string): SpanRecord[] => spans.filter((s) => s.span_data.type === t);

  check("trace: one trace, name + groupId from session", trace?.name === "main" && trace?.group_id === "s1");

  const agentSpans = byType("agent");
  const rootAgent = agentSpans.find((s) => s.parent_id === null);
  check("agent: root agent span has no parent", rootAgent !== undefined && rootAgent.span_data.type === "agent" && rootAgent.span_data.name === "main");
  const subAgent = agentSpans.find((s) => s.span_data.type === "agent" && s.span_data.name === "sub");
  check("agent: sub-agent nests under root agent", subAgent?.parent_id === rootAgent?.id);
  const billingAgent = agentSpans.find((s) => s.span_data.type === "agent" && s.span_data.name === "billing");
  check("agent: handoff target is another top-level agent span", billingAgent?.parent_id === null);

  const turn = byType("turn")[0];
  check("turn: turn span parents to its agent span", turn?.parent_id === rootAgent?.id && turn.span_data.type === "turn" && turn.span_data.turnId === "t1");

  const gen = byType("generation")[0];
  check(
    "generation: parents to turn, carries model + usage",
    gen?.parent_id === turn?.id &&
      gen.span_data.type === "generation" &&
      gen.span_data.model === "test-model" &&
      gen.span_data.usage?.input_tokens === 10 &&
      gen.span_data.usage?.output_tokens === 20 &&
      gen.span_data.usage?.total_tokens === 30,
  );

  const tools = byType("tool");
  const tc1 = tools.find((s) => s.span_data.type === "tool" && s.span_data.toolCallId === "tc1");
  const tc2 = tools.find((s) => s.span_data.type === "tool" && s.span_data.toolCallId === "tc2");
  check("tool: concurrent tools both captured + parented to turn", tc1?.parent_id === turn?.id && tc2?.parent_id === turn?.id);
  check("tool: error result marks span error", tc2?.span_data.type === "tool" && tc2.span_data.isError === true && tc2.error !== null);
  check("tool: ok result has no error", tc1?.error === null && tc1?.span_data.type === "tool" && tc1.span_data.isError === false);

  const handoff = byType("handoff")[0];
  check("handoff: instant span with from/to", handoff?.span_data.type === "handoff" && handoff.span_data.from === "main" && handoff.span_data.to === "billing");

  check("timing: every span has positive duration", spans.every((s) => s.started_at !== null && s.ended_at !== null && s.ended_at > s.started_at));

  const turnErr = turn?.error?.message ?? "";
  check("redaction: secret in span error is masked at export", turnErr.includes("[REDACTED]") && !turnErr.includes(SECRET));

  // Noop processor: bridge drives it without throwing and produces nothing.
  const noopSink = new ListenerSink();
  const off = eventSinkTracingBridge(noopSink, noopTracingProcessor);
  await noopSink.emit({ type: "agent.started", agent: "x", address: "main", sessionId: "s2" } as AgentEvent);
  await noopSink.emit({ type: "agent.ended", agent: "x", address: "main", sessionId: "s2" } as AgentEvent);
  off();
  check("noop: bridge over noop processor is a silent no-op", true);

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ TRACING E2E PASS — EventSink→Trace/Span tree (nesting + concurrency + usage + error + redaction)");
  } else {
    console.log("❌ TRACING E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ TRACING E2E ERROR:", error);
  process.exit(1);
});
