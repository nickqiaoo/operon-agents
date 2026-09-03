import { T } from "operon-agents-core";
/**
 * Idle wake: a follow-up that lands while NO turn is running still gets consumed.
 *
 * The gap this covers: the run loop's turn-boundary drain only exists while a run is in flight,
 * so a background task settling AFTER its spawning turn ended — the normal case, since spawning
 * to the background is precisely how a turn stops waiting — used to leave its result sitting in
 * the queue until the user happened to prompt again.
 */
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import { AgentBackgroundTask, type AgentEvent } from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function turnsStarted(events: readonly AgentEvent[]): number {
  return events.filter((event) => event.type === "turn.started").length;
}

/** The headline case: a background agent that finishes minutes after its spawning turn ended. */
async function backgroundSettleWakesIdleSession(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("started the helper", { stopReason: "stop" }),
    fauxAssistantMessage("acknowledged the helper's result", { stopReason: "stop" }),
  ]);
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  const manager = session.core.require(T.Background);
  const settle = Promise.withResolvers<{ agentStatus: string }>();
  manager.registerTask(new AgentBackgroundTask(settle.promise, "delayed helper", { agentId: "helper-1", address: "main/helper-1" }));

  await session.prompt("kick off some background work");
  check("wake: session is idle once its own turn ends", session.status.state === "idle");
  check("wake: exactly one turn so far", turnsStarted(events) === 1);

  // The task settles with nobody running — before this fix, nothing would ever drain it.
  settle.resolve({ agentStatus: "completed" });

  const woke = await waitFor(() => events.some((event) => event.type === "turn.ended" && turnsStarted(events) === 2));
  check("wake: the settle started a second turn on its own", woke);

  const appended = events.find(
    (event) => event.type === "message.appended" && event.origin?.kind === "background_task",
  );
  check(
    "wake: the settle entered the conversation with its structured origin",
    appended?.type === "message.appended" && appended.origin?.kind === "background_task",
  );
  check(
    "wake: the journaled origin carries the enqueue correlation id",
    appended?.type === "message.appended" && typeof appended.origin?.steerId === "string",
  );
  const text = appended?.type === "message.appended"
    ? appended.message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : "";
  check("wake: the model sees the rendered settle tag", text.includes("<background-task-done") && text.includes("delayed helper completed"));
  // The settle is a notice, not a delivery: the sub-agent's own result ("helper finished its
  // work") stays in the task's output for `BackgroundOutput` to serve, so waking the session
  // costs the same few bytes whether the helper returned a word or a megabyte.
  check("wake: the notice does not carry the helper's result", !text.includes("helper finished its work"));
  check("wake: it names the read that would fetch it", text.includes("BackgroundOutput(task_id="));
  check("wake: the woken turn actually ran the model", events.some((event) => event.type === "turn.ended" && turnsStarted(events) >= 2));

  await session.close();
  faux.unregister();
}

/** Several settles landing together must fold into ONE turn, not one turn each. */
async function concurrentSettlesFoldIntoOneTurn(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("started both", { stopReason: "stop" }),
    fauxAssistantMessage("saw both results", { stopReason: "stop" }),
  ]);
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  await session.prompt("kick off two things");

  // Both enqueue in the same synchronous stack: the wake must coalesce.
  session.core.steer.steer("first is done", { kind: "background_done", taskId: "task-a" });
  session.core.steer.steer("second is done", { kind: "background_done", taskId: "task-b" });

  const woke = await waitFor(() => turnsStarted(events) === 2 && events.some((event) => event.type === "turn.ended" && turnsStarted(events) === 2));
  check("fold: two settles produced exactly one extra turn", woke && turnsStarted(events) === 2);

  const settleMessages = events.filter(
    (event) => event.type === "message.appended" && event.origin?.kind === "background_task",
  );
  check("fold: both settles reached the conversation", settleMessages.length === 2);
  check("fold: the queue is empty afterwards", !session.core.steer.hasItems());

  await session.close();
  faux.unregister();
}

/** A settle during a live run is the run's own business — it must not spawn a competing turn. */
async function settleDuringRunUsesBoundaryDrain(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("working", { stopReason: "stop" }),
    fauxAssistantMessage("saw the mid-run settle", { stopReason: "stop" }),
  ]);
  let gateEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { gateEntered = resolve; });
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let gateActive = false;

  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [{
      id: "run-gate",
      setup(api) {
        api.on("model.request", async () => {
          if (!gateActive) return;
          gateActive = false;
          gateEntered?.();
          await released;
        });
      },
    }],
  });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  gateActive = true;
  const running = session.prompt("long turn");
  await entered;
  // Lands mid-run: the run's own turn-boundary drain owns it.
  session.core.steer.steer("done while you were busy", { kind: "background_done", taskId: "task-c" });
  release?.();
  await running;

  await waitFor(() => session.status.state === "idle" && !session.core.steer.hasItems());
  check("mid-run: the settle was consumed by the run itself", turnsStarted(events) === 2);
  check("mid-run: nothing was left queued", !session.core.steer.hasItems());

  await session.close();
  faux.unregister();
}

/** `steerTo` on an idle session now goes through the bus, so its record carries a `steerId`. */
async function steerToIdleGoesThroughTheBus(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first", { stopReason: "stop" }),
    fauxAssistantMessage("answered the peer", { stopReason: "stop" }),
  ]);
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  await session.prompt("hello");
  const accepted = session.steerTo("main", "a teammate needs your input", {
    kind: "external",
    source: "peer",
    deliveryId: "pm_1",
    actor: "agent-b",
    channel: "follow_up",
  });
  check("steerTo: accepted while idle", accepted);

  const woke = await waitFor(() => turnsStarted(events) === 2);
  check("steerTo: idle target woke on its own", woke);

  const appended = events.find(
    (event) => event.type === "message.appended" && event.origin?.kind === "external" && event.origin.deliveryId === "pm_1",
  );
  check(
    "steerTo: provenance survived onto the journal record",
    appended?.type === "message.appended" && appended.origin?.kind === "external" && appended.origin.actor === "agent-b",
  );
  check(
    "steerTo: the record now carries a steerId (it went through the bus)",
    appended?.type === "message.appended" && typeof appended.origin?.steerId === "string",
  );
  check(
    "steerTo: a subagent frame that is not running stays unreachable",
    session.steerTo("main/nobody", "hi", { kind: "external", source: "peer", deliveryId: "pm_2", channel: "follow_up" }) === false,
  );

  await session.close();
  faux.unregister();
}

async function main(): Promise<void> {
  await backgroundSettleWakesIdleSession();
  await concurrentSettlesFoldIntoOneTurn();
  await settleDuringRunUsesBoundaryDrain();
  await steerToIdleGoesThroughTheBus();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

await main();
