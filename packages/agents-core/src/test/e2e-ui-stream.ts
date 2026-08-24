/**
 * Unit checks for the AgentEvent → AI-SDK UI-chunk converter (`../ui/ai-sdk.ts`).
 * Pure/synthetic (no model), so it runs in the e2e sweep but costs nothing.
 */
import assert from "node:assert/strict";
import type { AgentEvent } from "../events/events.ts";
import { AgentEventToUiStream } from "../ui/ai-sdk.ts";

const ev = (address: string, body: Record<string, unknown>): AgentEvent =>
  ({ address, sessionId: "s1", ...body }) as unknown as AgentEvent;

const types = (chunks: { type: string }[]) => chunks.map((c) => c.type);

// 1) A full single tool turn: step lifecycle + text (delta+part) + tool-call + result.
{
  const m = new AgentEventToUiStream({ messageId: "m1" });
  const out: { type: string; [k: string]: unknown }[] = [];
  const feed = (e: AgentEvent) => out.push(...(m.map(e) as never[]));

  feed(ev("main", { type: "turn.step.started", turnId: "t", step: 1, stepId: "t.1" }));
  feed(ev("main", { type: "assistant.delta", turnId: "t", delta: "Hi" }));
  feed(ev("main", { type: "content.part", turnId: "t", step: 1, part: { type: "text", text: "Hi" } }));
  feed(ev("main", { type: "tool.call.started", toolCallId: "t1", toolName: "Bash", args: { command: "ls" } }));
  feed(ev("main", { type: "tool.result", toolCallId: "t1", toolName: "Bash", result: { content: [{ type: "text", text: "a.txt" }], isError: false }, isError: false }));
  feed(ev("main", { type: "turn.step.completed", turnId: "t", step: 1, stepId: "t.1" }));
  feed(ev("main", { type: "agent.ended", agent: "main" }));

  // start fires once, before anything else.
  assert.equal(out[0]?.type, "start");
  assert.equal((out[0] as { messageId?: string }).messageId, "m1");
  assert.deepEqual(types(out), [
    "start", "start-step", "text-start", "text-delta", "text-end",
    "tool-input-available", "tool-output-available", "finish-step", "finish",
  ]);

  const call = out.find((c) => c.type === "tool-input-available")!;
  assert.equal(call.toolCallId, "t1");
  assert.equal(call.toolName, "Bash");
  assert.deepEqual(call.input, { command: "ls" });

  const result = out.find((c) => c.type === "tool-output-available")!;
  assert.equal(result.toolCallId, "t1");
  assert.equal(result.output, "a.txt");
}

// 2) Orphan prevention: a result whose tool-call never streamed still gets a call first.
{
  const m = new AgentEventToUiStream({ messageId: "m2" });
  const chunks = m.map(ev("main", { type: "tool.result", toolCallId: "z9", toolName: "Read", result: { content: [{ type: "text", text: "body" }], isError: false }, isError: false }));
  const t = types(chunks as { type: string }[]);
  // The synthesized tool-input-available must precede the tool-output-available.
  assert.ok(t.indexOf("tool-input-available") !== -1, "expected a synthesized tool-call");
  assert.ok(t.indexOf("tool-input-available") < t.indexOf("tool-output-available"), "call must precede result");
}

// 3) A failed tool maps to tool-output-error.
{
  const m = new AgentEventToUiStream();
  m.map(ev("main", { type: "tool.call.started", toolCallId: "w1", toolName: "Write", args: {} }));
  const chunks = m.map(ev("main", { type: "tool.result", toolCallId: "w1", toolName: "Write", result: { content: [{ type: "text", text: "ENOENT" }], isError: true }, isError: true }));
  const err = (chunks as { type: string; errorText?: string }[]).find((c) => c.type === "tool-output-error");
  assert.ok(err, "expected tool-output-error");
  assert.equal(err!.errorText, "ENOENT");
}

// 4) Nested (sub-agent) events are skipped by default for the finish signal; a sub-agent's tool
//    call still converts to a step-less tool chunk but a sub-agent's agent.ended must not finish.
{
  const m = new AgentEventToUiStream();
  const chunks = m.map(ev("main/sub-1", { type: "agent.ended", agent: "sub" })) as { type: string }[];
  assert.ok(!types(chunks).includes("finish"), "a sub-agent agent.ended must not finish the run");
}

// 5) The converter is pure: usage/metadata shaping is the host's job — none is emitted here.
{
  const m = new AgentEventToUiStream();
  const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const chunks = m.map(ev("main", { type: "usage.updated", usage })) as { type: string }[];
  assert.ok(!chunks.some((c) => c.type === "message-metadata"), "converter must not emit metadata");
}

// A handoff target is a new top-level shard (no `/`), so its terminal event finishes the stream.
{
  const m = new AgentEventToUiStream();
  const chunks = m.map(ev("h_billing_1", { type: "agent.ended", agent: "billing" })) as { type: string }[];
  assert.ok(types(chunks).includes("finish"), "a handoff root agent.ended must finish the run");
}

// 6) An optimistic output block closes the provisional text step and carries retraction metadata.
{
  const m = new AgentEventToUiStream();
  m.map(ev("main", { type: "turn.step.started", turnId: "t", step: 1, stepId: "t.1" }));
  m.map(ev("main", { type: "assistant.delta", turnId: "t", delta: "unsafe" }));
  const chunks = m.map(ev("main", {
    type: "guardrail.blocked",
    stage: "output",
    guardrail: "safe-output",
    turnId: "t",
    step: 1,
    stepId: "t.1",
    message: "blocked",
  })) as { type: string; messageMetadata?: unknown }[];
  assert.deepEqual(types(chunks), ["text-end", "finish-step", "message-metadata"]);
  assert.deepEqual(chunks.at(-1)?.messageMetadata, {
    type: "guardrail.blocked",
    stage: "output",
    guardrail: "safe-output",
    turnId: "t",
    step: 1,
    stepId: "t.1",
    message: "blocked",
  });
}

console.log("✓ ui-stream converter: all checks passed");
