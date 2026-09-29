import { testRunner, openTestSession } from "./faux.ts";
/**
 * Deferred tool loading — SearchTool, the `toolsAdded` load-point projection, pi 0.87's
 * native wires (Anthropic tool_addition, Kimi tools system messages, Responses tool
 * search / additional_tools) and OpenRouter's server-side tool search.
 *
 * No real provider requests are made: native API streams are aborted from
 * `onPayload` after their complete request body has been captured.
 */
import { z } from "zod";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "./faux.ts";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamKimi } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Tool as PiTool,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  ConversationContext,
  defineAgent,
  defineModel,
  MemoryStore,
  replayContext,
  type Message,
  type ToolSchema,
} from "../index.ts";
import { ToolAccesses } from "../tool/access.ts";
import { tool } from "../tool/define.ts";
import { prepareToolCatalog, withToolLoads } from "../tool/search/catalog.ts";
import { OPENROUTER_TOOL_SEARCH, OPENROUTER_TOOL_SEARCH_MAX_RESULTS, supportsOpenRouterToolSearch, withOpenRouterToolSearch } from "../llm/openrouter-tool-search.ts";
import { acceptsMidConvoToolChanges } from "../llm/define-model.ts";
import { runSearchQuery, SEARCH_TOOL_NAME } from "../tool/search/deferral.ts";
import { buildSearchTool } from "../tool/search/search-tool.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const t = (name: string, description: string): ToolSchema => ({
  name,
  description,
  parameters: { type: "object" },
});

const CATALOG: ToolSchema[] = [
  t("Read", "Read a file from disk."),
  t("mcp__slack__send_message", "Send a message to a Slack channel."),
  t("mcp__slack__list_channels", "List Slack channels."),
  t("mcp__github__create_issue", "Create a GitHub issue."),
  t("NotebookEdit", "Edit a Jupyter notebook cell."),
];

const slackTool = tool({
  name: "mcp__slack__send_message",
  description: "Send a message to a Slack channel.",
  parameters: z.object({ text: z.string() }),
  accesses: ToolAccesses.none(),
  execute: ({ text }) => `sent:${text}`,
});

function testSearchCore(): void {
  const sel = runSearchQuery("select:Read,mcp__github__create_issue", CATALOG);
  check(
    "select: returns exact names",
    sel.queryType === "select" &&
      sel.matches.length === 2 &&
      sel.matches.includes("Read") &&
      sel.matches.includes("mcp__github__create_issue"),
  );

  const kw = runSearchQuery("slack", CATALOG);
  check(
    "keyword: matches Slack tools only",
    kw.queryType === "keyword" &&
      kw.matches.includes("mcp__slack__send_message") &&
      kw.matches.includes("mcp__slack__list_channels") &&
      !kw.matches.includes("Read"),
  );

  const req = runSearchQuery("+github issue", CATALOG);
  check(
    "required (+): filters candidates",
    req.matches.length === 1 && req.matches[0] === "mcp__github__create_issue",
  );

  const exact = runSearchQuery("NotebookEdit", CATALOG);
  check(
    "exact-name fast path",
    exact.matches.length === 1 && exact.matches[0] === "NotebookEdit",
  );
}

async function testSearchToolResult(): Promise<void> {
  const search = buildSearchTool(CATALOG);
  check("builtin: named SearchTool", search.schema.name === SEARCH_TOOL_NAME);
  check(
    "builtin: description stays fixed as catalogs change",
    search.schema.description === buildSearchTool([]).schema.description &&
      !search.schema.description.includes("mcp__slack__send_message") &&
      !search.schema.description.includes("NotebookEdit"),
  );

  const plan = await search.resolve(
    { query: "select:mcp__slack__send_message" },
    {} as Parameters<typeof search.resolve>[1],
  );
  const result = await plan.run({} as Parameters<typeof plan.run>[0]);
  const details = result.details as { deferredToolSchemas?: Array<{ schema: ToolSchema }> } | undefined;
  check(
    "builtin: records exactly the selected definition",
    details?.deferredToolSchemas?.length === 1 &&
      details.deferredToolSchemas[0]!.schema.name === "mcp__slack__send_message",
  );
}

function assistantCall(name: string, id: string, timestamp: number): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { query: `select:${name}` } }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp,
  };
}

function searchResult(id: string, timestamp: number, schemas: readonly ToolSchema[], isError = false): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: SEARCH_TOOL_NAME,
    content: [{ type: "text", text: "Loaded tools" }],
    details: { deferredToolSchemas: schemas.map((schema) => ({ sourceName: schema.name, schema })) },
    isError,
    timestamp,
  };
}

function testLoadProjection(): void {
  const declared = new Set([SEARCH_TOOL_NAME]);
  const project = (messages: Message[]) => withToolLoads(new ConversationContext({ history: messages }), declared);
  const base: Message[] = [{ role: "user", content: [{ type: "text", text: "send" }], timestamp: 1 }];
  check("projection: nothing declared before a search", project(base).length === 1);

  const other = { role: "toolResult", toolCallId: "read-1", toolName: "Read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 4 } satisfies Message;
  const loaded: Message[] = [...base, assistantCall(SEARCH_TOOL_NAME, "search-1", 2), searchResult("search-1", 3, [slackTool.schema]), other];
  const projected = project(loaded);
  check(
    "projection: declaration lands after the whole tool-result batch",
    projected.map((m) => m.role).join(",") === "user,assistant,toolResult,toolResult,system" &&
      getCurrentTools(projected).map((t) => t.name).join() === slackTool.schema.name,
  );
  const continued = project([...loaded, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 5 }]);
  check(
    "projection: an unchanged prefix projects byte-identically",
    JSON.stringify(continued.slice(0, projected.length)) === JSON.stringify(projected),
  );
  const again = project([...loaded, assistantCall(SEARCH_TOOL_NAME, "search-2", 5), searchResult("search-2", 6, [slackTool.schema])]);
  check("projection: a repeated load declares nothing new", again.filter((m) => m.role === "system").length === 1);
  const failed = project([...base, assistantCall(SEARCH_TOOL_NAME, "search-1", 2), searchResult("search-1", 3, [slackTool.schema], true)]);
  check("projection: a failed search is not a load point", failed.every((m) => m.role !== "system"));
  const micro = project([...base, assistantCall(SEARCH_TOOL_NAME, "search-1", 2), { ...searchResult("search-1", 3, [slackTool.schema]), content: [{ type: "text", text: "[Old tool result content cleared]" }] } as Message]);
  check("projection: a micro-cleared result still declares its definitions", getCurrentTools(micro).some((t) => t.name === slackTool.schema.name));
}

function testNativeGate(): void {
  const accepts = ["claude-opus-4-8", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "anthropic/claude-sonnet-5.5", "claude-opus-5-20260101"];
  const rejects = ["claude-sonnet-5", "claude-sonnet-4-5", "claude-opus-4-7", "claude-haiku-4-5", "gpt-5.5"];
  check("gate: Anthropic mid-conversation tool changes from Opus 4.8 on", accepts.every(acceptsMidConvoToolChanges));
  check("gate: Sonnet 5, older Claude and non-Claude are excluded", !rejects.some(acceptsMidConvoToolChanges));
}

async function testFrameworkFlow(): Promise<void> {
  const faux = registerFauxProvider({
    api: "anthropic-messages",
    provider: "anthropic",
    models: [{ id: "claude-opus-5-5" }],
  });
  const topLevel = (context: TranscriptContext) => (getInitialSystemMessage(context.messages)?.toolsAdded ?? []).map((t) => t.name);
  faux.setResponses([
    (context) => {
      const names = topLevel(context);
      check(
        "framework: initial request has SearchTool but not deferred schema",
        names.includes(SEARCH_TOOL_NAME) &&
          !getCurrentTools(context.messages).some((t) => t.name === slackTool.schema.name),
      );
      return fauxAssistantMessage(
        fauxToolCall(SEARCH_TOOL_NAME, {
          query: `select:${slackTool.schema.name}`,
        }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const last = context.messages.at(-1);
      check(
        "framework: next step declares the selected schema at the load point",
        last?.role === "system" &&
          last.toolsAdded?.some((t) => t.name === slackTool.schema.name) === true &&
          !topLevel(context).includes(slackTool.schema.name),
      );
      return fauxAssistantMessage(
        fauxToolCall(slackTool.schema.name, { text: "hello" }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);

  try {
    const model = faux.getChatModel()!;
    check("framework: Opus 5.5 gets native deferral from the id rule", model.supportsDeferredTools && !model.serverToolSearch);
    const agent = defineAgent({
      name: "deferred",
      model,
      instructions: "x",
      deferTools: true,
    });
    const store = new MemoryStore();
    const result = await testRunner({
      store,
      capabilities: [{ name: "deferred-test", tools: [slackTool] }],
      permission: { mode: "yolo" },
    }).run(agent, "send");
    check("framework: selected capability executes", result.output.includes("done"));
    check(
      "framework: capability result is present",
      result.messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === slackTool.schema.name &&
          message.content.some(
            (part) => part.type === "text" && part.text === "sent:hello",
          ),
      ),
    );
    const replayed = await replayContext(store, "main");
    check(
      "framework: the load point survives durable replay, journal holds no system message",
      withToolLoads(replayed, new Set([SEARCH_TOOL_NAME])).some((m) => m.role === "system" && m.toolsAdded?.[0]?.name === slackTool.schema.name) &&
        replayed.history.every((m) => m.role !== "system"),
    );
  } finally {
    faux.unregister();
  }
}

const PI_TOOLS: PiTool[] = [
  {
    name: SEARCH_TOOL_NAME,
    description: "Search deferred tools.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "Read",
    description: "Read a file.",
    parameters: { type: "object" },
  },
];

const SLACK_PI: PiTool = {
  name: slackTool.schema.name,
  description: slackTool.schema.description,
  parameters: slackTool.schema.parameters as PiTool["parameters"],
};

/** The transcript `executeStep` sends after a SearchTool load, as pi receives it. */
function wireContext(api: Api, provider: string, model: string): TranscriptContext {
  return {
    messages: [
      { role: "system", content: "test", toolsAdded: PI_TOOLS, timestamp: 0 },
      { role: "user", content: "send a Slack message", timestamp: 1 },
      { ...(assistantCall(SEARCH_TOOL_NAME, "search-call", 2) as Extract<Message, { role: "assistant" }>), api, provider, model },
      searchResult("search-call", 3, [slackTool.schema]),
      { role: "system", content: "", toolsAdded: [SLACK_PI], timestamp: 3 },
    ],
  };
}

type WireStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

async function capturePayload(
  streamFunction: unknown,
  model: Model<Api>,
  context: TranscriptContext = wireContext(model.api, model.provider, model.id),
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let payload: unknown;
  const stream = (streamFunction as WireStream)(model, context, {
    apiKey: "test",
    signal: controller.signal,
    maxRetries: 0,
    onPayload: (next) => {
      payload = next;
      controller.abort();
      return next;
    },
  });
  for await (const _event of stream) {
    // Drain the terminal abort event; payload construction already completed.
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("pi did not expose a provider payload");
  }
  return payload as Record<string, unknown>;
}

function model<TApi extends Api>(
  api: TApi,
  provider: string,
  id: string,
  compat: Record<string, unknown>,
  baseUrl = "http://127.0.0.1:1",
): Model<TApi> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat,
  } as Model<TApi>;
}

async function testAnthropicWire(): Promise<void> {
  const payload = await capturePayload(
    streamAnthropic,
    model("anthropic-messages", "anthropic", "claude-opus-5-5", {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    }) as Model<Api>,
  );
  const tools = payload.tools as Array<Record<string, unknown>>;
  const deferred = tools.find((candidate) => candidate.name === slackTool.schema.name);
  check("pi/Anthropic: loaded schema is defer_loading", deferred?.defer_loading === true);
  const messages = payload.messages as Array<{ role: string; content: unknown }>;
  const addition = messages.find((message) => message.role === "system");
  check(
    "pi/Anthropic: load point becomes a tool_addition system turn",
    JSON.stringify(addition?.content).includes('"type":"tool_addition"') &&
      JSON.stringify(addition?.content).includes(`"name":"${slackTool.schema.name}"`),
  );
}

async function testKimiWire(): Promise<void> {
  const payload = await capturePayload(
    streamKimi,
    model("openai-completions", "moonshotai", "kimi-k3", {
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolAdditions: true,
    }) as Model<Api>,
  );
  const tools = payload.tools as Array<{ function?: { name?: string } }>;
  const topNames = tools.map((candidate) => candidate.function?.name);
  check(
    "pi/Kimi: selected schema stays out of prefix tools",
    !topNames.includes(slackTool.schema.name) && topNames.includes(SEARCH_TOOL_NAME),
  );
  const messages = payload.messages as Array<Record<string, unknown>>;
  const injected = messages.find((message) => message.role === "system" && Array.isArray(message.tools));
  check("pi/Kimi: selected schema injected in message.tools", JSON.stringify(injected).includes(slackTool.schema.name));
}

async function testResponsesWire(): Promise<void> {
  const payload = await capturePayload(
    streamResponses,
    model("openai-responses", "openai", "gpt-5.4", {
      supportsMidConvoSystemMessages: true,
      supportsToolSearch: true,
    }) as Model<Api>,
  );
  const tools = payload.tools as Array<{ name?: string }>;
  check(
    "pi/Responses: selected schema stays out of prefix tools",
    !tools.some((candidate) => candidate.name === slackTool.schema.name) &&
      tools.some((candidate) => candidate.name === SEARCH_TOOL_NAME),
  );
  const serialized = JSON.stringify(payload.input);
  check(
    "pi/Responses: emits tool_search_call/output",
    serialized.includes('"type":"tool_search_call"') &&
      serialized.includes('"type":"tool_search_output"') &&
      serialized.includes(slackTool.schema.name),
  );
  const additional = await capturePayload(
    streamResponses,
    model("openai-responses", "openai", "gpt-5.6-sol", {
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
    }) as Model<Api>,
  );
  check(
    "pi/Responses: additional_tools anchors the load where supported",
    JSON.stringify(additional.input).includes('"type":"additional_tools"') &&
      !(additional.tools as Array<{ name?: string }>).some((candidate) => candidate.name === slackTool.schema.name),
  );
}

async function testOpenRouterServerSearch(): Promise<void> {
  const openrouter = model("openai-responses", "openrouter-responses", "deepseek/deepseek-v4-flash", {}, "https://openrouter.ai/api/v1") as Model<Api>;
  check("openrouter: Responses API on openrouter.ai searches server-side", supportsOpenRouterToolSearch(openrouter));
  check(
    "openrouter: not on Chat Completions nor on other hosts",
    !supportsOpenRouterToolSearch({ ...openrouter, api: "openai-completions" }) &&
      !supportsOpenRouterToolSearch({ ...openrouter, baseUrl: "https://example.com/openrouter.ai" }),
  );

  // Catalog: every tool executes and is sent; capability ones marked deferLoading.
  const read = tool({ name: "Read", description: "Read a file.", parameters: z.object({}), accesses: ToolAccesses.none(), execute: () => "" });
  const prepared = prepareToolCatalog(new ConversationContext(), {
    tools: [read, slackTool],
    deferredToolNames: new Set([slackTool.schema.name]),
    deferEnabled: false,
    serverToolSearch: true,
  });
  check(
    "openrouter: capability tools sent deferLoading, no SearchTool, all executable",
    prepared.requestTools.find((s) => s.name === slackTool.schema.name)?.deferLoading === true &&
      prepared.requestTools.find((s) => s.name === "Read")?.deferLoading === undefined &&
      !prepared.requestTools.some((s) => s.name === SEARCH_TOOL_NAME) &&
      prepared.tools.includes(slackTool),
  );

  // Wire: pi's Responses payload rewritten at the onPayload seam.
  const context: TranscriptContext = {
    messages: [
      { role: "system", content: "test", toolsAdded: [PI_TOOLS[1]!, SLACK_PI], timestamp: 0 },
      { role: "user", content: "send a Slack message", timestamp: 1 },
    ],
  };
  const controller = new AbortController();
  let payload: Record<string, unknown> | undefined;
  const options = withOpenRouterToolSearch(
    {
      apiKey: "test",
      signal: controller.signal,
      maxRetries: 0,
      onPayload: (next) => {
        payload = next as Record<string, unknown>;
        controller.abort();
        return next;
      },
    },
    new Set([slackTool.schema.name]),
  );
  for await (const _event of (streamResponses as unknown as WireStream)(openrouter, context, options as SimpleStreamOptions)) {
    // drain
  }
  const tools = (payload?.tools ?? []) as Array<{ type?: string; name?: string; defer_loading?: boolean; parameters?: { max_results?: number } }>;
  check(
    "openrouter: search tool leads with a raised max_results, only the capability tool is defer_loading",
    tools[0]?.type === OPENROUTER_TOOL_SEARCH &&
      tools[0]?.parameters?.max_results === OPENROUTER_TOOL_SEARCH_MAX_RESULTS &&
      tools.find((t) => t.name === slackTool.schema.name)?.defer_loading === true &&
      tools.find((t) => t.name === "Read")?.defer_loading === undefined,
  );
}

async function testOpenRouterFramework(): Promise<void> {
  const faux = registerFauxProvider({ api: "openai-responses", provider: "openrouter-responses", models: [{ id: "deepseek/deepseek-v4-flash" }] });
  faux.setResponses([
    (context) => {
      const names = (getInitialSystemMessage(context.messages)?.toolsAdded ?? []).map((t) => t.name);
      check("openrouter/framework: capability tool sent up front, no SearchTool", names.includes(slackTool.schema.name) && !names.includes(SEARCH_TOOL_NAME));
      return fauxAssistantMessage(fauxToolCall(slackTool.schema.name, { text: "direct" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  try {
    const descriptor = faux.getModel()!;
    const model = defineModel({ runtime: faux.runtime, descriptor: { ...descriptor, baseUrl: "https://openrouter.ai/api/v1" } as Model<Api> });
    check("openrouter/framework: model searches server-side, not via SearchTool", model.serverToolSearch && !model.supportsDeferredTools);
    const agent = defineAgent({ name: "or", model, instructions: "x" });
    const result = await testRunner({ capabilities: [{ name: "deferred-test", tools: [slackTool] }], permission: { mode: "yolo" } }).run(agent, "send");
    check(
      "openrouter/framework: a revealed capability tool executes without a load point",
      result.messages.some((m) => m.role === "toolResult" && m.toolName === slackTool.schema.name && !m.isError),
    );
  } finally {
    faux.unregister();
  }
}

async function main(): Promise<void> {
  testSearchCore();
  await testSearchToolResult();
  testLoadProjection();
  testNativeGate();
  await testFrameworkFlow();
  await testAnthropicWire();
  await testKimiWire();
  await testResponsesWire();
  await testOpenRouterServerSearch();
  await testOpenRouterFramework();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log(
      "✅ DEFER E2E PASS — SearchTool + toolsAdded load points + pi native Anthropic/Kimi/Responses wire + OpenRouter server search",
    );
  } else {
    console.log("❌ DEFER E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ DEFER E2E ERROR:", error);
  process.exit(1);
});
