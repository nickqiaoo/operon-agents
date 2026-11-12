import assert from "node:assert/strict";
import { ConversationContext, computeContextBreakdown, defineAgent, LocalEnvironment, compactionCapability, type ChatModel, type Usage, type Message } from "../index.ts";
import { estimateTokensForMessages } from "../capabilities/compaction/tokens.ts";
import { registerFauxProvider, fauxAssistantMessage, fauxThinking, createAssistantMessageEventStream, openTestSession, testRunner } from "./faux.ts";

const faux = registerFauxProvider();
const base = Object.assign(Object.create(faux.getChatModel()) as ChatModel, { contextWindow: 200_000 });
const usage: Usage = { input: 150, cacheRead: 195_840, cacheWrite: 7, output: 1, totalTokens: 195_998, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const context = new ConversationContext({ history: [user("short")] });
assert.equal(context.observedInputTokens(base), undefined);
context.recordContextUsage(base, usage);
assert.equal(context.observedInputTokens(base), 195_997, "include cache read/write without counting output as input");
assert.equal(context.projectedContextTokens(base), 195_998);
const before = estimateTokensForMessages(context.messages);
context.appendMessage(user("x".repeat(800)));
assert.equal(context.projectedContextTokens(base), 195_998 + estimateTokensForMessages(context.messages) - before);
assert.equal(context.observedInputTokens(base), 195_997, "new content does not turn prediction into measured usage");
const otherModel = Object.assign(Object.create(base) as ChatModel, { id: "other-model" });
assert.equal(context.observedInputTokens(otherModel), undefined);
const otherProvider = Object.assign(Object.create(base) as ChatModel, { provider: "other-provider" });
assert.equal(context.observedInputTokens(otherProvider), undefined);
const child = new ConversationContext({ address: "child" });
assert.equal(child.observedInputTokens(base), undefined, "usage is isolated per conversation line");
context.replaceHistory([user("replaced")]);
assert.equal(context.projectedContextTokens(base), undefined);
context.recordContextUsage(base, usage);
context.applyCompaction({ summary: "summary", compactedCount: 1, tokensBefore: 200_000, tokensAfter: 10 });
assert.equal(context.observedInputTokens(base), undefined);
context.recordContextUsage(base, usage);
context.loadFromRecords([]);
assert.equal(context.observedInputTokens(base), undefined, "replay cannot reuse a live measurement for a different history");
for (const invalid of [0, NaN, Infinity, -1]) {
  context.recordContextUsage(base, usage);
  context.recordContextUsage(base, { ...usage, input: invalid, cacheRead: 0, cacheWrite: 0 });
  assert.equal(context.observedInputTokens(base), undefined, "missing/invalid usage falls back to estimation");
}
assert.ok(estimateTokensForMessages([fauxAssistantMessage(fauxThinking("x".repeat(40_000)))]) >= 10_000, "fallback includes historical thinking");

const report = computeContextBreakdown({ model: base, system: "short", tools: [], messages: [user("short")], injectionTokens: new Map([["skills", 100_000]]), compactBufferTokens: 29_384, capturedAt: 0, observedInputTokens: 195_997 });
assert.equal(report.used, 195_997);
assert.equal(report.usageSource, "provider");
assert.equal(report.systemPrompt.tokens + report.toolsBuiltin.tokens + report.toolsMcp.tokens + report.messages.tokens + report.injections.reduce((sum, item) => sum + item.tokens, 0), report.used, "estimated categories are normalised to measured occupancy");
assert.equal(report.free.tokens, Math.max(0, base.contextWindow - report.used - report.compactBuffer.tokens));

const emptyReport = computeContextBreakdown({ model: base, system: undefined, tools: [], messages: [], injectionTokens: new Map(), compactBufferTokens: 0, capturedAt: 0, observedInputTokens: 123 });
assert.equal(emptyReport.used, 123);
assert.equal(emptyReport.messages.tokens, 123, "measured occupancy remains visible when local attribution has no text");

// Exercise the real loop: tiny text estimates, provider reports a nearly-full window.
const model = Object.create(base) as ChatModel;
model.stream = () => {
  const out = createAssistantMessageEventStream();
  const message = { ...fauxAssistantMessage(fauxThinking("The"), { stopReason: "length" }), model: base.id, provider: base.provider, api: base.api, usage };
  out.push({ type: "done", reason: "length", message });
  out.end();
  return out;
};
model.complete = async () => fauxAssistantMessage("compact summary");
const agent = defineAgent({ name: "usage-test", model, instructions: "short" });
const environment = new LocalEnvironment({ workDir: process.cwd() });
const runner = testRunner({ environment });
const session = await openTestSession({ environment });
await runner.run(agent, "short", { session });
assert.equal(session.getContextBreakdown()?.used, 195_997, "response usage updates the panel after the final model call");
assert.equal(session.getContextBreakdown()?.usageSource, "provider");
await session.close();

const compactRunner = testRunner({ environment });
const compactSession = await openTestSession({ environment, capabilities: [compactionCapability({ maxContextTokens: 200_000 })] });
const compactResult = await compactRunner.run(agent, Array.from({ length: 12 }, (_, i) => i % 2 ? fauxAssistantMessage(`reply ${i}`) : user(`message ${i}`)), { session: compactSession });
assert.ok(compactResult.messages.some((message) => JSON.stringify(message.content).includes("<context-summary>")), "actual usage triggers compaction even when text estimates are tiny");
assert.equal(compactSession.getContextBreakdown()?.usageSource, "estimate", "compaction invalidates the old measured total in the panel");
await compactSession.close();
faux.unregister();
console.log("PASS: provider context usage, cached input, category attribution, prediction, invalidation, and automatic compaction");
