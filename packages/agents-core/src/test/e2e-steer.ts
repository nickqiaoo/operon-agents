import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  Runner,
  LocalMachine,
  ListenerSink,
  SteerBus,
  renderSteerText,
  defineTool,
  ToolAccesses,
  type AgentEvent,
  type Capability,
  type Message,
  type SteerOrigin,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function userTexts(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
}

function steerToolCapability(origin: SteerOrigin): Capability {
  let bus: SteerBus | undefined;
  return {
    name: "steer-tool",
    start: (ctx) => {
      bus = ctx.steer;
    },
    tools: [
      defineTool({
        name: "EnqueueSteer",
        description: "Enqueue a steer message into the bus.",
        params: z.object({ text: z.string() }),
        resolve: (args) => ({
          approvalRule: "EnqueueSteer",
          accesses: ToolAccesses.none(),
          run: async () => {
            bus?.steer(args.text, origin);
            return { content: [{ type: "text", text: "enqueued" }] };
          },
        }),
      }),
    ],
  };
}

function oneShotAfterStepCapability(origin: SteerOrigin, text: string): Capability {
  let bus: SteerBus | undefined;
  let fired = false;
  return {
    name: "bg-sim",
    start: (ctx) => {
      bus = ctx.steer;
    },
    hooks: {
      afterStep: async () => {
        if (!fired) {
          fired = true;
          bus?.steer(text, origin);
        }
        return undefined;
      },
    },
  };
}

async function testIdleSteer(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const bus = new SteerBus();
  const ret = bus.steer("remember: be brief", { kind: "user" }); // idle → wakes with a turn id
  const runner = new Runner({ machine, steer: bus, permission: { mode: "yolo" } });
  const result = await runner.run(agent, "hello");
  faux.unregister();

  check("idle steer: steer() returns a wake turn id when idle", typeof ret.wakeTurnId === "string" && ret.wakeTurnId.length > 0);
  check("idle steer: steer() mints a correlation id", ret.steerId.startsWith("steer_"));
  check("idle steer: drained into the first turn's transcript", userTexts(result.messages).includes("remember: be brief"));
}

async function testPrequeuedUserFollowUpWaitsForNextTurn(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first answer", { stopReason: "stop" }),
    fauxAssistantMessage("follow-up answer", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const events = new ListenerSink();
  let turnStarts = 0;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });

  const bus = new SteerBus();
  bus.followUp("after that, summarize it");
  const runner = new Runner({ machine, events, steer: bus, permission: { mode: "yolo" }, maxTurns: 10 });
  const result = await runner.run(agent, "do the first task");
  faux.unregister();

  const firstAnswerIndex = result.messages.findIndex(
    (message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text.includes("first answer")),
  );
  const followUpIndex = result.messages.findIndex(
    (message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text.includes("after that, summarize it")),
  );
  check("user follow-up: waits until the initial turn has answered", firstAnswerIndex >= 0 && followUpIndex > firstAnswerIndex);
  check("user follow-up: opens exactly one additional turn", turnStarts === 2);
  check("user follow-up: second turn produces the final output", result.output.includes("follow-up answer"));
}

async function testMidTurnSteer(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("EnqueueSteer", { text: "actually, be concise" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("acknowledged the steer", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const events = new ListenerSink();
  let turnStarts = 0;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });

  // A user steer enqueued during a tool_use step is drained at the next step boundary — same turn.
  const cap = steerToolCapability({ kind: "user" });
  const runner = new Runner({ machine, events, capabilities: [cap], permission: { mode: "yolo" } });
  const result = await runner.run(agent, "do the thing");
  faux.unregister();

  const texts = userTexts(result.messages);
  check("mid-turn steer: user steer drained at next step boundary (same turn)", texts.includes("actually, be concise"));
  check("mid-turn steer: no new turn opened for it", turnStarts === 1);
  check("mid-turn steer: model responded after the injection", result.output.includes("acknowledged"));
}

async function testFinalStepSteerStaysInTurn(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first answer", { stopReason: "stop" }), // end_turn; afterStep enqueues a user steer
    fauxAssistantMessage("handled the late steer", { stopReason: "stop" }), // same turn consumes it
    fauxAssistantMessage("should not happen", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const events = new ListenerSink();
  let turnStarts = 0;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });

  // The regression: a user steer that lands DURING the terminal step must be answered in the
  // same turn (runTurn re-drains before breaking), NOT bounced to a fresh turn like a follow-up.
  const cap = oneShotAfterStepCapability({ kind: "user" }, "late steer: one more thing");
  const runner = new Runner({ machine, events, capabilities: [cap], permission: { mode: "yolo" }, maxTurns: 10 });
  const result = await runner.run(agent, "go");
  faux.unregister();

  check("final-step steer: consumed in-turn, no extra turn (1 total)", turnStarts === 1);
  check("final-step steer: the steer entered this turn's transcript", userTexts(result.messages).includes("late steer: one more thing"));
  check("final-step steer: final output responds to the steer", result.output.includes("handled the late steer"));
}

async function testFollowUpDrain(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first response", { stopReason: "stop" }), // turn 1 ends; afterStep enqueues
    fauxAssistantMessage("after bg: done", { stopReason: "stop" }), // turn 2 drains the steer
    fauxAssistantMessage("should not happen", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  const events = new ListenerSink();
  let turnStarts = 0;
  events.subscribe((e: AgentEvent) => {
    if (e.type === "turn.started") turnStarts += 1;
  });

  const cap = oneShotAfterStepCapability({ kind: "background_done", taskId: "bg9", summary: "BG SUMMARY" }, "ignored-body");
  const runner = new Runner({ machine, events, capabilities: [cap], permission: { mode: "yolo" }, maxTurns: 10 });
  const result = await runner.run(agent, "go");
  faux.unregister();

  check("follow-up: a post-turn steer forced exactly one more turn (2 total)", turnStarts === 2);
  check("follow-up: steered summary drained in turn 2", userTexts(result.messages).includes("BG SUMMARY"));
  check("follow-up: final output is turn 2's response", result.output.includes("after bg"));
}

async function testSteerIdCorrelation(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("EnqueueSteer", { text: "steer me" }), { stopReason: "toolUse" }), // tool enqueues user steer; afterStep enqueues bg follow-up
    fauxAssistantMessage("got the steer", { stopReason: "stop" }), // turn 1 drains the user steer
    fauxAssistantMessage("got the follow-up", { stopReason: "stop" }), // turn 2 drains the bg follow-up
    fauxAssistantMessage("should not happen", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "a", model, instructions: "x" });

  // Records the receipts so the event-side ids can be matched back to the producer's.
  const receipts: { user?: string; bg?: string } = {};
  let fired = false;
  let bus: SteerBus | undefined;
  const cap: Capability = {
    name: "receipts",
    start: (ctx) => {
      bus = ctx.steer;
    },
    tools: [
      defineTool({
        name: "EnqueueSteer",
        description: "Enqueue a steer message into the bus.",
        params: z.object({ text: z.string() }),
        resolve: (args) => ({
          approvalRule: "EnqueueSteer",
          accesses: ToolAccesses.none(),
          run: async () => {
            receipts.user = bus?.steer(args.text, { kind: "user" }).steerId;
            return { content: [{ type: "text", text: "enqueued" }] };
          },
        }),
      }),
    ],
    hooks: {
      afterStep: async () => {
        if (!fired) {
          fired = true;
          receipts.bg = bus?.steer("bg body", { kind: "background_done", taskId: "bg1", summary: "BG DONE" }).steerId;
        }
        return undefined;
      },
    },
  };

  const queued: Array<{ steerId: string; channel: string; kind: string }> = [];
  const consumed: Array<{ steerId?: string; kind: string }> = [];
  const events = new ListenerSink();
  events.subscribe((e: AgentEvent) => {
    if (e.type === "steer.queued") queued.push({ steerId: e.steerId, channel: e.channel, kind: e.origin.kind });
    if (e.type === "message.appended" && e.origin !== undefined) {
      const origin = e.origin as { kind: string; steerId?: string };
      if (origin.steerId !== undefined) consumed.push({ steerId: origin.steerId, kind: origin.kind });
    }
  });

  const runner = new Runner({ machine, events, capabilities: [cap], permission: { mode: "yolo" }, maxTurns: 10 });
  await runner.run(agent, "go");
  faux.unregister();

  const queuedUser = queued.find((q) => q.channel === "steering");
  const queuedBg = queued.find((q) => q.channel === "follow_up");
  check("correlation: mid-run enqueues emit steer.queued for both channels", queued.length === 2 && queuedUser !== undefined && queuedBg !== undefined);
  check("correlation: steer.queued ids match the producers' receipts", queuedUser?.steerId === receipts.user && queuedBg?.steerId === receipts.bg);
  check("correlation: steer.queued carries the mapped PromptOrigin kind", queuedUser?.kind === "user" && queuedBg?.kind === "background_task");
  const consumedUser = consumed.find((c) => c.steerId === receipts.user);
  const consumedBg = consumed.find((c) => c.steerId === receipts.bg);
  check("correlation: consuming message.appended carries origin.steerId (steering)", consumedUser?.kind === "user");
  check("correlation: consuming message.appended carries origin.steerId (follow-up)", consumedBg?.kind === "background_task");
}

function testOriginFraming(): void {
  const ext = renderSteerText(
    { kind: "extension", extensionId: "cron", metadata: { jobId: "a1b2", cron: "*/5 * * * *", recurring: true, coalescedCount: 2, stale: false }, channel: "follow_up" },
    "run the report",
  );
  check(
    "framing: extension → <extension-message from> with metadata attributes + verbatim body",
    ext.includes('<extension-message from="cron" jobId="a1b2" cron="*/5 * * * *" recurring="true" coalescedCount="2" stale="false">') && ext.includes("run the report"),
  );

  const bg = renderSteerText({ kind: "background_done", taskId: "t3", summary: "all tests pass" }, "");
  check("framing: background_done → <background-task-done>", bg.includes('<background-task-done taskId="t3">') && bg.includes("all tests pass"));


  const user = renderSteerText({ kind: "user" }, "plain message");
  check("framing: user → no frame (verbatim)", user === "plain message");

  const userFollowUp = renderSteerText({ kind: "user_follow_up" }, "plain follow-up");
  check("framing: user follow-up → no frame (verbatim)", userFollowUp === "plain follow-up");

  const esc = renderSteerText({ kind: "extension", extensionId: "cron", metadata: { jobId: 'x"&y', "bad key": "skipped" }, channel: "steering" }, "body");
  check("framing: attribute escaping (& and \") and unsafe metadata keys dropped", esc.includes('jobId="x&quot;&amp;y"') && !esc.includes("bad key"));
}

function testIdleGate(): void {
  const bus = new SteerBus();
  check("idle gate: idle initially", bus.isIdle && bus.activeTurn === null);

  bus.beginTurn("turn-1");
  check("idle gate: not idle during a turn", !bus.isIdle && bus.activeTurn === "turn-1");
  const bufferedRet = bus.steer("x", { kind: "user" });
  check("idle gate: no wake turn id while a turn runs (buffered)", bufferedRet.wakeTurnId === null);

  bus.endTurn();
  check("idle gate: idle again after the turn", bus.isIdle);
  const idleRet = bus.steer("y", { kind: "user" });
  check("idle gate: steer() returns a wake turn id when idle", typeof idleRet.wakeTurnId === "string");
  check("idle gate: every enqueue mints a distinct correlation id", bufferedRet.steerId !== idleRet.steerId);
  check("idle gate: both steers queued", bus.hasItems() && bus.drainSteering().length === 2);
}

async function main(): Promise<void> {
  const machine = new LocalMachine(process.cwd());
  await testIdleSteer(machine);
  await testPrequeuedUserFollowUpWaitsForNextTurn(machine);
  await testMidTurnSteer(machine);
  await testFinalStepSteerStaysInTurn(machine);
  await testFollowUpDrain(machine);
  await testSteerIdCorrelation(machine);
  testOriginFraming();
  testIdleGate();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ STEER E2E PASS — idle steer + user follow-up + mid-turn drain + final-step in-turn + follow-up turn + origin framing + idle gate");
  } else {
    console.log("❌ STEER E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ STEER E2E ERROR:", error);
  process.exit(1);
});
