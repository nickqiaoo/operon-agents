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
  MemoryStore,
  planCapability,
  goalCapability,
  PlanMode,
  GoalStore,
  ConversationContext,
  writeTool,
  type AgentEvent,
  type Message,
} from "../index.ts";
import { PlanModeInjector } from "../capabilities/plan/injector.ts";

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

function toolResultText(messages: readonly Message[], name: string): { text: string; isError: boolean } {
  const m = [...messages].reverse().find((x) => x.role === "toolResult" && x.toolName === name);
  if (!m || m.role !== "toolResult") return { text: "", isError: false };
  return { text: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: m.isError ?? false };
}

async function testPlanGuard(dir: string, machine: LocalMachine): Promise<void> {
  const target = join(dir, "should-not-write.txt");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("EnterPlanMode", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Write", { path: target, content: "nope" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("understood — plan mode is read-only", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "planner", model, instructions: "x", tools: [writeTool] });

  // yolo mode: proves plan-mode-guard-deny (high in the chain) beats yolo-approve.
  const runner = new Runner({ machine, capabilities: [planCapability()], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "investigate then write");
  faux.unregister();

  const write = toolResultText(result.messages, "Write");
  check("plan guard: Write denied in plan mode", write.isError && write.text.includes("Plan mode is active"));
  check("plan guard: file not written", !existsSync(target));
  check("plan guard: run completes", result.status === "completed");
}

async function testExitPlanReviewAsk(machine: LocalMachine): Promise<void> {
  // Pre-enter plan mode and write real plan content so ExitPlanMode has a plan to review.
  const planMode = new PlanMode();
  planMode.attachMachine(machine);
  await planMode.enter();
  await machine.writeText(planMode.planFilePath!, "## Plan\n1. Do X\n2. Do Y\n");

  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("ExitPlanMode", {}), { stopReason: "toolUse" })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "planner", model, instructions: "x" });

  const store = new MemoryStore();
  // Plan-mode state lives in the session branch now (not on the object): seed the EnterPlanMode
  // result a real prior turn would have journaled, so openSession reconstructs plan mode as active.
  await store.appendRecord({
    address: "main",
    type: "context.append_message",
    message: {
      role: "toolResult",
      toolCallId: "seed-enter",
      toolName: "EnterPlanMode",
      content: [{ type: "text", text: "Plan mode active." }],
      details: planMode.details(),
      isError: false,
      timestamp: Date.now(),
    },
  });
  // No responder → the review ask reifies to a durable interrupt.
  const runner = new Runner({ machine, store, capabilities: [planCapability(planMode)], permission: { mode: "manual" } });
  const result = await runner.run(agent, "exit plan mode");
  faux.unregister();

  check("plan exit: review asks → interrupted", result.status === "interrupted");
  check("plan exit: pending is ExitPlanMode", result.interruption?.pending[0]?.toolName === "ExitPlanMode");
  check("plan exit: plan mode still active (not exited on ask)", planMode.isActive);
}

async function testGoalDriver(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("UpdateGoal", { objective: "do the multi-step task", status: "active" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("step 1 done", { stopReason: "stop" }), // turn 1 end → driver continues
    fauxAssistantMessage("step 2 done", { stopReason: "stop" }), // turn 2 end → driver continues
    fauxAssistantMessage(fauxToolCall("UpdateGoal", { status: "complete" }), { stopReason: "toolUse" }), // turn 3
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "worker", model, instructions: "x" });

  const events = new ListenerSink();
  let turnStarts = 0;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });

  const runner = new Runner({ machine, events, capabilities: [goalCapability()], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "achieve the goal");
  faux.unregister();

  check("goal driver: drove exactly 3 turns to completion", turnStarts === 3);
  check("goal driver: final output surfaced", result.output.includes("all done"));
  check("goal driver: goal reminder injected at boundary", reminderText(result.messages).includes("active goal"));
}

async function testGoalBudget(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("UpdateGoal", { objective: "never finishes", status: "active" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("SetGoalBudget", { turns: 2 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("working 1", { stopReason: "stop" }), // turn 1 end (turnsUsed→1, <2 continue)
    fauxAssistantMessage("working 2", { stopReason: "stop" }), // turn 2 end (turnsUsed→2, ≥2 auto-block)
    fauxAssistantMessage("working 3", { stopReason: "stop" }), // should NOT be reached
    fauxAssistantMessage("working 4", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "worker", model, instructions: "x" });

  const store = new GoalStore();
  const events = new ListenerSink();
  let turnStarts = 0;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });

  const runner = new Runner({ machine, events, capabilities: [goalCapability(store)], permission: { mode: "yolo" }, maxTurns: 10 });
  const result = await runner.run(agent, "go forever");
  faux.unregister();

  check("goal budget: auto-blocked after 2 turns (not maxTurns)", turnStarts === 2);
  check("goal budget: goal status is blocked", store.snapshot()?.status === "blocked");
  check("goal budget: terminal reason is turn budget", store.snapshot()?.terminalReason === "turn budget reached");
  check("goal budget: run completes (not max_turns)", result.status === "completed");
}

async function testPlanReminderRefresh(): Promise<void> {
  const planMode = new PlanMode();
  await planMode.enter(false);
  const injector = new PlanModeInjector(planMode);
  const context = new ConversationContext();

  const injectBoundary = (): string | undefined => {
    const result = injector.inject({
      history: context.messages,
      sessionId: "plan-refresh",
      address: "main",
      originOf: (message) => context.originOf(message),
    });
    if (result) {
      context.appendMessage(
        {
          role: "user",
          content: [{ type: "text", text: result.text }],
          timestamp: Date.now(),
        },
        { kind: "injection", injectorId: injector.id, variant: result.variant ?? injector.id },
      );
    }
    return result?.variant;
  };

  const variants = [injectBoundary()];
  const firstReminder = context.messages[0];
  for (let turn = 1; turn <= 5; turn++) {
    context.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `plan turn ${turn}` }],
      toolCalls: [],
      timestamp: Date.now(),
    });
    variants.push(injectBoundary());
  }

  check(
    "plan reminder: append-only cadence emits only when due",
    JSON.stringify(variants) === JSON.stringify(["full", undefined, "sparse", undefined, "sparse", undefined]),
  );
  check(
    "plan reminder: prior reminder stays in the cached prefix",
    context.messages[0] === firstReminder && context.messages.filter((message) => message.role === "user").length === 3,
  );
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-cap-e2e-"));
  const machine = new LocalMachine(dir);
  try {
    await testPlanGuard(dir, machine);
    await testExitPlanReviewAsk(machine);
    await testGoalDriver(machine);
    await testGoalBudget(machine);
    await testPlanReminderRefresh();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ CAPABILITIES E2E PASS — plan guard + exit review-ask + goal driver + goal budget + injection");
  } else {
    console.log("❌ CAPABILITIES E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ CAPABILITIES E2E ERROR:", error);
  process.exit(1);
});
