import { testRunner, openTestSession } from "./faux.ts";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  Runner,
  LocalMachine,
  ListenerSink,
  userHooksCapability,
  writeTool,
  type AgentEvent,
  type ChatModel,
  type Message,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function reminderText(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter((t) => t.includes("<system-reminder>"))
    .join("\n");
}

function reminderCount(messages: readonly Message[], needle: string): number {
  return messages.filter(
    (message) =>
      message.role === "user" &&
      message.content.some((content) => content.type === "text" && content.text.includes("<system-reminder>") && content.text.includes(needle)),
  ).length;
}

function toolResultText(messages: readonly Message[], name: string): { text: string; isError: boolean } {
  const m = [...messages].reverse().find((x) => x.role === "toolResult" && x.toolName === name);
  if (!m || m.role !== "toolResult") return { text: "", isError: false };
  return { text: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: m.isError ?? false };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function testPreToolUseBlock(dir: string, machine: LocalMachine): Promise<void> {
  const target = join(dir, "hook-denied.txt");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: target, content: "x" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("acknowledged the block", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x", tools: [writeTool] });

  const hooks = [{ event: "PreToolUse" as const, matcher: "Write", command: `echo '{"block":true,"reason":"hook says no"}'` }];
  // yolo permission → only the PreToolUse hook (chain head) can block.
  const runner = testRunner({ machine, capabilities: [userHooksCapability(hooks)], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "write a file");
  faux.unregister();

  const write = toolResultText(result.messages, "Write");
  check("PreToolUse: tool blocked by hook", write.isError && write.text.includes("hook says no"));
  check("PreToolUse: file not written", !existsSync(target));
}

async function testSessionStartInjection(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("hi", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const hooks = [{ event: "SessionStart" as const, command: `echo 'PROJECT_CONTEXT: handle with care'` }];
  const runner = testRunner({ machine, capabilities: [userHooksCapability(hooks)], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "hello");
  faux.unregister();

  check("SessionStart: hook output injected into context", reminderText(result.messages).includes("PROJECT_CONTEXT: handle with care"));
}

async function testStopContinueOnce(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first turn", { stopReason: "stop" }),
    fauxAssistantMessage("second turn", { stopReason: "stop" }),
    fauxAssistantMessage("third turn (should not happen)", { stopReason: "stop" }),
  ]);
  const base = faux.getChatModel()!;
  const seen: Message[][] = [];
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    seen.push([...req.messages]);
    return stream(req, call);
  };
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const events = new ListenerSink();
  let turnStarts = 0;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });

  const hooks = [
    { event: "SessionStart" as const, command: `echo 'ONE_BOUNDARY_REMINDER'` },
    { event: "Stop" as const, command: `echo '{"block":true}'` },
  ];
  const runner = testRunner({ machine, events, capabilities: [userHooksCapability(hooks)], permission: { mode: "yolo" }, maxTurns: 10 });
  const result = await runner.run(agent, "go");
  faux.unregister();

  check("Stop: hook forced exactly one extra turn (2 total)", turnStarts === 2);
  check("Stop: second turn ran", result.output.includes("second turn"));
  check(
    "injection: multi-turn run keeps one stable SessionStart reminder in the prefix",
    seen.length === 2 && seen.every((messages) => reminderCount(messages, "ONE_BOUNDARY_REMINDER") === 1),
  );
  check(
    "injection cache: prior model request remains an exact prefix",
    seen.length === 2 && JSON.stringify(seen[1]!.slice(0, seen[0]!.length)) === JSON.stringify(seen[0]),
  );
}

async function testPostToolUseObserve(dir: string, machine: LocalMachine): Promise<void> {
  const marker = join(dir, "posthook-ran.txt");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: join(dir, "ok.txt"), content: "ok" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x", tools: [writeTool] });

  const hooks = [{ event: "PostToolUse" as const, command: `cat > /dev/null; echo ran > '${marker}'` }];
  const runner = testRunner({ machine, capabilities: [userHooksCapability(hooks)], permission: { mode: "yolo" } });
  await runner.run(agent, "write then observe");
  faux.unregister();

  // PostToolUse is fire-and-forget; poll briefly for its side effect.
  let appeared = false;
  for (let i = 0; i < 40 && !appeared; i++) {
    if (existsSync(marker)) appeared = true;
    else await sleep(25);
  }
  check("PostToolUse: fire-and-forget hook observed (side effect appeared)", appeared);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-hooks-e2e-"));
  const machine = new LocalMachine(dir);
  try {
    await testPreToolUseBlock(dir, machine);
    await testSessionStartInjection(machine);
    await testStopContinueOnce(machine);
    await testPostToolUseObserve(dir, machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ USER-HOOKS E2E PASS — PreToolUse block + SessionStart inject + Stop continue + PostToolUse observe");
  } else {
    console.log("❌ USER-HOOKS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ USER-HOOKS E2E ERROR:", error);
  process.exit(1);
});
