import { testRunner, openTestSession } from "./faux.ts";
/**
 * Deferred tool loading — Operon activation + pi 0.81 native wire coverage.
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
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Tool as PiTool,
} from "@earendil-works/pi-ai";
import {
  defineAgent,
  defineModel,
  MemoryStore,
  replayContext,
  Runner,
  type Message,
  type ToolSchema,
} from "../index.ts";
import { ToolAccesses } from "../tool/access.ts";
import { tool } from "../tool/define.ts";
import { activeDeferredTools } from "../tool/search/activation.ts";
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
    "builtin: description announces deferred names",
    search.schema.description.includes("<available-deferred-tools>") &&
      search.schema.description.includes("mcp__slack__send_message") &&
      search.schema.description.includes("NotebookEdit"),
  );

  const plan = await search.resolve(
    { query: "select:mcp__slack__send_message" },
    {} as Parameters<typeof search.resolve>[1],
  );
  const result = await plan.run({} as Parameters<typeof plan.run>[0]);
  check(
    "builtin: emits pi addedToolNames",
    result.addedToolNames?.length === 1 &&
      result.addedToolNames[0] === "mcp__slack__send_message",
  );
}

function testActivationAndCompactionSemantics(): void {
  const search = buildSearchTool([slackTool.schema]);
  const tools = [search, slackTool];
  const deferred = new Set([slackTool.schema.name]);
  const base: Message[] = [
    { role: "user", content: [{ type: "text", text: "send" }], timestamp: 1 },
  ];
  check(
    "activation: candidate hidden before search",
    !activeDeferredTools(tools, deferred, base).includes(slackTool),
  );

  const loaded: Message[] = [
    ...base,
    {
      role: "toolResult",
      toolCallId: "search-1",
      toolName: SEARCH_TOOL_NAME,
      content: [{ type: "text", text: "Loaded tools: mcp__slack__send_message" }],
      addedToolNames: [slackTool.schema.name],
      isError: false,
      timestamp: 2,
    },
  ];
  check(
    "activation: addedToolNames exposes selected schema",
    activeDeferredTools(tools, deferred, loaded).includes(slackTool),
  );

  const used: Message[] = [
    ...base,
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "slack-1",
          name: slackTool.schema.name,
          arguments: { text: "hello" },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
  ];
  check(
    "activation: surviving toolCall keeps an already-used schema immediate",
    activeDeferredTools(tools, deferred, used).includes(slackTool),
  );

  const micro: Message[] = [
    {
      ...loaded[1]!,
      content: [{ type: "text", text: "[Old tool result content cleared]" }],
    },
  ];
  check(
    "compaction: micro-cleared result keeps activation",
    activeDeferredTools(tools, deferred, micro).includes(slackTool),
  );
  check(
    "compaction: full removal unloads old selection",
    !activeDeferredTools(tools, deferred, base).includes(slackTool),
  );
}

async function testFrameworkFlow(): Promise<void> {
  const faux = registerFauxProvider({
    api: "anthropic-messages",
    provider: "anthropic",
    models: [{ id: "claude-sonnet-4-5" }],
  });
  faux.setResponses([
    (context) => {
      const names = context.tools?.map((candidate) => candidate.name) ?? [];
      check(
        "framework: initial request has SearchTool but not deferred schema",
        names.includes(SEARCH_TOOL_NAME) &&
          !names.includes(slackTool.schema.name),
      );
      return fauxAssistantMessage(
        fauxToolCall(SEARCH_TOOL_NAME, {
          query: `select:${slackTool.schema.name}`,
        }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const names = context.tools?.map((candidate) => candidate.name) ?? [];
      const load = [...context.messages]
        .reverse()
        .find((message) => message.role === "toolResult" && message.toolName === SEARCH_TOOL_NAME);
      check(
        "framework: next step includes selected schema",
        names.includes(slackTool.schema.name),
      );
      check(
        "framework: persisted ToolResult carries addedToolNames",
        load?.role === "toolResult" &&
          load.addedToolNames?.[0] === slackTool.schema.name,
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
      "framework: addedToolNames survives durable replay",
      replayed.history.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === SEARCH_TOOL_NAME &&
          message.addedToolNames?.[0] === slackTool.schema.name,
      ),
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
  {
    name: slackTool.schema.name,
    description: slackTool.schema.description,
    parameters: slackTool.schema.parameters,
  },
];

function wireContext(api: Api, provider: string, model: string): Context {
  return {
    systemPrompt: "test",
    tools: PI_TOOLS,
    messages: [
      {
        role: "user",
        content: "send a Slack message",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "search-call",
            name: SEARCH_TOOL_NAME,
            arguments: { query: "slack" },
          },
        ],
        api,
        provider,
        model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "search-call",
        toolName: SEARCH_TOOL_NAME,
        content: [{ type: "text", text: `Loaded tools: ${slackTool.schema.name}` }],
        addedToolNames: [slackTool.schema.name],
        isError: false,
        timestamp: 3,
      },
    ],
  };
}

type WireStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

async function capturePayload(
  streamFunction: unknown,
  model: Model<Api>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let payload: unknown;
  const stream = (streamFunction as WireStream)(
    model,
    wireContext(model.api, model.provider, model.id),
    {
      apiKey: "test",
      signal: controller.signal,
      maxRetries: 0,
      onPayload: (next) => {
        payload = next;
        controller.abort();
        return next;
      },
    },
  );
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
  compat: Model<TApi>["compat"],
): Model<TApi> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat,
  };
}

async function testAnthropicWire(): Promise<void> {
  const payload = await capturePayload(
    streamAnthropic,
    model(
      "anthropic-messages",
      "anthropic",
      "claude-sonnet-4-5",
      { supportsToolReferences: true },
    ) as Model<Api>,
  );
  const tools = payload.tools as Array<Record<string, unknown>>;
  const deferred = tools.find((candidate) => candidate.name === slackTool.schema.name);
  check(
    "pi/Anthropic: loaded schema is defer_loading",
    deferred?.defer_loading === true,
  );
  const messages = payload.messages as Array<Record<string, unknown>>;
  const serialized = JSON.stringify(messages);
  check(
    "pi/Anthropic: ToolResult becomes tool_reference",
    serialized.includes('"type":"tool_reference"') &&
      serialized.includes(`"tool_name":"${slackTool.schema.name}"`),
  );
}

async function testKimiWire(): Promise<void> {
  const payload = await capturePayload(
    streamKimi,
    model(
      "openai-completions",
      "moonshotai",
      "kimi-k3",
      { deferredToolsMode: "kimi" },
    ) as Model<Api>,
  );
  const tools = payload.tools as Array<{
    function?: { name?: string };
  }>;
  const topNames = tools.map((candidate) => candidate.function?.name);
  check(
    "pi/Kimi: selected schema removed from prefix tools",
    !topNames.includes(slackTool.schema.name) &&
      topNames.includes(SEARCH_TOOL_NAME),
  );
  const messages = payload.messages as Array<Record<string, unknown>>;
  const injected = messages.find(
    (message) => message.role === "system" && Array.isArray(message.tools),
  );
  check(
    "pi/Kimi: selected schema injected in message.tools",
    JSON.stringify(injected).includes(slackTool.schema.name),
  );
}

async function testResponsesWire(): Promise<void> {
  const payload = await capturePayload(
    streamResponses,
    model(
      "openai-responses",
      "openai",
      "gpt-5.4",
      { supportsToolSearch: true },
    ) as Model<Api>,
  );
  const tools = payload.tools as Array<{ name?: string }>;
  check(
    "pi/Responses: selected schema removed from prefix tools",
    !tools.some((candidate) => candidate.name === slackTool.schema.name) &&
      tools.some((candidate) => candidate.name === SEARCH_TOOL_NAME),
  );
  const input = payload.input as Array<Record<string, unknown>>;
  const serialized = JSON.stringify(input);
  check(
    "pi/Responses: emits tool_search_call/output",
    serialized.includes('"type":"tool_search_call"') &&
      serialized.includes('"type":"tool_search_output"') &&
      serialized.includes(slackTool.schema.name),
  );
}

async function main(): Promise<void> {
  testSearchCore();
  await testSearchToolResult();
  testActivationAndCompactionSemantics();
  await testFrameworkFlow();
  await testAnthropicWire();
  await testKimiWire();
  await testResponsesWire();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log(
      "✅ DEFER E2E PASS — SearchTool + dynamic activation/compaction + pi native Anthropic/Kimi/Responses wire",
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
