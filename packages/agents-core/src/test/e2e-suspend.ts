// Tool-initiated durable suspension (ctx.suspend / ctx.resumed):
//  - a tool suspends mid-execution with a request + continuation state → run interrupts durably
//  - resume delivers { kind: "input", data } back to the SAME call with its saved state
//  - completed parallel siblings are not re-run; unanswered suspensions auto re-park
//  - multi-round suspends consume answers one-shot; state stays private to the frame
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineModel,
  defineAgent,
  defineTool,
  Runner,
  LocalMachine,
  ListenerSink,
  MemoryStore,
  INTERRUPTION_STATE_KEY,
  getInterruptionState,
  parseInterruptionState,
  askUserQuestionTool,
  askUser,
  type AgentEvent,
} from "../index.ts";
import { ToolSuspendSignal } from "../loop/interruption.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface PickState {
  readonly candidates: readonly string[];
}

/** Two-phase tool: expensive "search" → suspend for a choice → "book" the answer. */
function makePickTool(counters: { resolves: number; searches: number; books: number }) {
  return defineTool({
    name: "pick",
    description: "search candidates, ask the user to pick one, then book it",
    params: z.object({ topic: z.string() }),
    resolve: (args) => {
      counters.resolves++;
      return {
        approvalRule: `pick(${args.topic})`,
        run: async (ctx) => {
          if (ctx.resumed) {
            const state = ctx.resumed.state as PickState;
            const { choice } = ctx.resumed.answer as { choice: string };
            counters.books++;
            return { content: [{ type: "text" as const, text: `booked:${choice} of:${state.candidates.join(",")}` }] };
          }
          counters.searches++;
          const candidates = [`${args.topic}-A`, `${args.topic}-B`];
          ctx.suspend(
            { kind: "choice", display: { title: `pick one ${args.topic}`, candidates } },
            { candidates } satisfies PickState,
          );
        },
      };
    },
  });
}

async function testSuspendResume(machine: LocalMachine): Promise<void> {
  const counters = { resolves: 0, searches: 0, books: 0 };
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pick", { topic: "flight" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Booked the flight you picked.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "picker", model, instructions: "x", tools: [makePickTool(counters)] });

  const store = new MemoryStore();
  const events = new ListenerSink();
  const seen: AgentEvent[] = [];
  events.subscribe((e) => void seen.push(e));
  const runner = new Runner({ machine, store, events, permission: { mode: "yolo" } });

  const first = await runner.run(agent, "book me a flight");
  check("suspend: first run interrupts", first.status === "interrupted");
  const pending = first.interruptions?.[0];
  check("suspend: pending is an input interrupt", pending?.kind === "input" && pending.toolName === "pick");
  check("suspend: request surfaced to caller", pending?.kind === "input" && (pending.request.display as { title?: string }).title === "pick one flight");
  check("suspend: continuation state NOT exposed publicly", pending !== undefined && !("state" in pending));
  check("suspend: search ran exactly once before pausing", counters.searches === 1 && counters.books === 0);
  check(
    "suspend: tool.suspended event emitted with request",
    seen.some((e) => e.type === "tool.suspended" && e.toolName === "pick" && e.request?.kind === "choice"),
  );
  check(
    "suspend: turn.paused carries the input pending",
    seen.some((e) => e.type === "turn.paused" && e.pending[0]?.kind === "input"),
  );

  // getInterruptionState(result) is the ONLY public way to get a resume()-ready
  // InterruptionState straight off a RunResult — resume() requires the full state, but
  // RunResult.interruption only carries the lightweight {id, revision, pending} projection.
  // Without this export, callers had no public path to build a valid resume() call at all.
  const fromResult = getInterruptionState(first);
  check("suspend: getInterruptionState(result) recovers a resume()-ready state from the RunResult", fromResult?.rootFrameId !== undefined);

  const persistedRaw = await store.getState(INTERRUPTION_STATE_KEY);
  check("suspend: interruption state persisted (durable)", persistedRaw !== null);
  const persisted = parseInterruptionState(persistedRaw);
  check(
    "suspend: getInterruptionState(result) matches what was durably persisted",
    fromResult !== undefined && fromResult.interruptionId === persisted.interruptionId && fromResult.revision === persisted.revision,
  );
  const frame = persisted.frames[persisted.rootFrameId]!;
  const frameEntry = frame.pending[0];
  check(
    "suspend: frame keeps the private continuation state",
    frameEntry?.kind === "input" && (frameEntry.state as PickState).candidates.length === 2,
  );

  // Resume using the PUBLICLY obtained state (fromResult), not the store-read one — this is
  // the round trip a caller with no direct store access must be able to do.
  const second = await runner.resume(agent, {
    interruption: fromResult!,
    answers: { [pending!.approvalId]: { kind: "input", data: { choice: "flight-A" } } },
  });
  faux.unregister();

  check("suspend: resume completes", second.status === "completed");
  check("suspend: final output surfaced", second.output.includes("Booked the flight"));
  check("suspend: answer + saved state reached the re-run", counters.books === 1);
  check("suspend: expensive phase was NOT re-run on resume", counters.searches === 1);
  check("suspend: resolve re-runs on resume (rerun model)", counters.resolves >= 2);
  check("suspend: completed resume consumes interruption state", (await store.getState(INTERRUPTION_STATE_KEY)) === null);
}

async function testMixedBatchSiblingNotRerun(machine: LocalMachine): Promise<void> {
  const counters = { resolves: 0, searches: 0, books: 0 };
  let echoRuns = 0;
  const echoTool = defineTool({
    name: "echo",
    description: "echo",
    params: z.object({ text: z.string() }),
    resolve: (args) => ({
      approvalRule: `echo(${args.text})`,
      run: async () => {
        echoRuns++;
        return { content: [{ type: "text" as const, text: `echo:${args.text}` }] };
      },
    }),
  });

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("echo", { text: "hi" }), fauxToolCall("pick", { topic: "hotel" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Both done.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "mixed", model, instructions: "x", tools: [echoTool, makePickTool(counters)] });

  const store = new MemoryStore();
  const runner = new Runner({ machine, store, permission: { mode: "yolo" } });
  const first = await runner.run(agent, "echo and pick");
  check("mixed: run interrupts on the suspending call", first.status === "interrupted");
  check("mixed: only the suspended call is pending", first.interruptions?.length === 1 && first.interruptions[0]!.toolName === "pick");
  check("mixed: sibling completed before the pause", echoRuns === 1);

  const persisted = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const second = await runner.resume(agent, {
    interruption: persisted,
    answers: { [first.interruptions![0]!.approvalId]: { kind: "input", data: { choice: "hotel-B" } } },
  });
  faux.unregister();

  check("mixed: resume completes", second.status === "completed");
  check("mixed: journaled sibling was NOT re-run on resume", echoRuns === 1);
  check("mixed: suspended call finished with its answer", counters.books === 1);
}

async function testPartialAnswerAutoRepark(machine: LocalMachine): Promise<void> {
  const counters = { resolves: 0, searches: 0, books: 0 };
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("pick", { topic: "car" }), fauxToolCall("pick", { topic: "bike" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Both picked.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "partial", model, instructions: "x", tools: [makePickTool(counters)] });

  const store = new MemoryStore();
  const runner = new Runner({ machine, store, permission: { mode: "yolo" } });
  const first = await runner.run(agent, "pick car and bike");
  check("repark: both suspensions surfaced", first.interruptions?.length === 2);
  check("repark: both ran their search phase", counters.searches === 2);
  const carPending = first.interruptions!.find((p) => p.kind === "input" && JSON.stringify(p.request).includes("car"))!;
  const bikePending = first.interruptions!.find((p) => p.kind === "input" && JSON.stringify(p.request).includes("bike"))!;

  // Answer only one — the other must re-park untouched (not re-run, state kept).
  const state1 = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const second = await runner.resume(agent, {
    interruption: state1,
    answers: { [carPending.approvalId]: { kind: "input", data: { choice: "car-A" } } },
  });
  check("repark: partially answered run stays interrupted", second.status === "interrupted");
  check(
    "repark: only the unanswered suspension remains",
    second.interruptions?.length === 1 && second.interruptions[0]!.toolCallId === bikePending.toolCallId,
  );
  check("repark: answered call completed", counters.books === 1);
  check("repark: re-parked call was NOT re-run (no extra search)", counters.searches === 2);
  const state2 = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const reparked = state2.frames[state2.rootFrameId]!.pending[0];
  check(
    "repark: continuation state survived the re-park",
    reparked?.kind === "input" && (reparked.state as PickState).candidates.includes("bike-A"),
  );

  const third = await runner.resume(agent, {
    interruption: state2,
    answers: { [second.interruptions![0]!.approvalId]: { kind: "input", data: { choice: "bike-B" } } },
  });
  faux.unregister();
  check("repark: second resume completes the run", third.status === "completed");
  check("repark: both calls eventually booked", counters.books === 2);
}

async function testMultiRoundSuspend(machine: LocalMachine): Promise<void> {
  const rounds: string[] = [];
  const wizardTool = defineTool({
    name: "wizard",
    description: "two-round wizard",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "wizard",
      run: async (ctx) => {
        if (!ctx.resumed) {
          ctx.suspend({ kind: "question", display: "round-1" }, { round: 1 });
        }
        const state = ctx.resumed.state as { round: number };
        rounds.push(`round${state.round}:${String(ctx.resumed.answer)}`);
        if (state.round === 1) {
          ctx.suspend({ kind: "question", display: "round-2" }, { round: 2 });
        }
        return { content: [{ type: "text" as const, text: `wizard-done:${String(ctx.resumed.answer)}` }] };
      },
    }),
  });

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("wizard", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Wizard finished.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "wiz", model, instructions: "x", tools: [wizardTool] });

  const store = new MemoryStore();
  const runner = new Runner({ machine, store, permission: { mode: "yolo" } });
  const first = await runner.run(agent, "run the wizard");
  check("rounds: round 1 pauses", first.status === "interrupted");

  const state1 = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const second = await runner.resume(agent, {
    interruption: state1,
    answers: { [first.interruptions![0]!.approvalId]: { kind: "input", data: "A1" } },
  });
  check("rounds: answering round 1 pauses again on round 2", second.status === "interrupted");
  check(
    "rounds: round-2 request surfaced",
    second.interruptions?.[0]?.kind === "input" && second.interruptions[0].request.display === "round-2",
  );

  const state2 = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const toolCallId = second.interruptions![0]!.toolCallId;
  check(
    "rounds: consumed round-1 answer dropped from the new frame",
    !(toolCallId in (state2.frames[state2.rootFrameId]!.inputAnswers ?? {})),
  );

  const third = await runner.resume(agent, {
    interruption: state2,
    answers: { [second.interruptions![0]!.approvalId]: { kind: "input", data: "A2" } },
  });
  faux.unregister();
  check("rounds: run completes after round 2", third.status === "completed");
  check("rounds: each round saw ITS answer (one-shot, no stale replay)", JSON.stringify(rounds) === '["round1:A1","round2:A2"]');
}

async function testSuspendMisuseAndBadState(machine: LocalMachine): Promise<void> {
  const badStateTool = defineTool({
    name: "bad_state",
    description: "suspends with unserializable state",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "bad_state",
      run: async (ctx) => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        ctx.suspend({ kind: "q" }, circular);
        return { content: [{ type: "text" as const, text: "unreachable" }] };
      },
    }),
  });
  const suspendInResolveTool = defineTool({
    name: "suspend_in_resolve",
    description: "throws the suspend signal during resolve",
    params: z.object({}),
    resolve: () => {
      throw new ToolSuspendSignal({ kind: "q" });
    },
  });

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bad_state", {}), fauxToolCall("suspend_in_resolve", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Handled the errors.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "misuse", model, instructions: "x", tools: [badStateTool, suspendInResolveTool] });

  const events = new ListenerSink();
  const seen: AgentEvent[] = [];
  events.subscribe((e) => void seen.push(e));
  const runner = new Runner({ machine, events, permission: { mode: "yolo" } });
  const result = await runner.run(agent, "go");
  faux.unregister();

  const resultTextFor = (name: string): string =>
    seen
      .flatMap((e) => (e.type === "tool.result" && e.toolName === name ? [JSON.stringify(e.result.content)] : []))
      .join("");
  check("misuse: unserializable state → error result, run completes", result.status === "completed");
  check("misuse: error names the tool and the JSON contract", resultTextFor("bad_state").includes("JSON-serializable"));
  check("misuse: suspend during resolve → descriptive error result", resultTextFor("suspend_in_resolve").includes("only available during tool execution"));
}

async function testAskUserQuestionDurable(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("AskUserQuestion", {
        questions: [{ question: "Deploy to prod?", header: "Deploy", options: [{ label: "Yes" }, { label: "No" }], multi_select: false }],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Deploying to prod.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "asker", model, instructions: "x", tools: [askUserQuestionTool] });

  const store = new MemoryStore();
  // No responder anywhere → the question suspends durably instead of soft-failing.
  // manual mode: AskUserQuestion is on the default-approve list (yolo would deny it outright).
  const runner = new Runner({ machine, store, permission: { mode: "manual" } });
  const first = await runner.run(agent, "ask me about deploy");
  check("askuser: no responder → durable suspension", first.status === "interrupted");
  const pending = first.interruptions?.[0];
  check(
    "askuser: pending carries the question payload",
    pending?.kind === "input" && pending.request.kind === "question" && JSON.stringify(pending.request.display).includes("Deploy to prod?"),
  );

  const persisted = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));
  const second = await runner.resume(agent, {
    interruption: persisted,
    answers: { [pending!.approvalId]: { kind: "input", data: { answers: { "Deploy to prod?": "Yes" } } } },
  });
  faux.unregister();
  check("askuser: resume delivers the structured answer", second.status === "completed");
  const answered = second.messages.some(
    (m) => m.role === "toolResult" && JSON.stringify(m.content).includes('\\"Deploy to prod?\\":\\"Yes\\"'),
  );
  check("askuser: tool result contains the answers JSON", answered);
}

async function testAskUserReentryGuard(machine: LocalMachine): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("double_ask", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  // A misbehaving tool that asks TWICE in one run: the guard must throw on the second
  // call instead of silently returning the first (stale) answer.
  const doubleAsk = defineTool({
    name: "double_ask",
    description: "asks twice",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "double_ask",
      run: async (ctx) => {
        const one = await askUser(ctx, [{ question: "Q1?", header: "Q1", options: [{ label: "a", description: "a" }], multiSelect: false }]);
        const two = await askUser(ctx, [{ question: "Q2?", header: "Q2", options: [{ label: "b", description: "b" }], multiSelect: false }]);
        return { content: [{ type: "text", text: JSON.stringify({ one, two }) }] };
      },
    }),
  });
  const agent = defineAgent({ name: "double", model, instructions: "x", tools: [doubleAsk] });
  // Live question channel: the FIRST ask answers inline; the second must trip the guard.
  const responder = {
    requestApproval: async () => ({ decision: "approved" as const }),
    requestQuestion: async () => ({ answers: { "Q1?": "a" } }),
  };
  const runner = new Runner({ machine, responder, permission: { mode: "yolo" } });
  const result = await runner.run(agent, "go");
  faux.unregister();
  const tr = result.messages.find((m) => m.role === "toolResult");
  check("reentry: run completes (tool error, not a hang or stale answer)", result.status === "completed");
  check(
    "reentry: second askUser in one run throws the guard error",
    tr !== undefined && tr.isError === true && JSON.stringify(tr.content).includes("askUser was called twice"),
  );
}

// ── suspend() `never` contract: a non-conforming ToolRunContext whose suspend RETURNS
//    must fail loudly instead of resolving `undefined` as the "answer" ──
async function testSuspendNeverGuard(): Promise<void> {
  const fakeCtx = {
    turnId: "t1",
    toolCallId: "c1",
    signal: new AbortController().signal,
    suspend: () => undefined, // violates the `never` contract on purpose
  } as unknown as Parameters<typeof askUser>[0];
  let loud = false;
  try {
    await askUser(fakeCtx, [{ question: "Q?", header: "Q", options: [{ label: "a", description: "a" }], multiSelect: false }]);
  } catch (error) {
    loud = error instanceof Error && error.message.includes("non-conforming");
  }
  check("suspend contract: a suspend() that returns fails loudly, not a phantom undefined answer", loud);
}

async function testAnswerKindValidation(machine: LocalMachine): Promise<void> {
  const counters = { resolves: 0, searches: 0, books: 0 };
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pick", { topic: "seat" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "kinds", model, instructions: "x", tools: [makePickTool(counters)] });

  const store = new MemoryStore();
  const runner = new Runner({ machine, store, permission: { mode: "yolo" } });
  const first = await runner.run(agent, "pick a seat");
  const persisted = parseInterruptionState(await store.getState(INTERRUPTION_STATE_KEY));

  let error: unknown;
  try {
    await runner.resume(agent, {
      interruption: persisted,
      answers: { [first.interruptions![0]!.approvalId]: { kind: "approval", decision: "approved" } },
    });
  } catch (e) {
    error = e;
  }
  faux.unregister();
  check(
    "kinds: approval answer for an input pending is rejected",
    error instanceof Error && error.message.includes('expects "input"'),
  );
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "operon-suspend-"));
  const machine = new LocalMachine({ cwd: dir });
  try {
    await testSuspendResume(machine);
    await testMixedBatchSiblingNotRerun(machine);
    await testPartialAnswerAutoRepark(machine);
    await testMultiRoundSuspend(machine);
    await testSuspendMisuseAndBadState(machine);
    await testAskUserQuestionDurable(machine);
    await testAskUserReentryGuard(machine); // was defined but never registered — checks silently didn't run
    await testSuspendNeverGuard();
    await testAnswerKindValidation(machine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("❌ SUSPEND E2E FAIL");
    process.exit(1);
  }
  console.log("✅ SUSPEND E2E PASS — ctx.suspend/resumed + durable input HITL + auto re-park + multi-round");
}

await main();
