import { testRunner, openTestSession } from "./faux.ts";
import {
  BackgroundManager,
  MemoryStore,
  Runner,
  Session,
  StoreBackgroundTaskPersistence,
  backgroundCapability,
  defineAgent,
  type Message,
  type PersistedTask,
} from "../index.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const store = new MemoryStore();
  const calls = [
    fauxToolCall("Bash", { command: "long-build", run_in_background: true }, { id: "call-bg" }),
    fauxToolCall("Agent", { prompt: "investigate", description: "investigate" }, { id: "call-agent" }),
    fauxToolCall("Workflow", { script: "return 1" }, { id: "call-workflow" }),
    fauxToolCall("Bash", { command: "already-finished" }, { id: "call-done" }),
  ];
  const interrupted = fauxAssistantMessage(calls, { stopReason: "toolUse", timestamp: 10 });
  await store.appendRecord({
    address: "main",
    type: "context.append_message",
    message: { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
  });
  await store.appendRecord({ address: "main", type: "context.append_message", message: interrupted });
  await store.appendRecord({
    address: "main",
    type: "context.append_message",
    message: {
      role: "toolResult",
      toolCallId: "call-done",
      toolName: "Bash",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 11,
    },
  });

  await store.appendRecord({
    address: "main/coder-real",
    type: "custom",
    name: "subagent_meta",
    data: {
      agentId: "coder-real",
      type: "coder",
      background: false,
      parentAddress: "main",
      parentToolCallId: "call-agent",
    },
  });
  await store.appendRecord({
    address: "workflow:wf-real",
    type: "custom",
    name: "wf_journal",
    data: {
      type: "run",
      runId: "wf-real",
      name: "recoverable",
      scriptBody: "return 1",
      parentAddress: "main",
      parentToolCallId: "call-workflow",
    },
  });

  const now = Date.now();
  const background: PersistedTask = {
    schemaVersion: 2,
    revision: 1,
    taskId: "bash-real",
    kind: "process",
    parentAddress: "main",
    toolCallId: "call-bg",
    description: "long build",
    status: "running",
    startedAt: now - 1000,
    endedAt: null,
    command: "long-build",
    exitCode: null,
    outputRef: { kind: "file", path: "/tmp/long-build.log" },
  };
  await new StoreBackgroundTaskPersistence(store).writeTask(background);

  let providerMessages: readonly Message[] = [];
  let providerSystem = "";
  const faux = registerFauxProvider();
  faux.setResponses([
    (context) => {
      providerMessages = context.messages;
      providerSystem = context.systemPrompt ?? "";
      return fauxAssistantMessage("continued", { stopReason: "stop" });
    },
  ]);
  const manager = new BackgroundManager();
  const session = await openTestSession({ store, capabilities: [backgroundCapability(manager)] });
  const runner = testRunner();
  const agent = defineAgent({ name: "main", model: faux.getChatModel()!, instructions: "coordinate" });
  const result = await runner.run(agent, "continue", { session });
  faux.unregister();

  check("recovery: background task recovered from origin", providerSystem.includes("recovered_task_id: bash-real"));
  check("recovery: foreground agent id recovered from its shard meta", providerSystem.includes("recovered_agent_id: coder-real"));
  check("recovery: foreground workflow id recovered from its journal", providerSystem.includes("recovered_run_id: wf-real"));
  check("recovery: already-paired sibling omitted", !providerSystem.includes("tool_call_id: call-done"));
  check(
    "recovery: Core leaves protocol synthesis to Pi",
    !providerMessages.some((message) => message.role === "toolResult" && message.isError === true),
  );
  const piMessages = transformMessages([...providerMessages], {
    id: "claude-test",
    name: "Claude Test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  });
  const syntheticIds = piMessages
    .filter((message) => message.role === "toolResult" && message.isError === true)
    .map((message) => message.toolCallId);
  check(
    "recovery: Pi pairs every missing call in the batch",
    ["call-bg", "call-agent", "call-workflow"].every((id) => syntheticIds.includes(id)),
  );
  const durableSynthetic = result.messages.filter(
    (message) => message.role === "toolResult" && message.isError === true,
  );
  check("recovery: synthetic Pi results are not journaled", durableSynthetic.length === 0);

  await session.close();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) process.exit(1);
  console.log("✅ E2E PASS — crash recovery identity correlation");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
