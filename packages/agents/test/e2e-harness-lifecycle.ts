/**
 * HarnessSession lifecycle: cancel reaches EVERY accepted run (in flight and queued), a queued
 * run cancelled before it takes the run lock never touches the session, and the closed checks
 * cover every run entry point (prompt, resume, promptStream).
 */
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineAgent, token } from "operon-agents-core";
import { createHarness, defaultCapabilities, tool } from "../src/index.ts";
import { setHarnessCloseTimeoutsForTest } from "../src/internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingAfter = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  const MARKER = Symbol("pending");
  return (await Promise.race([promise.then(() => "settled", () => "settled"), sleep(ms).then(() => MARKER)])) === MARKER;
};

/** A tool that parks until released, and records when it enters its finally. */
function holdTool(log: string[]) {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const enteredFinally = new Promise<void>((resolve) => { entered = resolve; });
  const t = tool({
    name: "Hold",
    description: "Park until released.",
    parameters: z.object({}),
    execute: async () => {
      log.push("hold:start");
      try {
        await released;
        return "released";
      } finally {
        log.push("hold:finally");
        entered();
      }
    },
  });
  return { tool: t, release, enteredFinally };
}

async function cancelCoversQueuedRuns(): Promise<void> {
  const faux = registerFauxProvider();
  const log: string[] = [];
  const hold = holdTool(log);
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession({ agent: defineAgent({ name: "holder", model, instructions: "x", tools: [hold.tool] }) });
  let started = 0;
  session.onEvent((event) => { if (event.type === "agent.started") started += 1; });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("first done", { stopReason: "stop" }),
    fauxAssistantMessage("second done", { stopReason: "stop" }),
  ]);
  const first = session.prompt("first");
  await sleep(30);
  check("cancel: the first run is parked inside its tool", log.includes("hold:start"));
  const second = session.prompt("second (queued behind the run lock)");
  await sleep(30);
  check("cancel: the session reports running with a run queued", session.status.state === "running");
  check("cancel: the queued run has not started (no second agent.started)", started === 1);

  session.cancel();
  // The run lock's wait is not abortable (a mid-chain bail-out would break mutual exclusion):
  // the queued run stays parked until the lock frees, then bails on acquiring it.
  check("cancel: the queued run stays parked on the lock while the in-flight tool holds it", await pendingAfter(second, 60));
  hold.release();
  const firstResult = await first;
  let secondError: unknown;
  await second.catch((error) => { secondError = error; });
  check("cancel: the queued run is rejected with an AbortError once the lock frees", secondError instanceof Error && secondError.name === "AbortError");
  check("cancel: the in-flight run settles as aborted once its tool returns", firstResult.status === "aborted");
  check("cancel: the queued run never emitted agent.started", started === 1);
  check("cancel: idle afterwards", session.status.state === "idle");
  await harness.close();
  faux.unregister();
}

async function closedChecksOnEveryEntry(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  await session.close();
  let promptThrew = false;
  await session.prompt("x").catch(() => { promptThrew = true; });
  check("closed: prompt rejects", promptThrew);
  let resumeThrew = false;
  await session.resume({}).catch((error: Error) => { resumeThrew = /closed/.test(error.message); });
  check("closed: resume rejects with the closed error (not 'no interrupted run')", resumeThrew);
  let streamThrew = false;
  try {
    session.promptStream("x");
  } catch (error) {
    streamThrew = error instanceof Error && /closed/.test(error.message);
  }
  check("closed: promptStream throws the closed error", streamThrew);
  await harness.close();
  faux.unregister();
}

async function closeWaitsForRuns(): Promise<void> {
  const faux = registerFauxProvider();
  const log: string[] = [];
  const hold = holdTool(log);
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession({ agent: defineAgent({ name: "holder", model, instructions: "x", tools: [hold.tool] }) });
  let started = 0;
  session.onEvent((event) => { if (event.type === "agent.started") started += 1; });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("first done", { stopReason: "stop" }),
    fauxAssistantMessage("second done", { stopReason: "stop" }),
  ]);
  const first = session.prompt("first");
  await sleep(30);
  const second = session.prompt("second (queued)");
  await sleep(10);

  const closing = session.close();
  check("close: every close() call returns the identical promise", session.close() === closing);
  check("close: status reports closed as soon as close() is called", session.status.state === "closed");
  await sleep(40);
  check("close: the tool's finally has not run yet — the run is still winding down", !log.includes("hold:finally"));
  check("close: close() is still pending while the run winds down", await pendingAfter(closing, 40));
  check("close: the core session is still open meanwhile (no dispose under the run's feet)", session.core.scope.state === "open");
  hold.release();
  await closing;
  check("close: after close() resolves, the tool's finally HAS run", log.includes("hold:finally"));
  check("close: ...and the core scope is closed", session.core.scope.state === "closed");
  check("close: the in-flight run settled as aborted", (await first).status === "aborted");
  let secondError: unknown;
  await second.catch((error) => { secondError = error; });
  check("close: the queued run was rejected with an AbortError and never started", secondError instanceof Error && secondError.name === "AbortError" && started === 1);
  check("close: the core's close() also hands back one promise", session.core.close() === session.core.close());
  let afterClose = false;
  await session.prompt("late").catch(() => { afterClose = true; });
  check("close: a prompt after close rejects", afterClose);
  await harness.close();
  faux.unregister();
}

async function closeGivesUpOnStuckRun(): Promise<void> {
  const faux = registerFauxProvider();
  const log: string[] = [];
  const hold = holdTool(log); // never released until we are done: this run ignores its abort
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession({ agent: defineAgent({ name: "holder", model, instructions: "x", tools: [hold.tool] }) });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const run = session.prompt("stuck");
  await sleep(30);
  setHarnessCloseTimeoutsForTest({ runSettle: 80 });
  try {
    const startedAt = Date.now();
    await session.close();
    const elapsed = Date.now() - startedAt;
    check("close deadline: close() returns after the run-settle deadline even though the run is stuck", elapsed >= 70 && elapsed < 2_000);
    check("close deadline: the stuck tool has NOT finished — the deadline abandons the wait, it does not stop the run", !log.includes("hold:finally"));
    check("close deadline: the core scope was closed anyway", session.core.scope.state === "closed");
  } finally {
    setHarnessCloseTimeoutsForTest({ runSettle: 5_000 });
  }
  hold.release();
  await run.catch(() => undefined);
  await harness.close();
  faux.unregister();
}

async function barrierWaitersFailOnClose(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  faux.setResponses([fauxAssistantMessage("never", { stopReason: "stop" }), fauxAssistantMessage("never", { stopReason: "stop" })]);
  const hold = session.holdAtBoundary();
  const parkedPrompt = session.prompt("parked");
  const parkedStream = session.promptStream("parked stream");
  const parkedResume = session.resume({});
  check("gate+close: prompt parks at the gate", await pendingAfter(parkedPrompt, 40));
  check("gate+close: promptStream's completion parks at the gate", await pendingAfter(parkedStream.completed, 40));
  const closing = session.close();
  const errors = await Promise.all([parkedPrompt, parkedStream.completed, parkedResume].map((p) => p.then(() => undefined, (error: Error) => error.message)));
  check("gate+close: the parked prompt fails with the closed error", /closed/.test(errors[0] ?? ""));
  check("gate+close: the parked promptStream fails with the closed error", /closed/.test(errors[1] ?? ""));
  check("gate+close: the parked resume fails with the closed error", /closed/.test(errors[2] ?? ""));
  let iterated = 0;
  try {
    for await (const _event of parkedStream) iterated += 1;
  } catch {
    // the handle's iteration rejects too
  }
  check("gate+close: the parked stream yields no events", iterated === 0);
  await closing;
  check("gate+close: close() completed with the gate still held (the barrier owner releases it later)", session.status.state === "closed");
  hold.release();
  await harness.close();
  faux.unregister();
}

async function idleCloseIsQuiet(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const faux = registerFauxProvider();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  await session.close();
  await harness.close();
  await sleep(20);
  process.off("unhandledRejection", onUnhandled);
  check("idle close: closing an idle session produces no unhandled rejection", unhandled.length === 0);
  faux.unregister();
}

const WsProbe = token<{ close(): void }>("lifecycle-test-ws-probe", "workspace");

async function openFailureRollsBack(): Promise<void> {
  const faux = registerFauxProvider();
  let wsDisposed = 0;
  let failNext = true;
  let failedScope: { readonly state: string } | undefined;
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    workspace: (scope) => { scope.register(WsProbe, { close: () => void (wsDisposed += 1) }); },
    session: (scope) => {
      if (failNext) {
        failNext = false;
        failedScope = scope;
        throw new Error("session hook boom");
      }
      return defaultCapabilities({ scope });
    },
  });
  let error: unknown;
  await harness.createSession({ id: "rollback-1" }).catch((e) => { error = e; });
  check("rollback: the open rejects with the hook's own error", error instanceof Error && error.message === "session hook boom");
  check("rollback: no active session was registered", harness.getSession("rollback-1") === undefined);
  check("rollback: the half-built session scope is closed", failedScope?.state === "closed");
  check("rollback: the workspace hold was returned — as its only holder, the failed open closed the workspace", wsDisposed === 1);
  const ok = await harness.createSession();
  check("rollback: a later open composes a fresh workspace and succeeds", ok.status.state === "idle");
  await ok.close();
  check("rollback: closing that session closes its workspace too (no leaked hold anywhere)", wsDisposed === 2);
  await harness.close();
  faux.unregister();
}

async function concurrentResumeSharesOneOpen(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const created = await harness.createSession();
  const id = created.id;
  await created.close();
  const [a, b] = await Promise.all([harness.resumeSession(id), harness.resumeSession(id)]);
  check("concurrent resume: both callers receive the same instance", a === b);
  check("concurrent resume: that instance is the registered one", harness.getSession(id) === a);
  await a.close();
  check("concurrent resume: closing it unregisters it", harness.getSession(id) === undefined);

  // Resume while the previous instance is closing: wait for the close, then open a fresh one.
  const again = await harness.resumeSession(id);
  let closeSettled = false;
  const closing = again.close().then(() => { closeSettled = true; });
  const reopenedP = harness.resumeSession(id);
  let sawCloseFirst = false;
  const reopened = await reopenedP.then((session) => { sawCloseFirst = closeSettled; return session; });
  await closing;
  check("resume during close: a fresh instance is returned, not the closing one", reopened !== again);
  check("resume during close: the reopen waited for the old close to finish", sawCloseFirst);
  check("resume during close: the fresh instance is the registered one", harness.getSession(id) === reopened);
  await again.close(); // a repeat close of the OLD instance must not touch the new registration
  check("resume during close: re-closing the old instance leaves the new registration alone", harness.getSession(id) === reopened);
  await reopened.close();
  check("resume during close: closing the new instance unregisters it", harness.getSession(id) === undefined);
  await harness.close();
  faux.unregister();
}

async function harnessCloseDuringOpen(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const faux = registerFauxProvider();
  let releaseHook!: () => void;
  const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
  let slow = false;
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    session: async (scope) => {
      if (slow) await hookGate;
      return defaultCapabilities({ scope });
    },
  });
  const created = await harness.createSession();
  const id = created.id;
  await created.close();
  slow = true;
  const reopening = harness.resumeSession(id);
  await sleep(20);
  const closing = harness.close();
  check("harness close during open: close() waits for the in-flight open", await pendingAfter(closing, 40));
  releaseHook();
  const outcome = await reopening.then((session) => ({ ok: true, state: session.status.state }), (error: Error) => ({ ok: false, message: error.message }));
  await closing;
  check("harness close during open: the open completed (its scope was not closed under it)", outcome.ok);
  check("harness close during open: the reopened session ends up closed by the harness", outcome.ok && harness.getSession(id) === undefined);
  await sleep(20);
  process.off("unhandledRejection", onUnhandled);
  check("harness close during open: no unhandled rejection", unhandled.length === 0);
  faux.unregister();
}

async function cancelRightAfterPrompt(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  let started = 0;
  session.onEvent((event) => { if (event.type === "agent.started") started += 1; });
  faux.setResponses([fauxAssistantMessage("should not run", { stopReason: "stop" }), fauxAssistantMessage("should not run", { stopReason: "stop" })]);

  const cancelled = session.prompt("cancel me at once");
  check("prompt+cancel: the run is registered synchronously by prompt()", session.status.state === "running");
  session.cancel();
  let cancelledError: unknown;
  await cancelled.catch((error) => { cancelledError = error; });
  check("prompt+cancel: the run is rejected as aborted", cancelledError instanceof Error && cancelledError.name === "AbortError");
  check("prompt+cancel: the model was never called (no agent.started)", started === 0);

  const closedRun = session.prompt("close me at once");
  const closing = session.close();
  let closedError: unknown;
  await closedRun.catch((error) => { closedError = error; });
  await closing;
  check("prompt+close: the run is rejected as aborted", closedError instanceof Error && closedError.name === "AbortError");
  check("prompt+close: the model was never called", started === 0);
  await harness.close();
  faux.unregister();
}

async function createRacesResume(): Promise<void> {
  const faux = registerFauxProvider();
  let releaseHook!: () => void;
  const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
  let slow = true;
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    session: async (scope) => {
      if (slow) { slow = false; await hookGate; }
      return defaultCapabilities({ scope });
    },
  });
  const creating = harness.createSession({ id: "race-create" });
  await sleep(20);
  const resuming = harness.resumeSession("race-create");
  check("create vs resume: the resume waits for the in-flight create", await pendingAfter(resuming, 40));
  releaseHook();
  const [created, resumed] = await Promise.all([creating, resuming]);
  check("create vs resume: both receive the same instance (one store, one run lock)", created === resumed);
  check("create vs resume: it is the registered one", harness.getSession("race-create") === created);
  await harness.close();
  faux.unregister();
}

async function streamSettlesQueuedInput(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  let started = 0;
  session.onEvent((event) => {
    if (event.type === "agent.started") started += 1;
    // A background notification landing exactly as the run ends: after its last drain.
    if (event.type === "agent.ended" && started === 1) {
      session.steerTo("main", "late notification", { kind: "external", source: "bg", deliveryId: "bg_1", channel: "follow_up" });
    }
  });
  faux.setResponses([fauxAssistantMessage("streamed", { stopReason: "stop" }), fauxAssistantMessage("woke", { stopReason: "stop" })]);
  const handle = session.promptStream("stream me");
  for await (const _event of handle) { /* drain */ }
  await handle.completed;
  await sleep(60);
  check("stream idle-wake: the input queued at agent.ended started a follow-up turn", started === 2);
  check("stream idle-wake: nothing is left queued", session.status.hasQueuedMessages === false && session.status.state === "idle");
  await harness.close();
  faux.unregister();
}

async function concurrentStreamsStayApart(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  faux.setResponses([fauxAssistantMessage("answer one", { stopReason: "stop" }), fauxAssistantMessage("answer two", { stopReason: "stop" })]);
  const first = session.promptStream("prompt one");
  const second = session.promptStream("prompt two");
  // Only the journal-shaped events count: `model.request` legitimately carries the whole
  // conversation (the first run IS the second run's history), so it is excluded.
  const appended = async (handle: AsyncIterable<{ type: string }>): Promise<string[]> => {
    const out: string[] = [];
    for await (const event of handle) {
      if (event.type === "message.appended" || event.type === "agent.started" || event.type === "turn.started") out.push(JSON.stringify(event));
    }
    return out;
  };
  const [firstEvents, secondEvents] = await Promise.all([appended(first), appended(second)]);
  await Promise.all([first.completed, second.completed]);
  const firstText = firstEvents.join("\n");
  const secondText = secondEvents.join("\n");
  check("concurrent streams: the first stream carries its own prompt and answer", firstText.includes("prompt one") && firstText.includes("answer one"));
  check("concurrent streams: the first stream carries nothing of the second run", !firstText.includes("prompt two") && !firstText.includes("answer two"));
  check("concurrent streams: the second stream carries its own prompt and answer", secondText.includes("prompt two") && secondText.includes("answer two"));
  check("concurrent streams: the second stream does NOT replay the first run's prompt or answer", !secondText.includes("prompt one") && !secondText.includes("answer one"));
  check("concurrent streams: each stream sees exactly one agent.started", firstEvents.filter((e) => e.includes('"agent.started"')).length === 1 && secondEvents.filter((e) => e.includes('"agent.started"')).length === 1);
  if (secondText.includes("prompt one") || secondText.includes("answer one")) {
    console.log("  offending:", secondEvents.filter((e) => e.includes("prompt one") || e.includes("answer one")).map((e) => e.slice(0, 160)));
  }
  await harness.close();
  faux.unregister();
}

async function main(): Promise<void> {
  await cancelRightAfterPrompt();
  await createRacesResume();
  await streamSettlesQueuedInput();
  await concurrentStreamsStayApart();
  await openFailureRollsBack();
  await concurrentResumeSharesOneOpen();
  await harnessCloseDuringOpen();
  await cancelCoversQueuedRuns();
  await closedChecksOnEveryEntry();
  await closeWaitsForRuns();
  await closeGivesUpOnStuckRun();
  await barrierWaitersFailOnClose();
  await idleCloseIsQuiet();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
