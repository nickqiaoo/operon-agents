import { testRunner, openTestSession } from "./faux.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  askUserQuestionTool,
  defineAgent,
  defineModel,
  LocalMachine,
  MemoryStore,
  readTool,
  Runner,
  todoCapability,
  TodoStore,
  TodoListInjector,
  type ApprovalRequest,
  type ApprovalResponse,
  type Message,
  type QuestionRequest,
  type QuestionResult,
  type Responder,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function toolResult(messages: readonly Message[], name: string): Extract<Message, { role: "toolResult" }> | undefined {
  return [...messages].reverse().find((message): message is Extract<Message, { role: "toolResult" }> => {
    return message.role === "toolResult" && message.toolName === name;
  });
}

function toolResultText(messages: readonly Message[], name: string): string {
  const result = toolResult(messages, name);
  return result?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
}

function allUserText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

async function testReadImage(dir: string, machine: LocalMachine): Promise<void> {
  const imagePath = join(dir, "one.png");
  writeFileSync(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Read", { path: imagePath }), { stopReason: "toolUse" }),
    fauxAssistantMessage("image read", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "media", model, instructions: "x", tools: [readTool] });

  const runner = testRunner({ machine, permission: { mode: "yolo" } });
  const result = await runner.run(agent, "inspect image");
  faux.unregister();

  const media = toolResult(result.messages, "Read");
  check("read image: tool result contains image part", media?.content.some((part) => part.type === "image") === true);
  check("read image: system summary includes dimensions", toolResultText(result.messages, "Read").includes("Original dimensions: 1x1"));
}

async function testTodoList(machine: LocalMachine): Promise<void> {
  const store = new MemoryStore();
  const todoStore = new TodoStore();

  const firstFaux = registerFauxProvider();
  firstFaux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("TodoList", {
        todos: [
          { title: "Draft patch", status: "in_progress" },
          { title: "Run tests", status: "pending" },
        ],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("todo updated", { stopReason: "stop" }),
  ]);
  const firstModel = firstFaux.getChatModel()!;
  const firstAgent = defineAgent({ name: "todo", model: firstModel, instructions: "x" });
  const runner = testRunner({ machine, store, capabilities: [todoCapability(todoStore)], permission: { mode: "yolo" } });
  const first = await runner.run(firstAgent, "track this");
  firstFaux.unregister();
  check("todo: update tool returns list", toolResultText(first.messages, "TodoList").includes("[in_progress] Draft patch"));

  const secondFaux = registerFauxProvider();
  secondFaux.setResponses([fauxAssistantMessage("saw todo reminder", { stopReason: "stop" })]);
  const secondModel = secondFaux.getChatModel()!;
  const secondAgent = defineAgent({ name: "todo", model: secondModel, instructions: "x" });
  const second = await runner.run(secondAgent, "continue");
  secondFaux.unregister();

  // Occasional-nudge: the run right after a write is throttled — no reminder yet.
  check("todo: no reminder right after a write (throttled)", !allUserText(second.messages).includes("TodoList tool has not been updated"));

  // Directly exercise the throttle: a stale history (many assistant turns, no recent write) nudges,
  // and the nudge carries the current list; a history with a recent write stays silent.
  const injector = new TodoListInjector(todoStore);
  const staleHistory: Message[] = Array.from({ length: 12 }, () => ({ role: "assistant", content: [{ type: "text", text: "working" }], timestamp: Date.now() }) as Message);
  const staleResult = injector.inject({ history: staleHistory, sessionId: "s", address: "main", originOf: () => undefined });
  check("todo: nudges when the list has gone stale", staleResult !== null && staleResult.text.includes("[in_progress] Draft patch"));

  const freshInjector = new TodoListInjector(todoStore);
  const freshHistory: Message[] = [{ role: "toolResult", toolCallId: "c", toolName: "TodoList", content: [{ type: "text", text: "updated" }], timestamp: Date.now() } as Message];
  check(
    "todo: stays silent right after a TodoList write",
    freshInjector.inject({ history: freshHistory, sessionId: "s", address: "main", originOf: () => undefined }) === null,
  );
}

async function testAskUserQuestion(machine: LocalMachine): Promise<void> {
  const responder: Responder = {
    requestApproval(_request: ApprovalRequest): Promise<ApprovalResponse> {
      return Promise.resolve({ decision: "approved" });
    },
    requestQuestion(_request: QuestionRequest): Promise<QuestionResult> {
      return Promise.resolve({ answers: { style: "Compact" }, method: "option" });
    },
  };

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("AskUserQuestion", {
        questions: [
          {
            question: "Which style should I use?",
            header: "Style",
            options: [
              { label: "Compact", description: "Dense layout." },
              { label: "Spacious", description: "More breathing room." },
            ],
          },
        ],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("question answered", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "asker", model, instructions: "x", tools: [askUserQuestionTool] });

  // Not yolo: policy deliberately denies AskUserQuestion there (no human to answer).
  const runner = testRunner({ machine, responder, permission: { mode: "workspace" } });
  const result = await runner.run(agent, "ask");
  faux.unregister();

  check("ask user: returns serialized answer", toolResultText(result.messages, "AskUserQuestion").includes('"style":"Compact"'));
}

async function testUnifiedAgentTool(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("Agent", {
        prompt: "Find the answer.",
        description: "find answer",
        subagent_type: "coder",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Subagent found 42.", { stopReason: "stop" }),
    fauxAssistantMessage("Final answer: 42.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const coder = defineAgent({ name: "coder", model, instructions: "Code.", handoffDescription: "Implementation subagent." });
  const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [coder] });

  const runner = testRunner({ machine, permission: { mode: "yolo" } });
  const result = await runner.run(main, "delegate");
  faux.unregister();

  const agentOutput = toolResultText(result.messages, "Agent");
  check("agent tool: unified Agent ran coder subagent", agentOutput.includes("actual_subagent_type: coder"));
  check("agent tool: subagent output returned to parent", agentOutput.includes("Subagent found 42"));
  check("agent tool: parent final output surfaced", result.output.includes("42"));
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-builtin-tools-"));
  const machine = new LocalMachine(dir);
  try {
    await testReadImage(dir, machine);
    await testTodoList(machine);
    await testAskUserQuestion(machine);
    await testUnifiedAgentTool(machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ BUILTIN TOOLS E2E PASS — Read image + TodoList + AskUserQuestion + Agent");
  } else {
    console.log("❌ BUILTIN TOOLS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ BUILTIN TOOLS E2E ERROR:", error);
  process.exit(1);
});
