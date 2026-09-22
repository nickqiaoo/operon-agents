/**
 * LIVE probe (spends real tokens; not part of `pnpm test`):
 *
 *   ANTHROPIC_API_KEY=... node --experimental-strip-types src/test/live-catalog-cache.ts
 *
 * Confirms against the real Anthropic API what e2e-catalog.ts asserts on serialized bytes:
 *
 *   1. A request with SearchTool + the deferred-mode placeholder writes a cache entry.
 *   2. The next request — same prefix, plus a tail announcement, a SearchTool load point and the
 *      loaded tool declared `defer_loading` — READS that cache (prefix survived the catalog change).
 *   3. (optional, LIVE_PROBE_CALL_BEFORE_LOAD=1) Whether the API accepts a `defer_loading`-only
 *      declaration for a tool whose `tool_use` precedes any `tool_reference` — the case pi
 *      promotes to a prefix tool today. If accepted, an explicit deferred-name option in pi would
 *      remove that one-time prefix change after compaction / call-before-load.
 *
 * Model: LIVE_MODEL (default claude-sonnet-4-5). Prompt caching needs >= 1024 tokens on Sonnet,
 * so the system prompt is padded.
 */
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "./faux.ts";
import { withAnthropicDeferredMode } from "../llm/deferred-tools.ts";
import { SEARCH_TOOL_NAME } from "../tool/search/deferral.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log("skip: ANTHROPIC_API_KEY not set");
  process.exit(0);
}
const modelId = process.env.LIVE_MODEL ?? "claude-sonnet-4-5";

const model: Model<Api> = {
  id: modelId,
  name: modelId,
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64,
  compat: { supportsToolReferences: true },
} as Model<Api>;

const SLACK = "mcp__slack__send_message";
const padding = Array.from({ length: 220 }, (_, i) => `Guideline ${i + 1}: keep answers short, precise, and free of speculation about unrelated topics.`).join("\n");
const systemPrompt = `You are a terse assistant. Reply with the single word OK unless a tool is clearly needed.\n\n${padding}`;
const searchSchema = { name: SEARCH_TOOL_NAME, description: "Search deferred tools by keyword or select:<name>.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
const slackSchema = { name: SLACK, description: "Send a message to a Slack channel.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

async function send(label: string, context: Context, patch?: (payload: Record<string, unknown>) => Record<string, unknown>): Promise<AssistantMessage | undefined> {
  const options = withAnthropicDeferredMode({
    apiKey,
    maxRetries: 0,
    onPayload: (payload) => (patch ? patch(payload as Record<string, unknown>) : payload),
  }) as SimpleStreamOptions;
  let done: AssistantMessage | undefined;
  for await (const event of streamAnthropic(model, context, options)) {
    if (event.type === "done") done = event.message;
    if (event.type === "error") {
      console.log(`${label}: ERROR ${event.error.errorMessage ?? "(no message)"}`);
      return undefined;
    }
  }
  if (done) {
    const u = done.usage;
    console.log(`${label}: input=${u.input} cacheWrite=${u.cacheWrite} cacheRead=${u.cacheRead} stop=${done.stopReason}`);
  }
  return done;
}

async function main(): Promise<void> {
  const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });

  // 1. First request: SearchTool + placeholder, nothing loaded.
  const first = await send("1/prefix write", { systemPrompt, tools: [searchSchema], messages: [user("Say OK.")] });
  if (!first) process.exit(1);

  // 2. Catalog changed at the tail; one tool loaded via a SearchTool load point.
  const second = await send("2/prefix read", {
    systemPrompt,
    tools: [searchSchema, slackSchema],
    messages: [
      user("Say OK."),
      first,
      user("<system-reminder>\nThe following deferred tools are now available via SearchTool. Their schemas are NOT loaded — calling them directly will fail. Use SearchTool with query \"select:<name>[,<name>...]\" to load tool schemas before calling them:\nmcp__slack__send_message\n</system-reminder>\nLoad the slack tool."),
      fauxAssistantMessage(fauxToolCall(SEARCH_TOOL_NAME, { query: `select:${SLACK}` }, { id: "toolu_live_search" }), { stopReason: "toolUse" }),
      { role: "toolResult", toolCallId: "toolu_live_search", toolName: SEARCH_TOOL_NAME, content: [{ type: "text", text: `Loaded: ${SLACK}` }], addedToolNames: [SLACK], isError: false, timestamp: Date.now() },
      user("Now just say OK."),
    ],
  });
  if (!second) process.exit(1);
  const reused = second.usage.cacheRead > 0 && second.usage.cacheRead >= first.usage.cacheWrite * 0.9;
  console.log(reused ? "✅ prefix cache survived the catalog change + tool load" : "❌ prefix cache NOT reused (see numbers above)");

  // 3. Optional: defer_loading-only declaration with a tool_use before any tool_reference.
  if (process.env.LIVE_PROBE_CALL_BEFORE_LOAD === "1") {
    const third = await send("3/call-before-load as defer_loading", {
      systemPrompt,
      tools: [searchSchema, slackSchema],
      messages: [
        user("Say OK."),
        first,
        user("Send hi on slack."),
        fauxAssistantMessage(fauxToolCall(SLACK, { text: "hi" }, { id: "toolu_live_guess" }), { stopReason: "toolUse" }),
        { role: "toolResult", toolCallId: "toolu_live_guess", toolName: SLACK, content: [{ type: "text", text: "This tool's schema was not loaded. Load it via SearchTool first." }], isError: true, timestamp: Date.now() },
        user("Just say OK."),
      ],
    }, (payload) => {
      const tools = (payload.tools as Array<Record<string, unknown>>).map((t) => (t.name === SLACK ? { ...t, defer_loading: true } : t));
      return { ...payload, tools };
    });
    console.log(third
      ? "✅ API accepted a defer_loading-only declaration with an earlier tool_use (a pi deferred-name option would avoid the prefix promotion)"
      : "❌ API rejected it — pi's promotion to a prefix tool is required in this case");
  }
}

main().catch((error) => {
  console.error("live probe error:", error);
  process.exit(1);
});
