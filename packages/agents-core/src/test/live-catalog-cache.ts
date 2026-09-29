/**
 * LIVE probe (spends real tokens; not part of `pnpm test`):
 *
 *   OPENROUTER_API_KEY=... node --experimental-strip-types src/test/live-catalog-cache.ts
 *
 * Runs the real Runner against real endpoints with 30 fake MCP tools and checks, per step,
 * what e2e-catalog.ts / e2e-defer.ts assert on serialized bytes:
 *
 *   native  — a Claude model with mid-conversation tool changes (`LIVE_NATIVE_MODEL`, default
 *             anthropic/claude-opus-5.5 through OpenRouter's Messages API). The first request
 *             carries SearchTool only; loading a tool via SearchTool (a `tool_addition`) must
 *             keep reading the cached prefix.
 *   server  — a non-Claude model on OpenRouter's Responses API (`LIVE_SERVER_MODEL`, default
 *             deepseek/deepseek-v4-flash): no SearchTool, MCP tools sent `defer_loading`
 *             beside `openrouter:tool_search`; the prompt must stay far below the full-send
 *             size and later steps must hit the cache.
 *
 * `LIVE_ONLY=native|server` runs one of them.
 */
import { z } from "zod";
import { defineAgent, ProviderManager, type AssistantMessage, type ChatModel } from "../index.ts";
import { ToolAccesses } from "../tool/access.ts";
import { tool } from "../tool/define.ts";
import type { Tool } from "../tool/types.ts";
import { SEARCH_TOOL_NAME } from "../tool/search/deferral.ts";
import { testRunner } from "./faux.ts";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.log("skip: OPENROUTER_API_KEY not set");
  process.exit(0);
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const padding = Array.from({ length: 300 }, (_, i) => `Guideline ${i + 1}: keep answers short, precise, and free of speculation.`).join("\n");
const instructions = `You are a terse assistant. Use tools when the task needs them.\n\n${padding}`;

const weather = tool({
  name: "mcp__weather__get_forecast",
  description: "Get the current weather forecast for a city.",
  parameters: z.object({ city: z.string().describe("City name") }),
  accesses: ToolAccesses.none(),
  execute: ({ city }) => `${city}: sunny, 22C`,
});
const filler: Tool[] = Array.from({ length: 30 }, (_, i) => tool({
  name: `mcp__corp__operation_${i}`,
  description: `Internal corporate operation ${i}. `.repeat(25),
  parameters: z.object({ id: z.string().describe("Record identifier") }),
  accesses: ToolAccesses.none(),
  execute: () => "ok",
}));

async function resolve(alias: string, provider: { type: "anthropic" | "openai_responses" }, model: string): Promise<ChatModel> {
  const manager = new ProviderManager({
    config: {
      providers: { or: { ...provider, baseUrl: provider.type === "anthropic" ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1", apiKey } },
      models: { [alias]: { provider: "or", model, maxContextSize: 200_000, maxOutputSize: 2_000 } },
    },
  });
  return (await manager.resolveModel(alias)).model;
}

function usages(messages: readonly { role: string }[]): AssistantMessage["usage"][] {
  return messages.filter((m): m is AssistantMessage => m.role === "assistant").map((m) => m.usage);
}

async function runOnce(model: ChatModel, label: string): Promise<{ usage: AssistantMessage["usage"][]; toolNames: string[] }> {
  const agent = defineAgent({ name: label, model, instructions });
  const result = await testRunner({ capabilities: [{ name: "mcp", tools: [weather, ...filler] }], permission: { mode: "yolo" } })
    .run(agent, "What's the weather in Paris? Use the weather tool.");
  const usage = usages(result.messages);
  usage.forEach((u, i) => console.log(`  ${label} step ${i + 1}: input=${u.input} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}`));
  const toolNames = result.messages.flatMap((m) => m.role === "toolResult" ? [m.toolName] : []);
  console.log(`  ${label} tool calls: ${toolNames.join(", ") || "(none)"}`);
  return { usage, toolNames };
}

async function native(): Promise<void> {
  const model = await resolve("native", { type: "anthropic" }, process.env.LIVE_NATIVE_MODEL ?? "anthropic/claude-opus-5.5");
  check("native: model gets SearchTool deferral", model.supportsDeferredTools);
  const { usage, toolNames } = await runOnce(model, "native");
  check("native: searched, then called the loaded tool", toolNames.includes(SEARCH_TOOL_NAME) && toolNames.includes(weather.schema.name));
  const prefix = usage[0]!.cacheRead + usage[0]!.cacheWrite;
  check(
    "native: every step after the load reads the first step's cached prefix",
    usage.length >= 2 && usage.slice(1).every((u) => u.cacheRead >= prefix * 0.9),
  );
}

async function server(): Promise<void> {
  const model = await resolve("server", { type: "openai_responses" }, process.env.LIVE_SERVER_MODEL ?? "deepseek/deepseek-v4-flash");
  check("server: model searches server-side", model.serverToolSearch && !model.supportsDeferredTools);
  const { usage, toolNames } = await runOnce(model, "server");
  check("server: called the revealed tool directly", toolNames.includes(weather.schema.name) && !toolNames.includes(SEARCH_TOOL_NAME));
  const last = usage.at(-1)!;
  // 31 tools × ~150 tokens stay out of the prompt; only the system text and history remain.
  check("server: the final step's prompt excludes the deferred definitions", last.input + last.cacheRead < 9_000);
  check("server: the final step hits the cache", last.cacheRead > 0);
}

async function main(): Promise<void> {
  const only = process.env.LIVE_ONLY;
  if (only !== "server") await native();
  if (only !== "native") await server();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} live checks passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("live probe error:", error);
  process.exit(1);
});
