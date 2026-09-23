// Durable INPUT suspension answered through the Harness facade.
//
// `HarnessSession.resume` used to wrap every answer as `{ kind: "approval" }` — a run
// durably suspended on a tool's `ctx.suspend` (an input interrupt) could never be answered
// through the facade at all: the harness was approval-only while the core Runner already
// accepted `{ kind: "input", data }`. This exercises the pass-through: bare
// ApprovalResponses still work (shorthand), and discriminated InterruptAnswers reach the
// suspended tool cross-process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineAgent, DiskSessionRepository, type AgentEvent, type SteerReceipt, type Tool } from "operon-agents-core";
import { createHarness } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface PickState {
  readonly candidates: string[];
}

async function testResumeSteering(mode: "complete" | "gated" | "reinterrupt" | "invalid-answer"): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "af-resume-steer-"));
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const harness = createHarness({
    model,
    workDir: home,
    harness: () => ({ sessionRepository: new DiskSessionRepository(join(home, "sessions")) }),
    permission: { mode: "yolo" },
  });
  let onResumed: (() => void) | undefined;
  let onPausedAgain: (() => void) | undefined;
  let pauses = 0;
  const pick: Tool = {
    schema: { name: "pick", description: "pause for input", parameters: { type: "object", properties: {} } },
    resolve: () => ({
      approvalRule: "pick",
      run: async (ctx) => {
        if (ctx.resumed) {
          onResumed?.();
          return { content: [{ type: "text", text: "picked" }] };
        }
        if (++pauses > 1) onPausedAgain?.();
        ctx.suspend({ kind: "choice", display: { title: "Pick one" } }, {});
        return undefined as never;
      },
    }),
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pick", {}), { stopReason: "toolUse" }),
    mode === "reinterrupt"
      ? fauxAssistantMessage(fauxToolCall("pick", {}), { stopReason: "toolUse" })
      : fauxAssistantMessage("resumed", { stopReason: "stop" }),
    fauxAssistantMessage("consumed late messages", { stopReason: "stop" }),
  ]);
  try {
    const session = await harness.createSession({ agent: defineAgent({ name: "picker", model, instructions: "x", tools: [pick] }) });
    const first = await session.prompt("pick");
    const pending = first.interruptions![0]!;
    check(`${mode}: paused root refuses steerTo before resume`, session.steerTo("main", "not yet", { kind: "user" }) === undefined);
    const events: AgentEvent[] = [];
    const late: SteerReceipt[] = [];
    let during: SteerReceipt | undefined;
    let gate: ReturnType<typeof session.holdAtBoundary> | undefined;
    let injected = false;
    onResumed = () => { during = session.steerTo("main", "during resumed tool", { kind: "user" }); };
    onPausedAgain = () => { late.push(session.steer("keep for the next resume")); };
    session.onEvent((event) => {
      events.push(event);
      if (event.type !== "agent.ended" || injected || (mode !== "complete" && mode !== "gated")) return;
      injected = true;
      if (mode === "gated") gate = session.holdAtBoundary();
      late.push(session.steer("late one"), session.steer("late two"));
    });
    const resuming = session.resume({
      [mode === "invalid-answer" ? "unknown-answer" : pending.approvalId]: { kind: "input", data: "chosen" },
    });
    // The call has registered its run but is still awaiting the durable control record.
    const early = session.steerTo("main", "while loading resume state", { kind: "user" });
    check(`${mode}: resume synchronously reports running and accepts steerTo`, session.status.state === "running" && early !== undefined);
    check(`${mode}: absent child is not started by steerTo`, session.steerTo("main/missing", "hello", { kind: "user" }) === undefined);
    const outcome = await resuming.then((result) => result.status, (error: Error) => error.message);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.whenIdle();

    if (mode === "invalid-answer" || mode === "reinterrupt") {
      check(`${mode}: resume preserves the durable pause`, mode === "invalid-answer" ? outcome.includes("not pending") : outcome === "interrupted");
      check(`${mode}: queued input cannot wake a paused run`, session.status.state === "interrupted" && session.status.hasQueuedMessages);
      check(`${mode}: no extra run starts`, events.filter((event) => event.type === "agent.started").length === (mode === "invalid-answer" ? 0 : 1));
      check(`${mode}: the pending interruption remains recoverable`, (await session.pendingInterruptions()).length > 0);
      check(`${mode}: paused root still refuses steerTo`, session.steerTo("main", "not yet", { kind: "user" }) === undefined);
    } else {
      check(`${mode}: resume completes`, outcome === "completed");
      check(`${mode}: steerTo accepts input during resumed execution`, during !== undefined);
      if (mode === "gated") {
        check("gated: run exit leaves late input queued behind the barrier", gate !== undefined && session.status.hasQueuedMessages && events.filter((event) => event.type === "agent.started").length === 1);
        gate!.release();
        await session.whenIdle();
      }
      const consumed = events.filter((event) => event.type === "message.appended").map((event) => event.origin && "steerId" in event.origin ? event.origin.steerId : undefined);
      check(`${mode}: early and in-flight steers are consumed`, early !== undefined && during !== undefined && consumed.includes(early.steerId) && consumed.includes(during.steerId));
      check(`${mode}: both late messages are consumed exactly once`, late.length === 2 && late.every((receipt) => consumed.filter((id) => id === receipt.steerId).length === 1));
      check(`${mode}: late messages produce exactly one wake run`, events.filter((event) => event.type === "agent.started").length === 2);
      check(`${mode}: session finishes idle with an empty queue`, session.status.state === "idle" && !session.status.hasQueuedMessages);
    }
    const closing = session.close();
    check(`${mode}: closing refuses steerTo`, session.steerTo("main", "closed", { kind: "user" }) === undefined);
    await closing;
    check(`${mode}: closed refuses steerTo`, session.steerTo("main", "closed", { kind: "user" }) === undefined);
  } finally {
    await harness.close();
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "af-input-resume-home-"));
  const work = mkdtempSync(join(tmpdir(), "af-input-resume-work-"));

  const counters = { searches: 0, books: 0 };
  // Raw Tool (no defineTool) so the test needs no direct zod dependency.
  const pickTool: Tool = {
    schema: {
      name: "pick",
      description: "search candidates, ask the user to pick one, then book it",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    },
    resolve: (rawArgs) => {
      const { topic } = rawArgs as { topic: string };
      return {
        approvalRule: `pick(${topic})`,
        run: async (ctx) => {
          if (ctx.resumed) {
            const state = ctx.resumed.state as PickState;
            const { choice } = ctx.resumed.answer as { choice: string };
            counters.books++;
            return { content: [{ type: "text" as const, text: `booked:${choice} of:${state.candidates.join(",")}` }] };
          }
          counters.searches++;
          const candidates = [`${topic}-A`, `${topic}-B`];
          ctx.suspend({ kind: "choice", display: { title: `pick one ${topic}`, candidates } }, { candidates } satisfies PickState);
          return undefined as never;
        },
      };
    },
  };

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pick", { topic: "flight" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Booked the flight you picked.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const picker = defineAgent({ name: "picker", model, instructions: "x", tools: [pickTool] });

  try {
    // ── Process 1: the tool suspends for input; the run interrupts durably ──
    const harness1 = createHarness({ model, harness: () => ({ sessionRepository: new DiskSessionRepository(home) }), workDir: work, permission: { mode: "yolo" } });
    const session1 = await harness1.createSession({ agent: picker });
    const sessionId = session1.id;

    const first = await session1.prompt("book me a flight");
    const pending = first.interruptions?.[0];
    check("input-resume: prompt interrupts durably on the tool's suspend", first.status === "interrupted");
    check("input-resume: pending interrupt is kind 'input'", pending?.kind === "input" && pending.toolName === "pick");
    check("input-resume: search phase ran once before pausing", counters.searches === 1 && counters.books === 0);

    await session1.close();
    await harness1.close();

    // ── Process 2: a fresh harness answers the INPUT suspension via resume ──
    const harness2 = createHarness({ model, harness: () => ({ sessionRepository: new DiskSessionRepository(home) }), workDir: work, permission: { mode: "yolo" } });
    const session2 = await harness2.resumeSession(sessionId, { agent: picker });
    check("input-resume: reopened durable pause reports interrupted", session2.status.state === "interrupted");
    check("input-resume: reopened pause exposes pending input", (await session2.pendingInterruptions())[0]?.kind === "input");

    const second = await session2.resume({ [pending!.approvalId]: { kind: "input", data: { choice: "flight-A" } } });
    check("input-resume: resume with a { kind: 'input' } answer completes the run", second.status === "completed");
    check("input-resume: the answer + saved state reached the suspended tool", counters.books === 1 && second.messages.some((m) => JSON.stringify(m.content).includes("booked:flight-A of:flight-A,flight-B")));
    check("input-resume: final output surfaced", second.output.includes("Booked the flight"));

    await session2.close();
    await harness2.close();
  } finally {
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }

  for (const mode of ["complete", "gated", "reinterrupt", "invalid-answer"] as const) await testResumeSteering(mode);

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ HARNESS INPUT-RESUME E2E PASS — durable input suspension answered through HarnessSession.resume");
  } else {
    console.log("❌ HARNESS INPUT-RESUME E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ HARNESS INPUT-RESUME E2E ERROR:", error);
  process.exit(1);
});
