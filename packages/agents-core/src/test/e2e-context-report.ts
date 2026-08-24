/**
 * Unit-style coverage for agent/context-report.ts (computeContextBreakdown) — previously
 * zero test coverage despite being what backs the `/context` window-usage view. Covers the
 * branchy bits: builtin-vs-MCP tool split, injection subtraction from the messages bucket,
 * injections sorted largest-first, the free-space clamp at 0, and the window<=0 guard
 * (division by zero → percent must be 0, not NaN/Infinity).
 */
import type { ChatModel } from "../llm/define-model.ts";
import type { Message } from "../protocol/index.ts";
import type { Tool } from "../tool/types.ts";
import { computeContextBreakdown, estimateTokens, estimateTokensForMessages } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function fakeModel(contextWindow: number): ChatModel {
  return { id: "test-model", contextWindow } as ChatModel;
}

function fakeTool(name: string): Tool {
  return {
    schema: { name, description: `desc for ${name}`, parameters: { type: "object", properties: {} } },
    resolve: () => ({ approvalRule: name, run: async () => ({ content: [] }) }),
  };
}

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function main(): void {
  const builtinTool = fakeTool("Read");
  const mcpTool = fakeTool("mcp__github__search_issues");
  const system = "x".repeat(400); // estimateTokens("x"*400) = 100
  const messages = [userText("a".repeat(800)), userText("b".repeat(400))];
  const messagesTotal = estimateTokensForMessages(messages);

  // ── builtin vs MCP tool split ──
  {
    const breakdown = computeContextBreakdown({
      model: fakeModel(100_000),
      system,
      tools: [builtinTool, mcpTool],
      messages: [],
      injectionTokens: new Map(),
      compactBufferTokens: 0,
      capturedAt: 0,
    });
    check("systemPrompt: matches estimateTokens(system)", breakdown.systemPrompt.tokens === estimateTokens(system));
    check("toolsBuiltin: only counts the non-mcp__ tool", breakdown.toolsBuiltin.tokens === estimateTokens(JSON.stringify(builtinTool.schema)));
    check("toolsMcp: only counts the mcp__ tool", breakdown.toolsMcp.tokens === estimateTokens(JSON.stringify(mcpTool.schema)));
    check("used: sums system + both tool buckets + messages", breakdown.used === breakdown.systemPrompt.tokens + breakdown.toolsBuiltin.tokens + breakdown.toolsMcp.tokens);
  }

  // ── messages bucket subtracts injection tokens (no double-counting) ──
  {
    const injectionTokens = new Map([["todo", 30], ["skill_catalog", 90]]);
    const totalInjections = 120;
    const breakdown = computeContextBreakdown({
      model: fakeModel(100_000),
      system: undefined,
      tools: [],
      messages,
      injectionTokens,
      compactBufferTokens: 0,
      capturedAt: 0,
    });
    check("systemPrompt: empty/undefined system is 0 tokens", breakdown.systemPrompt.tokens === 0);
    check("messages: conversation bucket = messagesTotal - injectionsTotal", breakdown.messages.tokens === messagesTotal - totalInjections);
    check("injections: sorted largest-first", breakdown.injections[0]?.id === "skill_catalog" && breakdown.injections[1]?.id === "todo");
    check("injections: each slice keeps its own token count", breakdown.injections[0]?.tokens === 90 && breakdown.injections[1]?.tokens === 30);
    // `used` is system+tools+RAW messagesTotal (injections are a breakdown of messages, not
    // an additional bucket) — so used must NOT double count injection tokens on top of messagesTotal.
    check("used: counts messagesTotal once (injections are a sub-slice, not additive)", breakdown.used === messagesTotal);
  }

  // ── messages bucket clamps at 0 when injection tokens exceed the message total (stale estimate) ──
  {
    const breakdown = computeContextBreakdown({
      model: fakeModel(100_000),
      system: undefined,
      tools: [],
      messages: [userText("short")],
      injectionTokens: new Map([["stale", 999_999]]),
      compactBufferTokens: 0,
      capturedAt: 0,
    });
    check("messages: never goes negative even if injection tokens overcount the total", breakdown.messages.tokens === 0);
  }

  // ── free space clamps at 0 when used + compactBuffer exceeds the window ──
  {
    const breakdown = computeContextBreakdown({
      model: fakeModel(50), // tiny window
      system: "x".repeat(400),
      tools: [],
      messages: [],
      injectionTokens: new Map(),
      compactBufferTokens: 1000,
      capturedAt: 0,
    });
    check("free: clamps at 0 instead of going negative when the window is oversubscribed", breakdown.free.tokens === 0);
  }

  // ── window <= 0: percent must be 0, not NaN/Infinity (division-by-zero guard) ──
  {
    const breakdown = computeContextBreakdown({
      model: fakeModel(0),
      system: "x".repeat(400),
      tools: [builtinTool],
      messages,
      injectionTokens: new Map([["todo", 5]]),
      compactBufferTokens: 10,
      capturedAt: 0,
    });
    const allPercents = [
      breakdown.usedPercent,
      breakdown.systemPrompt.percent,
      breakdown.toolsBuiltin.percent,
      breakdown.messages.percent,
      breakdown.compactBuffer.percent,
      breakdown.free.percent,
      ...breakdown.injections.map((i) => i.percent),
    ];
    check("percent: window<=0 makes every percent exactly 0, never NaN/Infinity", allPercents.every((p) => p === 0));
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — computeContextBreakdown");
}

main();
