import { testRunner, openTestSession } from "./faux.ts";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  handoff,
  toFunctionToolName,
  Runner,
  Session,
  LocalMachine,
  ListenerSink,
  MemoryStore,
  DiskSessionStore,
  replayContext,
  INTERRUPTION_STATE_KEY,
  parseInterruptionState,
  userHooksCapability,
  toolGuardrail,
  isGuardrailTripwireError,
  writeTool,
  type AgentEvent,
  type AgentRecord,
  type InputGuardrail,
  type OutputGuardrail,
  type ToolInputGuardrail,
  type ChatModel,
  type Message,
  type Responder,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function textOf(messages: readonly Message[], role: Message["role"]): string {
  return messages
    .filter((m) => m.role === role)
    .flatMap((m) => m.content)
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
}

async function testHandoff(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("transfer_to_billing", { reason: "refund" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Refund issued to your account.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const billing = defineAgent({ name: "billing", model, instructions: "Handle billing." });
  const triage = defineAgent({ name: "triage", model, instructions: "Route requests.", handoffs: [handoff(billing)] });

  const runner = testRunner({ machine });
  const result = await runner.run(triage, "I want a refund");
  faux.unregister();

  check("handoff: ends on billing agent", result.finalAgent === "billing");
  check("handoff: status completed", result.status === "completed");
  check("handoff: billing output surfaced", result.output.includes("Refund issued"));

  // Pins the tool-name mapping: each disallowed char → its own "_" (no run-collapsing).
  // Generated names land in transcripts, so this must stay stable across versions.
  check(
    "handoff: toFunctionToolName mapping is stable (per-char underscores, lowercase, empty→agent)",
    toFunctionToolName("Foo  Bar") === "foo__bar" && toFunctionToolName("Data-Cleaner_2!") === "data-cleaner_2_" && toFunctionToolName("") === "agent",
  );
}

async function testHandoffInputType(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("transfer_to_billing", { orderId: "A-123", priority: "high" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Refund issued to your account.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const billing = defineAgent({ name: "billing", model, instructions: "Handle billing." });

  const inputType = z.object({ orderId: z.string(), priority: z.enum(["low", "high"]) });
  let received: { orderId: string; priority: "low" | "high" } | undefined;
  const edge = handoff(billing, {
    inputType,
    onHandoff: (_ctx, input) => {
      received = input;
    },
  });

  // The custom schema is what the model sees as the tool's parameters.
  const params = edge.asTool().schema.parameters as { properties?: Record<string, unknown> };
  check("handoff inputType: tool schema exposes custom fields", !!params.properties && "orderId" in params.properties && "priority" in params.properties);

  const triage = defineAgent({ name: "triage", model, instructions: "Route requests.", handoffs: [edge] });
  const runner = testRunner({ machine });
  const result = await runner.run(triage, "I want a refund for order A-123");
  faux.unregister();

  check("handoff inputType: ends on billing agent", result.finalAgent === "billing");
  check("handoff inputType: onHandoff received validated structured input", received?.orderId === "A-123" && received?.priority === "high");
}

async function testDurableHandoffContinuation(dir: string, machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("transfer_to_billing", { reason: "refund" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("billing owns the conversation", { stopReason: "stop" }),
    fauxAssistantMessage("billing follow-up", { stopReason: "stop" }),
    fauxAssistantMessage(fauxToolCall("transfer_to_triage", { reason: "resolved" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("triage owns it again", { stopReason: "stop" }),
    fauxAssistantMessage("triage follow-up", { stopReason: "stop" }),
  ]);
  const base = faux.getChatModel()!;
  const systems: Array<string | undefined> = [];
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    systems.push(req.system);
    return stream(req, call);
  };

  const triageHandoffs: Array<ReturnType<typeof handoff>> = [];
  const billingHandoffs: Array<ReturnType<typeof handoff>> = [];
  const triage = defineAgent({ name: "triage", model, instructions: "TRIAGE_ONLY", handoffs: triageHandoffs });
  const billing = defineAgent({ name: "billing", model, instructions: "BILLING_ONLY", handoffs: billingHandoffs });
  triageHandoffs.push(
    handoff(billing, {
      inputFilter: ({ history }) => ({ history: history.filter((message) => message.role === "user") }),
    }),
  );
  billingHandoffs.push(handoff(triage));

  const storeDir = join(dir, "durable-handoff-session");
  const store = new DiskSessionStore(storeDir);
  const runner = testRunner({ machine });
  const firstSession = await openTestSession({ machine, store });
  const first = await runner.run(triage, "refund please", { session: firstSession });
  const billingAddress = first.activeAddress;
  const second = await runner.run(triage, "still there?", { session: firstSession });
  await firstSession.close();

  // Reopen over the same durable store: no in-memory active-head cache survives this boundary.
  const reopenedStore = new DiskSessionStore(storeDir);
  const reopened = await openTestSession({ machine, store: reopenedStore });
  const third = await runner.run(triage, "return me to triage", { session: reopened });
  const triageAddress = third.activeAddress;
  const fourth = await runner.run(triage, "who owns this now?", { session: reopened });
  await reopened.close();
  faux.unregister();

  const mainRecords: AgentRecord[] = [];
  for await (const record of reopenedStore.readRecords({ address: "main" })) mainRecords.push(record);
  const billingRecords: AgentRecord[] = [];
  for await (const record of reopenedStore.readRecords({ address: billingAddress })) billingRecords.push(record);

  check("durable handoff: target uses a new top-level address", billingAddress.startsWith("h_billing_") && !billingAddress.includes("/"));
  check("durable handoff: next prompt stays on billing", second.finalAgent === "billing" && second.activeAddress === billingAddress);
  check("durable handoff: cold reopen starts from billing before handing back", systems[3] === "BILLING_ONLY");
  check("durable handoff: handback creates another fresh root shard", triageAddress.startsWith("h_triage_") && triageAddress !== "main" && !triageAddress.includes("/"));
  check("durable handoff: prompt after handback stays on triage", fourth.finalAgent === "triage" && fourth.activeAddress === triageAddress && systems[5] === "TRIAGE_ONLY");
  check(
    "durable handoff: source log carries the committed destination",
    mainRecords.some((record) => record.type === "agent.handoff" && record.toAddress === billingAddress),
  );
  check("durable handoff: source history was not destructively replaced", !mainRecords.some((record) => record.type === "context.replace"));
  check(
    "durable handoff: inherited target messages have explicit seed provenance",
    billingRecords.some((record) => record.type === "context.append_message" && record.origin?.kind === "handoff_seed"),
  );
}

async function testHandoffInterruptionResume(dir: string, machine: LocalMachine): Promise<void> {
  const file = join(dir, "handoff-approved.txt");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("transfer_to_billing", { reason: "specialist" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "owned by billing\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("billing resumed", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const billing = defineAgent({ name: "billing", model, instructions: "BILLING", tools: [writeTool] });
  const triage = defineAgent({ name: "triage", model, instructions: "TRIAGE", handoffs: [handoff(billing)] });
  const store = new MemoryStore();
  const runner = testRunner({ machine, store, permission: { mode: "manual" } });

  const first = await runner.run(triage, "handoff then write");
  const persisted = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const callId = first.interruptions?.[0]?.toolCallId ?? "";
  const resumedRunner = testRunner({ machine, store, permission: { mode: "manual" } });
  const resumed = await resumedRunner.resume(triage, { interruption: persisted, answers: { [callId]: { kind: "approval", decision: "approved" } } });
  faux.unregister();

  check("handoff HITL: interruption belongs to target address", first.status === "interrupted" && first.finalAgent === "billing" && first.activeAddress.startsWith("h_billing_"));
  check("handoff HITL: cold resume stays on target agent/address", resumed.status === "completed" && resumed.finalAgent === "billing" && resumed.activeAddress === first.activeAddress);
  check("handoff HITL: approved target tool executes", existsSync(file) && readFileSync(file, "utf8") === "owned by billing\n");
}

async function testHandoffResumeIgnoresDecoy(dir: string, machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("transfer_to_mid", { reason: "route" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("transfer_to_billing", { reason: "specialist" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("real billing owns it", { stopReason: "stop" }),
    fauxAssistantMessage("real billing follow-up", { stopReason: "stop" }),
  ]);
  const base = faux.getChatModel()!;
  const systems: Array<string | undefined> = [];
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    systems.push(req.system);
    return stream(req, call);
  };

  // A subagent named like the real handoff destination, sitting closer to the root in BFS order:
  // a global by-name search over the graph would resolve the durable handoff record to it instead
  // of the agent the run actually transferred to.
  const decoy = defineAgent({ name: "billing", model, instructions: "DECOY_ONLY" });
  const billing = defineAgent({ name: "billing", model, instructions: "BILLING_REAL" });
  const mid = defineAgent({ name: "mid", model, instructions: "MID_ONLY", handoffs: [handoff(billing)] });
  const triage = defineAgent({ name: "triage", model, instructions: "TRIAGE_ONLY", handoffs: [handoff(mid)], subagents: [decoy] });

  const storeDir = join(dir, "decoy-handoff-session");
  const store = new DiskSessionStore(storeDir);
  const runner = testRunner({ machine });
  const firstSession = await openTestSession({ machine, store });
  const first = await runner.run(triage, "refund please", { session: firstSession });
  await firstSession.close();

  // Cold reopen: the head is re-derived from the durable handoff chain, edge by edge.
  const reopened = await openTestSession({ machine, store: new DiskSessionStore(storeDir) });
  const second = await runner.run(triage, "still there?", { session: reopened });
  await reopened.close();
  faux.unregister();

  check("decoy handoff: first run ends on the real billing agent", first.finalAgent === "billing" && systems[2] === "BILLING_REAL");
  check(
    "decoy handoff: cold resume follows edges, not the same-named decoy",
    second.finalAgent === "billing" && second.activeAddress === first.activeAddress && systems[3] === "BILLING_REAL",
  );
}

async function testAmbiguousEdgesRejected(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const runner = testRunner({ machine });

  const workerA = defineAgent({ name: "worker", model, instructions: "A" });
  const workerB = defineAgent({ name: "worker", model, instructions: "B" });
  const boss = defineAgent({
    name: "boss",
    model,
    instructions: "route",
    handoffs: [handoff(workerA, { toolName: "escalate_a" }), handoff(workerB, { toolName: "escalate_b" })],
  });
  const ambiguous = await runner.run(boss, "hi").then(
    () => undefined,
    (error: unknown) => error,
  );
  check(
    "ambiguous edges: two distinct same-named handoff targets rejected",
    ambiguous instanceof Error && ambiguous.message.includes("two different agents both named"),
  );

  const helperA = defineAgent({ name: "helper", model, instructions: "A" });
  const helperB = defineAgent({ name: "helper", model, instructions: "B" });
  const parent = defineAgent({ name: "parent", model, instructions: "spawn", subagents: [helperA, helperB] });
  const dupSubs = await runner.run(parent, "hi").then(
    () => undefined,
    (error: unknown) => error,
  );
  check("ambiguous edges: same-named subagents rejected", dupSubs instanceof Error && dupSubs.message.includes("share the tool name"));

  // A malformed agent anywhere in the reachable graph fails the run up front, even though the
  // conversation would never have reached it (the model would answer without handing off).
  const deepWorker = defineAgent({
    name: "deep",
    model,
    instructions: "D",
    handoffs: [handoff(workerA, { toolName: "go_a" }), handoff(workerB, { toolName: "go_b" })],
  });
  const front = defineAgent({ name: "front", model, instructions: "F", handoffs: [handoff(deepWorker)] });
  const deep = await runner.run(front, "hi").then(
    () => undefined,
    (error: unknown) => error,
  );
  check(
    "ambiguous edges: malformed deep agent rejected at run entry",
    deep instanceof Error && deep.message.includes("two different agents both named"),
  );

  // Two edges to the SAME agent (different tool names/filters) stay legal: the resume walk
  // resolves them to one target, and the tool names don't collide.
  const specialist = defineAgent({ name: "specialist", model, instructions: "S" });
  const router = defineAgent({
    name: "router",
    model,
    instructions: "route",
    handoffs: [handoff(specialist, { toolName: "escalate" }), handoff(specialist, { toolName: "transfer" })],
  });
  const sameTarget = await runner.run(router, "hi");
  check("ambiguous edges: duplicate edges to one agent allowed", sameTarget.status === "completed");
  faux.unregister();
}

async function testInputGuardrail(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("never reached", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;

  const noFoo: InputGuardrail = {
    name: "no-foo",
    execute: ({ input }) => ({ tripwireTriggered: textOf(input, "user").includes("foo") }),
  };
  const agent = defineAgent({ name: "a", model, instructions: "x", guardrails: { input: [noFoo] } });

  const events = new ListenerSink();
  const blocked: AgentEvent[] = [];
  events.subscribe((e: AgentEvent) => { if (e.type === "guardrail.blocked") blocked.push(e); });
  const store = new MemoryStore();
  const runner = testRunner({ machine, events, store });
  let err: unknown;
  try {
    await runner.run(agent, "please foo the bar");
  } catch (error) {
    err = error;
  }
  faux.unregister();
  check("input guardrail: tripwire halts the run", isGuardrailTripwireError(err) && err.stage === "input");
  check(
    "input guardrail: error carries locating info (guardrail/agent/session)",
    isGuardrailTripwireError(err) && err.guardrailName === "no-foo" && err.agentName === "a" && typeof err.sessionId === "string",
  );
  check(
    "input guardrail: emits a guardrail.blocked terminal frame",
    blocked.length === 1 && blocked[0]!.type === "guardrail.blocked" && blocked[0].stage === "input" && blocked[0].guardrail === "no-foo",
  );
  const records: AgentRecord[] = [];
  for await (const record of store.readRecords()) records.push(record);
  const audit = records.find((record) => record.type === "guardrail.blocked");
  const replayed = await replayContext(store);
  check(
    "input guardrail: rejected input is retained in one durable audit record",
    audit?.type === "guardrail.blocked" && audit.input !== undefined && textOf(audit.input, "user").includes("please foo the bar"),
  );
  check("input guardrail: rejected input stays out of model history", !replayed.history.some((message) => message.role === "user"));
}

async function testOutputGuardrail(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("here is the SECRET token", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;

  const noSecret: OutputGuardrail = {
    name: "no-secret",
    execute: ({ output }) => ({ tripwireTriggered: output.includes("SECRET") }),
  };
  const agent = defineAgent({ name: "a", model, instructions: "x", guardrails: { output: [noSecret] } });

  const events = new ListenerSink();
  const blocked: AgentEvent[] = [];
  events.subscribe((e: AgentEvent) => { if (e.type === "guardrail.blocked") blocked.push(e); });
  const store = new MemoryStore();
  const runner = testRunner({ machine, events, store });
  let err: unknown;
  try {
    await runner.run(agent, "tell me a secret");
  } catch (error) {
    err = error;
  }
  faux.unregister();
  check("output guardrail: tripwire halts the run", isGuardrailTripwireError(err) && err.stage === "output");
  check(
    "output guardrail: emits a guardrail.blocked terminal frame",
    blocked.length === 1 && blocked[0]!.type === "guardrail.blocked" && blocked[0].stage === "output" && blocked[0].guardrail === "no-secret",
  );
  const replayed = await replayContext(store);
  check("output guardrail: blocked final assistant is not persisted", !replayed.history.some((message) => message.role === "assistant"));
}

async function testStreamingOutputGuardrail(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  const base = faux.getChatModel()!;
  const model = Object.create(base) as ChatModel;
  let modelSawAbort = false;
  model.stream = (_request, call) => {
    const out = createAssistantMessageEventStream();
    const first = fauxAssistantMessage("optimistic SECRET output", { stopReason: "stop" });
    queueMicrotask(() => {
      out.push({ type: "start", partial: first });
      out.push({ type: "text_start", contentIndex: 0, partial: first });
      out.push({ type: "text_delta", contentIndex: 0, delta: "optimistic SECRET output", partial: first });
      setTimeout(() => {
        modelSawAbort = call?.signal?.aborted === true;
        if (modelSawAbort) {
          const aborted = fauxAssistantMessage("optimistic SECRET output", { stopReason: "aborted" });
          out.end(aborted);
          return;
        }
        const late = fauxAssistantMessage("optimistic SECRET output SHOULD_NOT_STREAM", { stopReason: "stop" });
        out.push({ type: "text_delta", contentIndex: 0, delta: " SHOULD_NOT_STREAM", partial: late });
        out.push({ type: "text_end", contentIndex: 0, content: "optimistic SECRET output SHOULD_NOT_STREAM", partial: late });
        out.end(late);
      }, 20);
    });
    return out;
  };
  const phases: string[] = [];
  const guardrail: OutputGuardrail = {
    name: "stream-no-secret",
    streaming: { minChars: 1, maxDelayMs: 0 },
    execute: ({ output, phase }) => {
      phases.push(phase);
      return { tripwireTriggered: output.includes("SECRET") };
    },
  };
  const agent = defineAgent({ name: "stream-guarded", model, instructions: "x", guardrails: { output: [guardrail] } });
  const store = new MemoryStore();
  const events = new ListenerSink();
  const seen: AgentEvent[] = [];
  events.subscribe((event) => void seen.push(event));
  const runner = testRunner({ machine, events, store });

  let error: unknown;
  try {
    await runner.run(agent, "stream a secret");
  } catch (caught) {
    error = caught;
  }
  faux.unregister();

  const deltaIndex = seen.findIndex((event) => event.type === "assistant.delta");
  const blockedIndex = seen.findIndex((event) => event.type === "guardrail.blocked");
  const surfacedText = seen.flatMap((event) => event.type === "assistant.delta" ? [event.delta] : []).join("");
  const blocked = seen.find((event): event is AgentEvent & { type: "guardrail.blocked" } => event.type === "guardrail.blocked");
  const assistantAppended = seen.some((event) => event.type === "message.appended" && event.message.role === "assistant");
  const records: AgentRecord[] = [];
  for await (const record of store.readRecords()) records.push(record);
  const replayed = await replayContext(store);

  check("stream output guardrail: optimistic delta is emitted before block", deltaIndex >= 0 && blockedIndex > deltaIndex);
  check("stream output guardrail: streaming phase runs", phases.includes("stream"));
  check("stream output guardrail: tripwire aborts the provider stream", modelSawAbort && !surfacedText.includes("SHOULD_NOT_STREAM"));
  check("stream output guardrail: tripwire carries turn/step location", isGuardrailTripwireError(error) && typeof error.stepId === "string" && blocked?.stepId === error.stepId);
  check("stream output guardrail: blocked assistant emits no message.appended", !assistantAppended);
  check("stream output guardrail: blocked assistant is absent from replay", !replayed.history.some((message) => message.role === "assistant"));
  check("stream output guardrail: one durable audit record is written", records.filter((record) => record.type === "guardrail.blocked").length === 1);
}

async function testStreamingOutputGuardrailPass(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("safe optimistic output", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const phases: string[] = [];
  const guardrail: OutputGuardrail = {
    name: "stream-safe",
    streaming: { minChars: 1, maxDelayMs: 0 },
    execute: ({ phase }) => {
      phases.push(phase);
      return { tripwireTriggered: false };
    },
  };
  const agent = defineAgent({ name: "stream-safe", model, instructions: "x", guardrails: { output: [guardrail] } });
  const events = new ListenerSink();
  const appended: Message[] = [];
  events.subscribe((event) => {
    if (event.type === "message.appended" && event.message.role === "assistant") appended.push(event.message);
  });
  const runner = testRunner({ machine, events });
  const result = await runner.run(agent, "safe stream");
  faux.unregister();

  check("stream output guardrail pass: stream + final phases both run", phases.includes("stream") && phases.includes("final"));
  check("stream output guardrail pass: final assistant is appended once", result.status === "completed" && appended.length === 1);
}

async function testToolGuardrail(dir: string, machine: LocalMachine): Promise<void> {
  const file = join(dir, "blocked.txt");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "should not be written" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("acknowledged the block", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;

  const blockWrites: ToolInputGuardrail = {
    name: "block-writes",
    run: () => toolGuardrail.rejectContent("Writes are blocked in this test."),
  };
  // yolo mode so permission approves; the tool guardrail is what must block.
  const agent = defineAgent({ name: "a", model, instructions: "x", tools: [writeTool], guardrails: { toolInput: [blockWrites] } });

  const runner = testRunner({ machine, permission: { mode: "yolo" } });
  const result = await runner.run(agent, "write a file");
  faux.unregister();

  const toolText = textOf(result.messages, "toolResult");
  check("tool guardrail: rejection text surfaced to model", toolText.includes("Writes are blocked"));
  check("tool guardrail: file was NOT written", !existsSync(file));
  check("tool guardrail: run still completes", result.status === "completed");
}

async function testAgentAsTool(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("agent_researcher", { input: "find the answer" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The answer is 42.", { stopReason: "stop" }), // researcher sub-agent
    fauxAssistantMessage("Final: the answer is 42.", { stopReason: "stop" }), // main, after sub-agent result
  ]);
  const model = faux.getChatModel()!;
  interface AgentToolContext {
    readonly requestId: string;
    readonly visited: string[];
  }
  const researcher = defineAgent<AgentToolContext>({
    name: "researcher",
    model,
    instructions: ({ context }) => {
      context?.visited.push(`researcher:${context.requestId}`);
      return "Research.";
    },
  });
  const main = defineAgent<AgentToolContext>({
    name: "main",
    model,
    instructions: ({ context }) => {
      context?.visited.push(`main:${context.requestId}`);
      return "Coordinate.";
    },
    subagents: [researcher],
  });
  const appContext: AgentToolContext = { requestId: "req-42", visited: [] };

  const events = new ListenerSink();
  const addresses = new Set<string>();
  events.subscribe((e: AgentEvent) => void addresses.add(e.address));

  const runner = testRunner<AgentToolContext>({ machine, events });
  const result = await runner.run(main, "do research", { context: appContext });
  faux.unregister();

  check("agent-as-tool: main returns the synthesized answer", result.output.includes("42"));
  check("agent-as-tool: emits at root address 'main'", addresses.has("main"));
  // Static sub-agents get a per-instance shard (main/researcher-<hex>), like the Agent tool.
  check(
    "agent-as-tool: emits at nested per-instance address 'main/researcher-*'",
    [...addresses].some((a) => /^main\/researcher-[0-9a-f]+$/.test(a)),
  );
  check(
    "agent-as-tool: typed application context reaches root + child",
    appContext.visited.includes("main:req-42") && appContext.visited.includes("researcher:req-42"),
  );
}

async function testSubagentInputGuardrail(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("agent_researcher", { input: "blocked child prompt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Handled the blocked delegation.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const blockChild: InputGuardrail = {
    name: "block-child-input",
    execute: () => ({ tripwireTriggered: true }),
  };
  const researcher = defineAgent({
    name: "researcher",
    model,
    instructions: "Research.",
    guardrails: { input: [blockChild] },
  });
  const main = defineAgent({ name: "main", model, instructions: "Delegate.", subagents: [researcher] });
  const store = new MemoryStore();
  const events = new ListenerSink();
  const blocked: AgentEvent[] = [];
  events.subscribe((event) => {
    if (event.type === "guardrail.blocked") blocked.push(event);
  });
  const runner = testRunner({ machine, events, store });
  const result = await runner.run(main, "delegate this");
  faux.unregister();

  const childAddress = (await store.listAddresses()).find((a) => /^main\/researcher-[0-9a-f]+$/.test(a));
  const childRecords: AgentRecord[] = [];
  for await (const record of store.readRecords({ address: childAddress })) childRecords.push(record);
  const audit = childRecords.find((record) => record.type === "guardrail.blocked");
  const childReplay = await replayContext(store, childAddress);
  check("subagent input guardrail: parent continues after blocked delegation", result.status === "completed");
  check(
    "subagent input guardrail: rejected prompt is retained in child audit",
    audit?.type === "guardrail.blocked" && audit.input !== undefined && textOf(audit.input, "user").includes("blocked child prompt"),
  );
  check("subagent input guardrail: rejected prompt stays out of child model history", childReplay.history.length === 0);
  check("subagent input guardrail: child-address blocked event is emitted", blocked.some((event) => event.address === childAddress));
}

async function testStreamingEvents(machine: LocalMachine): Promise<void> {
  // The model first streams a tool call (toolcall_*), then a plain text reply (text_*).
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("do_thing", { q: "hello" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("All done streaming.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "streamer", model, instructions: "Stream." });

  const events = new ListenerSink();
  const seen = new Set<string>();
  const terminalEvents: AgentEvent[] = [];
  // The model stream is decomposed into first-class live-only events —
  // `assistant.delta` / `thinking.delta` / `tool.call.delta` — and completed `content.part`s.
  const textDeltas: string[] = [];
  const toolcallDeltas: string[] = [];
  events.subscribe((e: AgentEvent) => {
    seen.add(e.type);
    if (e.type === "turn.ended" || e.type === "agent.ended") terminalEvents.push(e);
    if (e.type === "assistant.delta") textDeltas.push(e.delta);
    if (e.type === "tool.call.delta") toolcallDeltas.push(e.argumentsPart);
  });

  const runner = testRunner({ machine, events });
  const result = await runner.run(agent, "go");
  faux.unregister();

  check("streaming: turn.step.started + turn.step.completed framed", seen.has("turn.step.started") && seen.has("turn.step.completed"));
  check("streaming: message.appended surfaces each message", seen.has("message.appended"));
  check(
    "streaming: model stream decomposed into first-class delta events",
    seen.has("assistant.delta") && seen.has("tool.call.delta"),
  );
  check(
    "streaming: legacy inner pi event names are NOT emitted",
    !seen.has("message_update") && !seen.has("text_delta") && !seen.has("toolcall_delta"),
  );
  check("streaming: text deltas reconstruct the final reply", textDeltas.join("").includes("All done streaming."));
  check("streaming: toolcall deltas are non-empty", toolcallDeltas.join("").length > 0);
  check(
    "streaming: terminal lifecycle events do not duplicate transcript messages",
    terminalEvents.every((event) => !("message" in event) && !("toolResults" in event) && !("messages" in event)),
  );
  check("streaming: run completes", result.status === "completed");
}

async function testStreamRetryResetFallback(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  const base = faux.getChatModel()!;
  const partial = fauxAssistantMessage("partial output", { stopReason: "stop" });
  const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: "socket hang up" });
  const recovered = fauxAssistantMessage("Recovered final output.", { stopReason: "stop" });
  const model = Object.create(base) as ChatModel;
  let streamCalls = 0;
  let completeCalls = 0;

  model.classifyError = () => ({ retryable: true, afterMs: 0 });
  model.stream = () => {
    streamCalls++;
    const out = createAssistantMessageEventStream();
    queueMicrotask(() => {
      out.push({ type: "start", partial });
      out.push({ type: "text_start", contentIndex: 0, partial });
      out.push({ type: "text_delta", contentIndex: 0, delta: "partial output", partial });
      out.push({ type: "error", reason: "error", error: failed });
      out.end(failed);
    });
    return out;
  };
  model.complete = async () => {
    completeCalls++;
    return recovered;
  };

  const events = new ListenerSink();
  const seen: AgentEvent[] = [];
  events.subscribe((e) => void seen.push(e));
  const runner = testRunner({ machine, events });
  const agent = defineAgent({ name: "retry", model, instructions: "x" });
  const result = await runner.run(agent, "go");
  faux.unregister();

  const types = seen.map((e) => e.type);
  const reset = seen.find((e): e is AgentEvent & { type: "turn.step.reset" } => e.type === "turn.step.reset");
  const deltas = seen.flatMap((e) => (e.type === "assistant.delta" ? [e.delta] : []));
  const assistantMessages = seen
    .flatMap((e) => (e.type === "message.appended" && e.message.role === "assistant" ? [JSON.stringify(e.message.content)] : []));
  check("retry-reset: first partial is surfaced before reset", deltas[0] === "partial output");
  check("retry-reset: reset emitted after partial failure", types.indexOf("assistant.delta") < types.indexOf("turn.step.reset"));
  check("retry-reset: reset names discarded and next attempts", reset?.discardedAttempt === 1 && reset.nextAttempt === 2);
  check("retry-reset: fallback complete used after partial stream failure", streamCalls === 1 && completeCalls === 1);
  check("retry-reset: recovered output is emitted after reset", deltas.join("").includes("Recovered final output."));
  check("retry-reset: final transcript excludes dropped partial", result.output.includes("Recovered final output.") && !result.output.includes("partial output"));
  check("retry-reset: only recovered assistant message is appended", assistantMessages.length === 1 && assistantMessages[0]!.includes("Recovered final output."));
  check("retry-reset: run completes", result.status === "completed");
}

async function testHitlResume(dir: string, machine: LocalMachine): Promise<void> {
  const file = join(dir, "approved.txt");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "hello after approval\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Wrote the file after approval.", { stopReason: "stop" }),
    fauxAssistantMessage("Follow-up kept the cached prefix.", { stopReason: "stop" }),
  ]);
  const base = faux.getChatModel()!;
  const requests: Message[][] = [];
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    requests.push([...req.messages]);
    return stream(req, call);
  };
  const agent = defineAgent({ name: "writer", model, instructions: "x", tools: [writeTool] });

  const store = new MemoryStore();
  // manual mode + no responder → Write (no rule) falls to fallback-ask → interrupt (durable).
  const runner = testRunner({
    machine,
    store,
    permission: { mode: "manual" },
    capabilities: [userHooksCapability([{ event: "SessionStart", command: `echo 'CACHE_STABLE_REMINDER'` }])],
  });

  const first = await runner.run(agent, "write the file");
  check("hitl: first run interrupts", first.status === "interrupted");
  check("hitl: pending is the Write call", first.interruption?.pending[0]?.toolName === "Write");
  check("hitl: file not written before approval", !existsSync(file));
  check("hitl: public interruption carries stable id/revision", !!first.interruption?.id && first.interruption.revision > 0);

  const persisted = await store.getState(INTERRUPTION_STATE_KEY);
  check("hitl: interruption state persisted to store (durable)", persisted !== null);
  const persistedObj = parseInterruptionState(persisted);
  check("hitl: control state is slim (no history copy)", !("history" in persistedObj) && persistedObj.version === 1);
  const toolCallId = first.interruptions![0]!.toolCallId;
  // Simulate a cold process: a fresh capability instance would produce different hook output.
  // Replay must retain the original reminder, and HITL resume must not inject between the
  // assistant tool call and its ToolResult.
  const resumedRunner = testRunner({
    machine,
    store,
    permission: { mode: "manual" },
    capabilities: [userHooksCapability([{ event: "SessionStart", command: `echo 'CHANGED_REMINDER'` }])],
  });
  const second = await resumedRunner.resume(agent, { interruption: persistedObj, answers: { [toolCallId]: { kind: "approval", decision: "approved" } } });
  await resumedRunner.run(agent, "follow up after resume");
  faux.unregister();

  check("hitl: resume completes (history replayed from log)", second.status === "completed");
  check("hitl: file written after approval", existsSync(file) && readFileSync(file, "utf8") === "hello after approval\n");
  check("hitl: final output surfaced", second.output.includes("Wrote the file after approval"));
  check("hitl: completed resume consumes interruption state", (await store.getState(INTERRUPTION_STATE_KEY)) === null);
  const firstRequest = requests[0] ?? [];
  const resumedRequest = requests[1] ?? [];
  const followupRequest = requests[2] ?? [];
  check(
    "hitl cache: pre-interrupt request is an exact prefix of resumed request",
    JSON.stringify(resumedRequest.slice(0, firstRequest.length)) === JSON.stringify(firstRequest),
  );
  const resumedAssistant = resumedRequest.findIndex(
    (message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === toolCallId),
  );
  check(
    "hitl cache: ToolResult immediately follows the resumed assistant batch",
    resumedAssistant >= 0 && resumedRequest[resumedAssistant + 1]?.role === "toolResult",
  );
  check(
    "hitl cache: cold replay keeps original injection and suppresses recomputation",
    textOf(followupRequest, "user").includes("CACHE_STABLE_REMINDER") &&
      !textOf(followupRequest, "user").includes("CHANGED_REMINDER"),
  );

  // Audit records landed in the log (usage per turn + the resolved approval decision).
  const log: Array<{ type: string; decision?: string; toolName?: string }> = [];
  for await (const e of store.readRecords()) log.push(e as { type: string; decision?: string; toolName?: string });
  check("hitl: usage audit records journaled", log.some((e) => e.type === "usage.record"));
  check(
    "hitl: approval audit record journaled (Write → approved)",
    log.some((e) => e.type === "permission.record_approval" && e.toolName === "Write" && e.decision === "approved"),
  );
  check(
    "hitl cache: injection was journaled exactly once",
    log.filter((e) => e.type === "context.append_message" && JSON.stringify(e).includes("CACHE_STABLE_REMINDER")).length === 1,
  );
}

async function testParallelSubagentInterruption(dir: string, machine: LocalMachine): Promise<void> {
  const file = join(dir, "parallel-child-approved.txt");
  const rootFaux = registerFauxProvider();
  const child1Faux = registerFauxProvider();
  const child2Faux = registerFauxProvider();
  rootFaux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "Agent",
          { prompt: "pause child", description: "pause child", subagent_type: "child1" },
          { id: "call_agent1" },
        ),
        fauxToolCall(
          "Agent",
          { prompt: "finish child", description: "finish child", subagent_type: "child2" },
          { id: "call_agent2" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("root completed after both children", { stopReason: "stop" }),
  ]);
  child1Faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("Write", { path: file, content: "child1 approved\n" }, { id: "call_child_write" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("child1 completed", { stopReason: "stop" }),
  ]);
  child2Faux.setResponses([fauxAssistantMessage("child2 completed", { stopReason: "stop" })]);

  const child1 = defineAgent({
    name: "child1",
    model: child1Faux.getChatModel()!,
    instructions: "write after approval",
    tools: [writeTool],
  });
  const child2 = defineAgent({
    name: "child2",
    model: child2Faux.getChatModel()!,
    instructions: "finish immediately",
  });
  const root = defineAgent({
    name: "root",
    model: rootFaux.getChatModel()!,
    instructions: "coordinate",
    subagents: [child1, child2],
  });
  const store = new MemoryStore();
  const runner = testRunner({ machine, store, permission: { mode: "manual" } });

  try {
    const first = await runner.run(root, "run both children");
    check("parallel-hitl: root interrupts when one child pauses", first.status === "interrupted");
    check("parallel-hitl: nested Write approval is surfaced", first.interruptions?.[0]?.toolName === "Write");
    check("parallel-hitl: completed sibling reached a stable boundary", child2Faux.state.callCount === 1);
    check("parallel-hitl: paused child did not write before approval", !existsSync(file));

    const stored = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
    const rootFrame = stored.frames[stored.rootFrameId]!;
    check("parallel-hitl: state contains root + paused child frames", Object.keys(stored.frames).length === 2);
    check("parallel-hitl: root maps only paused Agent call to a child frame", Object.keys(rootFrame.children).join() === "call_agent1");
    const mainResults: string[] = [];
    for await (const record of store.readRecords({ address: "main" })) {
      if (record.type === "context.append_message" && record.message.role === "toolResult") {
        mainResults.push(record.message.toolCallId);
      }
    }
    check("parallel-hitl: completed sibling result is already in parent log", mainResults.includes("call_agent2"));

    let blocked = false;
    try {
      await runner.run(root, "must not append while interrupted");
    } catch (error) {
      blocked = error instanceof Error && error.message.includes("interrupted run");
    }
    check("parallel-hitl: normal prompt is blocked while control state exists", blocked);

    const approvalId = first.interruptions![0]!.approvalId;
    const second = await runner.resume(root, { interruption: stored, answers: { [approvalId]: { kind: "approval", decision: "approved" } } });
    check("parallel-hitl: recursive top-down resume completes root", second.status === "completed");
    check("parallel-hitl: paused child resumes and writes", existsSync(file) && readFileSync(file, "utf8") === "child1 approved\n");
    check("parallel-hitl: completed sibling is not re-executed", child2Faux.state.callCount === 1);
    check("parallel-hitl: parent receives both Agent tool results", second.messages.filter((m) => m.role === "toolResult").length === 2);
    check("parallel-hitl: root output continues after child unwind", second.output.includes("root completed"));
    check("parallel-hitl: root completion clears control state", (await store.getState(INTERRUPTION_STATE_KEY)) === null);
  } finally {
    rootFaux.unregister();
    child1Faux.unregister();
    child2Faux.unregister();
  }
}

async function testParallelPartialApproval(dir: string, machine: LocalMachine): Promise<void> {
  const file1 = join(dir, "partial-child1.txt");
  const file2 = join(dir, "partial-child2.txt");
  const rootFaux = registerFauxProvider();
  const child1Faux = registerFauxProvider();
  const child2Faux = registerFauxProvider();
  rootFaux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("Agent", { prompt: "child one", description: "child one", subagent_type: "partial1" }, { id: "partial_agent1" }),
        fauxToolCall("Agent", { prompt: "child two", description: "child two", subagent_type: "partial2" }, { id: "partial_agent2" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("partial approvals completed", { stopReason: "stop" }),
  ]);
  child1Faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file1, content: "one\n" }, { id: "partial_write1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("partial child one done", { stopReason: "stop" }),
  ]);
  child2Faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file2, content: "two\n" }, { id: "partial_write2" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("partial child two done", { stopReason: "stop" }),
  ]);
  const child1 = defineAgent({ name: "partial1", model: child1Faux.getChatModel()!, instructions: "x", tools: [writeTool] });
  const child2 = defineAgent({ name: "partial2", model: child2Faux.getChatModel()!, instructions: "x", tools: [writeTool] });
  const root = defineAgent({ name: "partial-root", model: rootFaux.getChatModel()!, instructions: "x", subagents: [child1, child2] });
  const store = new MemoryStore();
  const runner = testRunner({ machine, store, permission: { mode: "manual" } });

  try {
    const first = await runner.run(root, "start partial approvals");
    check("partial-hitl: both parallel child approvals are surfaced", first.interruptions?.length === 2);
    const approve1 = first.interruptions!.find((item) => item.toolCallId === "partial_write1")!;
    const state1 = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
    const second = await runner.resume(root, { interruption: state1, answers: { [approve1.approvalId]: { kind: "approval", decision: "approved" } } });
    check("partial-hitl: resolving one branch remains interrupted", second.status === "interrupted");
    check("partial-hitl: resolved child completed and wrote", existsSync(file1));
    check("partial-hitl: unresolved child did not write", !existsSync(file2));
    check("partial-hitl: only unresolved approval remains", second.interruptions?.length === 1 && second.interruptions[0]!.toolCallId === "partial_write2");

    const state2 = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
    check("partial-hitl: completed child frame was pruned", Object.keys(state2.frames).length === 2);
    const approve2 = second.interruptions![0]!;
    const third = await runner.resume(root, { interruption: state2, answers: { [approve2.approvalId]: { kind: "approval", decision: "approved" } } });
    check("partial-hitl: second approval completes the root", third.status === "completed");
    check("partial-hitl: second child wrote after its approval", existsSync(file2));
    check("partial-hitl: first completed child was not re-run", child1Faux.state.callCount === 2);
  } finally {
    rootFaux.unregister();
    child1Faux.unregister();
    child2Faux.unregister();
  }
}

// "no live responder ⇒ durable": a Responder is present but reports it isn't a live approver
// (isLiveApprover() === false), so the run must interrupt durably instead of consulting it —
// while a live approver (isLiveApprover absent/true) still resolves the approval in place.
async function testLiveApproverGating(dir: string, machine: LocalMachine): Promise<void> {
  const file = join(dir, "gated.txt");

  // Case 1: non-live approver (isLiveApprover=false) → durable interrupt, requestApproval untouched.
  {
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "x\n" }), { stopReason: "toolUse" })]);
    const model = faux.getChatModel()!;
    const a = defineAgent({ name: "writer", model, instructions: "x", tools: [writeTool] });
    let asked = false;
    const deferring: Responder = {
      isLiveApprover: () => false,
      requestApproval: async () => {
        asked = true;
        return { kind: "approval", decision: "approved" };
      },
      requestQuestion: async () => null,
    };
    const runner = testRunner({ machine, store: new MemoryStore(), permission: { mode: "manual" }, responder: deferring });
    const r = await runner.run(a, "write it");
    faux.unregister();
    check("live-approver: non-live approver → durable interrupt", r.status === "interrupted");
    check("live-approver: non-live approver was NOT consulted", asked === false);
    check("live-approver: interruptions alias populated", r.interruptions?.[0]?.toolName === "Write");
    check("live-approver: file not written (deferred, unanswered)", !existsSync(file));
  }

  // Case 2: live approver (isLiveApprover=true) → live, resolves in place, run completes.
  {
    const faux = registerFauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "live\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const model = faux.getChatModel()!;
    const a = defineAgent({ name: "writer", model, instructions: "x", tools: [writeTool] });
    const approving: Responder = {
      isLiveApprover: () => true,
      requestApproval: async () => ({ kind: "approval", decision: "approved" }),
      requestQuestion: async () => null,
    };
    const runner = testRunner({ machine, store: new MemoryStore(), permission: { mode: "manual" }, responder: approving });
    const r = await runner.run(a, "write it");
    faux.unregister();
    check("live-approver: live approver → live completion", r.status === "completed");
    check("live-approver: live path wrote the file", existsSync(file));
  }
}

// A stopped live approval must not advance to the next approval in the same model batch.
// This is the exact race that used to surface a second permission prompt after Stop.
async function testAbortDuringMultiApprovalBatch(dir: string, machine: LocalMachine): Promise<void> {
  const firstFile = join(dir, "abort-approval-first.txt");
  const secondFile = join(dir, "abort-approval-second.txt");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("Write", { path: firstFile, content: "first\n" }, { id: "abort_approval_first" }),
        fauxToolCall("Write", { path: secondFile, content: "second\n" }, { id: "abort_approval_second" }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);

  const controller = new AbortController();
  const requested: string[] = [];
  let notifyFirstRequested: (() => void) | undefined;
  const firstRequested = new Promise<void>((resolve) => {
    notifyFirstRequested = resolve;
  });
  const responder: Responder = {
    requestApproval: async (request, options) => {
      requested.push(request.toolCallId);
      notifyFirstRequested?.();
      notifyFirstRequested = undefined;
      return new Promise((resolve) => {
        const cancel = () => resolve({ decision: "cancelled" });
        if (options?.signal?.aborted) cancel();
        else options?.signal?.addEventListener("abort", cancel, { once: true });
      });
    },
    requestQuestion: async () => null,
  };
  const agent = defineAgent({
    name: "multi-approval-abort",
    model: faux.getChatModel()!,
    instructions: "write both files",
    tools: [writeTool],
  });
  const runner = testRunner({ machine, store: new MemoryStore(), permission: { mode: "manual" }, responder });

  try {
    const running = runner.run(agent, "write both", { signal: controller.signal });
    await firstRequested;
    controller.abort();
    const result = await running;

    check("multi-approval abort: run ends as aborted", result.status === "aborted");
    check("multi-approval abort: only the visible approval was requested", requested.length === 1 && requested[0] === "abort_approval_first");
    check("multi-approval abort: no approved tool executed", !existsSync(firstFile) && !existsSync(secondFile));
  } finally {
    faux.unregister();
  }
}

// Multi-turn run() on the same store must feed prior turns back to the model: execute() replays
// the branch before appending the new input. Regression guard for the revert that dropped this.
async function testMultiTurnContinuation(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("reply one", { stopReason: "stop" }),
    fauxAssistantMessage("reply two", { stopReason: "stop" }),
  ]);
  const base = faux.getChatModel()!;
  const seen: Message[][] = [];
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    seen.push([...req.messages]);
    return stream(req, call);
  };
  const agent = defineAgent({ name: "chat", model, instructions: "x" });
  const store = new MemoryStore();
  const runner = testRunner({ machine, store });
  await runner.run(agent, "turn one");
  await runner.run(agent, "turn two");
  faux.unregister();

  const second = seen[1] ?? [];
  const has = (role: Message["role"], text: string) =>
    second.some((m) => m.role === role && JSON.stringify(m.content).includes(text));
  check("continuation: 1st run sees only its own input", (seen[0] ?? []).length === 1);
  check("continuation: 2nd run replays prior turns (>=3 messages)", second.length >= 3);
  check("continuation: 2nd run sees the turn-one user message", has("user", "turn one"));
  check("continuation: 2nd run sees the prior assistant reply", has("assistant", "reply one"));
  check("continuation: 2nd run includes the new input", has("user", "turn two"));
}

// A long-lived session appends across turns instead of replaying the whole log each turn.
// CountingStore tallies readRecords (what replayContext calls) to prove the log is replayed
// once, not per turn.
class CountingStore extends MemoryStore {
  pathReads = 0;
  override async *readRecords(filter?: { address?: string }): AsyncIterable<AgentRecord> {
    this.pathReads++;
    yield* super.readRecords(filter);
  }
}

async function testLiveContextReuse(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("r1", { stopReason: "stop" }),
    fauxAssistantMessage("r2", { stopReason: "stop" }),
    fauxAssistantMessage("r3", { stopReason: "stop" }),
    fauxAssistantMessage("r4", { stopReason: "stop" }),
  ]);
  const base = faux.getChatModel()!;
  const seen: Message[][] = [];
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    seen.push([...req.messages]);
    return stream(req, call);
  };
  const agent = defineAgent({ name: "chat", model, instructions: "x" });
  const store = new CountingStore();
  const session = await openTestSession({ machine, store });
  const runner = testRunner({ machine });

  await runner.run(agent, "t1", { session });
  const readsAfterFirstTurn = store.pathReads;
  await runner.run(agent, "t2", { session });
  await runner.run(agent, "t3", { session });
  faux.unregister();
  // Two constant reads: session open (permission fold + live-context seed) and the first
  // prompt's conversation-head resolution. The invariant is that turns after the first
  // APPEND to the live context instead of replaying — reads must not grow with turns.
  check("live-context: log reads are constant across 3 turns (then appends)", readsAfterFirstTurn === 2 && store.pathReads === 2);
  check(
    "live-context: 3rd turn still sees turn 1 (continuity preserved)",
    (seen[2] ?? []).some((m) => m.role === "user" && JSON.stringify(m.content).includes("t1")),
  );

  await session.close();
}

async function testStorelessLiveContext(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("storeless reply one", { stopReason: "stop" }),
    fauxAssistantMessage("storeless reply two", { stopReason: "stop" }),
  ]);
  const base = faux.getChatModel()!;
  const seen: Message[][] = [];
  const model = Object.create(base) as ChatModel;
  const stream = base.stream.bind(base);
  model.stream = (req, call) => {
    seen.push([...req.messages]);
    return stream(req, call);
  };
  const agent = defineAgent({ name: "storeless-chat", model, instructions: "x" });
  const session = await openTestSession({ machine });
  const runner = testRunner({ machine });

  await runner.run(agent, "storeless turn one", { session });
  await runner.run(agent, "storeless turn two", { session });
  faux.unregister();

  const second = seen[1] ?? [];
  check(
    "storeless live-context: ordinary append-only history survives across runs",
    second.some((m) => m.role === "user" && JSON.stringify(m.content).includes("storeless turn one")) &&
      second.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("storeless reply one")),
  );
  await session.close();
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-runner-e2e-"));
  const machine = new LocalMachine(dir);
  try {
  await testHandoff(machine);
  await testHandoffInputType(machine);
  await testDurableHandoffContinuation(dir, machine);
  await testHandoffInterruptionResume(dir, machine);
  await testHandoffResumeIgnoresDecoy(dir, machine);
  await testAmbiguousEdgesRejected(machine);
    await testInputGuardrail(machine);
    await testOutputGuardrail(machine);
    await testStreamingOutputGuardrail(machine);
    await testStreamingOutputGuardrailPass(machine);
    await testToolGuardrail(dir, machine);
    await testAgentAsTool(machine);
    await testSubagentInputGuardrail(machine);
    await testStreamingEvents(machine);
    await testStreamRetryResetFallback(machine);
    await testHitlResume(dir, machine);
    await testParallelSubagentInterruption(dir, machine);
    await testParallelPartialApproval(dir, machine);
    await testLiveApproverGating(dir, machine);
    await testAbortDuringMultiApprovalBatch(dir, machine);
    await testMultiTurnContinuation(machine);
    await testLiveContextReuse(machine);
    await testStorelessLiveContext(machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ RUNNER E2E PASS — handoff + guardrails + tool-guardrail + agent-as-tool + HITL resume + multi-turn continuation + live-context reuse");
  } else {
    console.log("❌ RUNNER E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ RUNNER E2E ERROR:", error);
  process.exit(1);
});
