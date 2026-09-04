// Tracing with CONTENT: one trace per run, prompt/messages/tool args on spans, a background
// sub-agent keeping its trace alive past the root, and the handoff/none-mode invariants.
import { ListenerSink, eventSinkTracingBridge, type AgentEvent, type Span, type Trace, type TracingContentMode, type TracingProcessor } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface Recording extends TracingProcessor {
  readonly spans: Span[];
  readonly traceLog: string[];
}
function recorder(content: TracingContentMode): Recording {
  const spans: Span[] = [];
  const traceLog: string[] = [];
  return {
    content,
    spans,
    traceLog,
    onTraceStart: (t: Trace) => void traceLog.push(`start ${t.traceId}`),
    onTraceEnd: (t: Trace) => void traceLog.push(`end ${t.traceId}`),
    onSpanStart: () => {},
    onSpanEnd: (span: Span) => void spans.push(span),
    async forceFlush() {},
    async shutdown() {},
  };
}

const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 } };
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (content: unknown[]) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test-model",
  responseId: "resp_1",
  usage,
  stopReason: "toolUse",
  timestamp: 0,
});
const toolResult = (id: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "Bash", content: [{ type: "text", text }], isError, timestamp: 0 });

async function runScenario(content: TracingContentMode): Promise<Recording> {
  const sink = new ListenerSink();
  const processor = recorder(content);
  let clock = 0;
  eventSinkTracingBridge(sink, processor, { now: () => ++clock });
  const emit = (body: Record<string, unknown>, address = "main"): Promise<void> => sink.emit({ sessionId: "s1", address, ...body } as AgentEvent);

  const u1 = user("  Fix the   bug in foo.ts  ");
  const a1 = assistant([
    { type: "thinking", thinking: "let me look" },
    { type: "text", text: "Running it." },
    { type: "toolCall", id: "tc1", name: "Bash", arguments: { cmd: "ls" } },
    { type: "toolCall", id: "tc2", name: "Bash", arguments: { cmd: "rm -rf /" } },
  ]);
  const r1 = toolResult("tc1", "ok");
  const r2 = toolResult("tc2", "boom: permission denied", true);

  // ── run 1 (real order: the input is journaled BEFORE agent.started; a step completes BEFORE
  // its assistant message is appended) ──
  await emit({ type: "message.appended", message: u1, origin: { kind: "user" } });
  await emit({ type: "agent.started", agent: "main" });
  await emit({ type: "turn.started", turnId: "t1" });
  await emit({ type: "turn.step.started", turnId: "t1", step: 1, stepId: "t1.1" });
  await emit({ type: "model.request", turnId: "t1", step: 1, stepId: "t1.1", system: "You are a coder.", messages: [u1], toolNames: ["Bash", "Read"], params: { temperature: 0.2 } });
  await emit({ type: "turn.step.retrying", turnId: "t1", step: 1, attempt: 1, maxAttempts: 3, delayMs: 10, reason: "overloaded" });
  await emit({ type: "turn.step.completed", turnId: "t1", step: 1, stepId: "t1.1", usage, finishReason: "tool_use" });
  await emit({ type: "message.appended", message: a1 });
  await emit({ type: "tool.call.started", toolCallId: "tc1", toolName: "Bash", args: { cmd: "ls" } });
  await emit({ type: "tool.result", toolCallId: "tc1", toolName: "Bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  await emit({ type: "tool.call.started", toolCallId: "tc2", toolName: "Bash", args: { cmd: "rm -rf /" } });
  await emit({ type: "tool.result", toolCallId: "tc2", toolName: "Bash", result: { content: [{ type: "text", text: "boom: permission denied" }], isError: true }, isError: true });
  await emit({ type: "message.appended", message: r1 });
  await emit({ type: "message.appended", message: r2 });
  await emit({ type: "turn.step.started", turnId: "t1", step: 2, stepId: "t1.2" });
  await emit({ type: "model.request", turnId: "t1", step: 2, stepId: "t1.2", system: "You are a coder.", messages: [u1, a1, r1, r2], toolNames: ["Bash", "Read"] });
  // Step 2's message never gets appended before the turn ends (a failure path): the settled
  // span must still be reported, with the step's own usage.
  await emit({ type: "turn.step.completed", turnId: "t1", step: 2, stepId: "t1.2", usage, finishReason: "end_turn" });
  // A background sub-agent spawned by run 1 that outlives it.
  await emit({ type: "agent.started", agent: "bg" }, "main/bg");
  await emit({ type: "turn.started", turnId: "bg-t1" }, "main/bg");
  await emit({ type: "turn.ended", turnId: "t1", reason: "completed" });
  await emit({ type: "agent.ended", agent: "main" });

  // ── run 2 (a new prompt while bg is still running) ──
  await emit({ type: "message.appended", message: user("second prompt"), origin: { kind: "user" } });
  await emit({ type: "agent.started", agent: "main" });
  await emit({ type: "turn.started", turnId: "t2" });
  await emit({ type: "turn.ended", turnId: "t2", reason: "failed", error: "model exploded" });
  await emit({ type: "agent.ended", agent: "main" });

  // bg finishes last: run 1's trace ends now.
  await emit({ type: "turn.ended", turnId: "bg-t1", reason: "completed" }, "main/bg");
  await emit({ type: "agent.ended", agent: "bg" }, "main/bg");
  return processor;
}

async function main(): Promise<void> {
  const delta = await runScenario("delta");
  const spans = delta.spans;
  const byType = (t: string) => spans.filter((s) => s.data.type === t);
  const traceIds = [...new Set(spans.map((s) => s.traceId))];

  // ── trace boundaries ──
  check("run: two runs → two traces", traceIds.length === 2 && delta.traceLog.filter((l) => l.startsWith("start")).length === 2);
  const roots = byType("agent").filter((s) => s.parentId === null);
  check("run: each trace has one root agent span", roots.length === 2 && new Set(roots.map((s) => s.traceId)).size === 2);
  const [run1, run2] = roots.map((s) => s.traceId);
  check("run: background sub-agent keeps run 1's trace open until it ends", delta.traceLog[delta.traceLog.length - 1] === `end ${run1}` && delta.traceLog.indexOf(`end ${run2}`) < delta.traceLog.indexOf(`end ${run1}`));
  const bg = byType("agent").find((s) => s.data.type === "agent" && s.data.name === "bg");
  check("run: background agent's late spans land in run 1's trace under its root", bg?.traceId === run1 && bg.parentId === roots[0]?.spanId);
  const bgTurn = byType("turn").find((s) => s.data.type === "turn" && s.data.turnId === "bg-t1");
  check("run: background agent's turn nests under it", bgTurn?.parentId === bg?.spanId);

  // ── root naming ──
  check("root: first user prompt names the root span, whitespace collapsed", roots[0]?.data.type === "agent" && roots[0].data.prompt === "Fix the bug in foo.ts");

  // ── turn ──
  const t1 = byType("turn").find((s) => s.data.type === "turn" && s.data.turnId === "t1");
  const t2 = byType("turn").find((s) => s.data.type === "turn" && s.data.turnId === "t2");
  check("turn: reason recorded", t1?.data.type === "turn" && t1.data.reason === "completed" && t1.error === null);
  check("turn: failed turn carries the error", t2?.data.type === "turn" && t2.data.reason === "failed" && t2.data.error === "model exploded" && t2.error?.message === "model exploded");

  // ── user message span ──
  const msgs = byType("message");
  check("message: pre-run prompt becomes an instant span under the first turn with content + origin", msgs.length === 2 && msgs[0]?.parentId === t1?.spanId && msgs[0].data.type === "message" && msgs[0].data.origin === "user" && msgs[0].data.content === "  Fix the   bug in foo.ts  ");
  check("message: run 2's prompt lands under turn t2", msgs[1]?.parentId === t2?.spanId && msgs[1]?.traceId === run2);

  // ── generation content ──
  const gens = byType("generation");
  const g1 = gens[0];
  const g2 = gens[1];
  check(
    "generation: system prompt, tools, params from model.request",
    g1?.data.type === "generation" && g1.data.system === "You are a coder." && g1.data.toolNames?.join(",") === "Bash,Read" && g1.data.params?.temperature === 0.2,
  );
  check("generation: step 1 delta input = the user prompt", g1?.data.type === "generation" && g1.data.inputMode === "delta" && g1.data.input?.length === 1 && g1.data.input[0]?.role === "user");
  check("generation: step 2 delta input = the two tool results only", g2?.data.type === "generation" && g2.data.input?.length === 2 && g2.data.input.every((m) => m.role === "toolResult"));
  check("generation: output parts (thinking + text + 2 tool calls)", g1?.data.type === "generation" && g1.data.output?.length === 4 && g1.data.output[2]?.type === "toolCall");
  check("generation: usage includes cache + cost", g1?.data.type === "generation" && g1.data.usage?.cache_read_tokens === 3 && g1.data.usage.cache_write_tokens === 2 && g1.data.usage.cost_usd === 0.0042);
  check("generation: model + stop reason from the assistant message appended AFTER step.completed", g1?.data.type === "generation" && g1.data.model === "test-model" && g1.data.stopReason === "toolUse");
  const tc1Span = spans.find((s) => s.data.type === "tool" && s.data.toolCallId === "tc1");
  check("generation: end time fixed at step.completed, not at the (later) message append", g1 !== undefined && tc1Span !== undefined && g1.endedAt !== null && tc1Span.startedAt !== null && g1.endedAt < tc1Span.startedAt);
  check("generation: reported in order — before the tool spans that followed it", spans.indexOf(g1!) < spans.indexOf(tc1Span!));
  check("generation: a step whose message never arrives is still reported with the step's usage + finish reason", g2?.data.type === "generation" && g2.data.model === undefined && g2.data.usage?.input_tokens === 10 && g2.data.stopReason === "end_turn" && g2.endedAt !== null);
  check("generation: retry recorded as a span event", g1?.events.length === 1 && g1.events[0]?.name === "retry" && g1.events[0].data?.reason === "overloaded");

  // ── tool content ──
  const tools = byType("tool");
  const tc1 = tools.find((s) => s.data.type === "tool" && s.data.toolCallId === "tc1");
  const tc2 = tools.find((s) => s.data.type === "tool" && s.data.toolCallId === "tc2");
  check("tool: args + result attached", tc1?.data.type === "tool" && (tc1.data.args as { cmd: string }).cmd === "ls" && tc1.data.result?.content[0]?.type === "text");
  check("tool: error message is the tool's own text, not a placeholder", tc2?.error?.message === "boom: permission denied");

  // ── full mode ──
  const full = await runScenario("full");
  const fg2 = full.spans.filter((s) => s.data.type === "generation")[1];
  check("full: step 2 carries the whole context", fg2?.data.type === "generation" && fg2.data.inputMode === "full" && fg2.data.input?.length === 4);

  // ── none mode: metadata only, no message spans, no prompt name ──
  const none = await runScenario("none");
  const ng1 = none.spans.find((s) => s.data.type === "generation");
  const nt1 = none.spans.find((s) => s.data.type === "tool");
  const nroot = none.spans.find((s) => s.data.type === "agent" && s.parentId === null);
  check(
    "none: no content on any span",
    ng1?.data.type === "generation" && ng1.data.system === undefined && ng1.data.input === undefined && ng1.data.output === undefined && ng1.data.usage?.input_tokens === 10,
  );
  check("none: tool spans have no args/result", nt1?.data.type === "tool" && nt1.data.args === undefined && nt1.data.result === undefined);
  check("none: no message spans, root not named by prompt", none.spans.every((s) => s.data.type !== "message") && nroot?.data.type === "agent" && nroot.data.prompt === undefined);
  check("none: the tree itself is identical", none.spans.length === delta.spans.length - 2);

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed === checks.length) {
    console.log("✅ TRACING CONTENT E2E PASS — per-run traces + prompt/messages/tool content + lingering background agent");
  } else {
    console.log("❌ TRACING CONTENT E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ TRACING CONTENT E2E ERROR:", error);
  process.exit(1);
});
