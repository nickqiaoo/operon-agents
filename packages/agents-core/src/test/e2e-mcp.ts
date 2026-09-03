import { testRunner, openTestSession } from "./faux.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineModel, defineAgent, Runner, LocalMachine, type RunContext, type Message } from "../index.ts";
import { testRunContext } from "./faux.ts";
import {
  TransportMCPServer,
  MockMCPTransport,
  mcpCapability,
  mcpToolProvider,
  qualifyMcpToolName,
  mcpResultToContent,
  wrapMcpTool,
  type MockMCPFixture,
  type MCPServer,
} from "../mcp/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function fixture(): MockMCPFixture {
  return {
    name: "mock",
    tools: [
      { name: "echo", description: "Echo back the text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "danger", description: "A dangerous tool." },
      { name: "shot", description: "Returns an image." },
      { name: "boom", description: "Always fails." },
    ],
    call: async (name, args) => {
      if (name === "echo") return { content: [{ type: "text", text: `echoed: ${String(args?.["text"])}` }] };
      if (name === "shot") return { content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] };
      if (name === "boom") throw new Error("kaboom");
      return { content: [{ type: "text", text: "danger ran" }] };
    },
    resources: [{ uri: "mem://notes", name: "Notes", mimeType: "text/plain", text: "hello" }],
  };
}

function makeServer(overrides: Partial<ConstructorParameters<typeof TransportMCPServer>[0]> = {}): { server: MCPServer; transport: MockMCPTransport } {
  const transport = new MockMCPTransport(fixture());
  const server = new TransportMCPServer({ name: "mock", transport, ...overrides });
  return { server, transport };
}

const minimalCtx = (machine: LocalMachine): RunContext => testRunContext({ machine });

function toolResult(messages: readonly Message[], name: string): { text: string; isError: boolean } {
  const m = [...messages].reverse().find((x) => x.role === "toolResult" && x.toolName === name);
  if (!m || m.role !== "toolResult") return { text: "", isError: false };
  return { text: m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(""), isError: m.isError ?? false };
}

function reminderText(messages: readonly Message[]): string {
  return messages.filter((m) => m.role === "user").flatMap((m) => m.content).map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function testNaming(): void {
  check("naming: basic qualify", qualifyMcpToolName("github", "create_pr") === "mcp__github__create_pr");
  check("naming: illegal chars sanitized + collapsed", qualifyMcpToolName("my server", "do/it") === "mcp__my_server__do_it" && qualifyMcpToolName("x", "a!!b") === "mcp__x__a_b");
  const long = qualifyMcpToolName("a".repeat(40), "b".repeat(40));
  check("naming: over-long truncated to <=64 with hash", long.length <= 64 && long.startsWith("mcp__") && /_[0-9a-f]{8}$/.test(long));
}

function testConversion(): void {
  const text = mcpResultToContent({ content: [{ type: "text", text: "hi" }] }, "mcp__m__t");
  check("conversion: text passthrough", !text.isError && text.content.length === 1 && text.content[0]?.type === "text" && (text.content[0] as { text: string }).text === "hi");

  const img = mcpResultToContent({ content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] }, "mcp__m__shot");
  const imgFirst = img.content[0];
  check("conversion: image-only wrapped + image part kept", imgFirst?.type === "text" && (imgFirst as { text: string }).text === '<mcp_tool_result name="mcp__m__shot">' && img.content.some((p) => p.type === "image"));

  const audio = mcpResultToContent({ content: [{ type: "audio", data: "x", mimeType: "audio/mpeg" }] }, "mcp__m__a");
  check("conversion: audio → text note", audio.content.some((p) => p.type === "text" && p.text.includes("audio content omitted")));

  const big = mcpResultToContent({ content: [{ type: "text", text: "x".repeat(100_001) }] }, "mcp__m__t");
  const bigText = big.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  check("conversion: 100K text budget truncates + notice", bigText.includes("Output truncated") && bigText.length <= 100_000 + 200);

  const err = mcpResultToContent({ content: [{ type: "text", text: "bad" }], isError: true }, "mcp__m__t");
  check("conversion: isError propagated", err.isError);
}

async function testCache(): Promise<void> {
  const cached = makeServer({ cacheToolsList: true });
  await cached.server.connect();
  await cached.server.listTools();
  await cached.server.listTools();
  check("cache: cacheToolsList → one transport round-trip", cached.transport.listToolsCalls === 1);
  await cached.server.invalidateToolsCache();
  await cached.server.listTools();
  check("cache: invalidateToolsCache forces a refetch", cached.transport.listToolsCalls === 2);
  await cached.server.close();

  const uncached = makeServer({ cacheToolsList: false });
  await uncached.server.connect();
  await uncached.server.listTools();
  await uncached.server.listTools();
  check("cache: off → a round-trip per list", uncached.transport.listToolsCalls === 2);
  await uncached.server.close();

  // The toolset is rebuilt every turn, so an uncached default would put a round trip in
  // front of every model request. Default matches serverFromConfig/mcpServersCapability.
  const byDefault = makeServer();
  await byDefault.server.connect();
  await byDefault.server.listTools();
  await byDefault.server.listTools();
  check("cache: on by default", byDefault.transport.listToolsCalls === 1);
  await byDefault.server.close();
}

async function testFilter(machine: LocalMachine): Promise<void> {
  const blocked = makeServer({ toolFilter: { blockedToolNames: ["danger", "boom"] } });
  await blocked.server.connect();
  const blockedNames = (await mcpToolProvider(blocked.server).listTools(minimalCtx(machine))).map((t) => t.schema.name);
  check("filter: block excludes named tools", !blockedNames.includes("mcp__mock__danger") && blockedNames.includes("mcp__mock__echo"));
  await blocked.server.close();

  const allowed = makeServer({ toolFilter: { allowedToolNames: ["echo"] } });
  await allowed.server.connect();
  const allowedNames = (await mcpToolProvider(allowed.server).listTools(minimalCtx(machine))).map((t) => t.schema.name);
  check("filter: allow restricts to the listed tools", allowedNames.length === 1 && allowedNames[0] === "mcp__mock__echo");
  await allowed.server.close();
}

async function testToolCall(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp__mock__echo", { text: "world" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("relayed the echo", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const { server, transport } = makeServer();
  const runner = testRunner({ machine, capabilities: [mcpCapability([server])], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "use the mcp tool");
  faux.unregister();

  const r = toolResult(result.messages, "mcp__mock__echo");
  check("tool call: MCP result converted into transcript", !r.isError && r.text.includes("echoed: world"));
  check("lifecycle: server connected on start", transport.connectCalls === 1);
  check("lifecycle: server closed on stop", transport.closeCalls === 1);
}

async function testPermissionGlob(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp__mock__danger", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("ok", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const { server } = makeServer();
  const runner = testRunner({
    machine,
    capabilities: [mcpCapability([server])],
    permission: { mode: "yolo", rules: [{ decision: "deny", scope: "user", pattern: "mcp__mock__*" }] },
  });
  const result = await runner.run(agent, "try the dangerous tool");
  faux.unregister();

  const r = toolResult(result.messages, "mcp__mock__danger");
  check("permission: mcp__mock__* deny rule blocks the tool (Ring 3 glob)", r.isError && !r.text.includes("danger ran"));
}

async function testResourcesInjection(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const { server } = makeServer();
  const runner = testRunner({ machine, capabilities: [mcpCapability([server], { injectResources: true })], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "hello");
  faux.unregister();

  check("resources: discovered resources injected at session start", reminderText(result.messages).includes("mem://notes"));
}

async function testErrorFunction(machine: LocalMachine): Promise<void> {
  const { server } = makeServer({ errorFunction: ({ toolName }) => `custom failure for ${toolName}` });
  await server.connect();
  const tool = wrapMcpTool(server, { name: "boom" });
  const plan = await tool.resolve({}, { turnId: "t", toolCallId: "c", signal: new AbortController().signal, machine });
  const res = await plan.run({ turnId: "t", toolCallId: "c", signal: new AbortController().signal, machine });
  check("errorFunction: failure → model-visible text", res.isError === true && res.content.some((c) => c.type === "text" && c.text.includes("custom failure for boom")));
  await server.close();

  const { server: rethrow } = makeServer({ errorFunction: null });
  await rethrow.connect();
  const toolR = wrapMcpTool(rethrow, { name: "boom" });
  const planR = await toolR.resolve({}, { turnId: "t", toolCallId: "c", signal: new AbortController().signal, machine });
  let threw = false;
  try {
    await planR.run({ turnId: "t", toolCallId: "c", signal: new AbortController().signal, machine });
  } catch {
    threw = true;
  }
  check("errorFunction: null → rethrow", threw);
  await rethrow.close();
}

async function main(): Promise<void> {
  const machine = new LocalMachine(process.cwd());
  testNaming();
  testConversion();
  await testCache();
  await testFilter(machine);
  await testToolCall(machine);
  await testPermissionGlob(machine);
  await testResourcesInjection(machine);
  await testErrorFunction(machine);

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP E2E PASS — naming + conversion + cache + filter + tool call + permission glob + resources + errorFunction");
  } else {
    console.log("❌ MCP E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MCP E2E ERROR:", error);
  process.exit(1);
});
