/**
 * The settle-notification ledger: a background result that was queued but never reached the
 * conversation is redelivered on reopen.
 *
 * `steer` only puts the settle on an in-memory queue, so a crash between the enqueue and the
 * recipient consuming it loses the notification while the task record survives as `completed`.
 * The task itself is not lost — its status and output were persisted — but the model would
 * never learn it finished. Two stamps on the persisted record (queued / confirmed) make that
 * window recoverable, on the same terms peer delivery uses: settle the ledger on CONSUMPTION,
 * never on hand-off.
 *
 * Crash timing is planted rather than reproduced — the same choice `agents-peers` made in its
 * reconcile test, and for the same reason: a live run drains its own queue before it ends, so
 * the window cannot be hit on purpose without faking the clock anyway. What is asserted is the
 * semantics of the ledger, not a race.
 */
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import {
  AgentBackgroundTask,
  MemorySessionRepository,
  StoreBackgroundTaskPersistence,
  type AgentEvent,
  type PersistedTask,
  type SessionStore,
} from "operon-agents-core";

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

function settleMessages(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type === "message.appended" && event.origin?.kind === "background_task");
}

async function storeOf(repo: MemorySessionRepository, id: string): Promise<SessionStore> {
  const handle = await repo.open(id);
  if (handle === undefined) throw new Error(`session ${id} not found in repository`);
  return handle.store;
}

async function readTask(store: SessionStore, taskId: string): Promise<PersistedTask | undefined> {
  return await new StoreBackgroundTaskPersistence(store).readTask(taskId);
}

/** A settle consumed normally must close its ledger entry, so reopening resends nothing. */
async function confirmedSettleIsNotRedelivered(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("started", { stopReason: "stop" }),
    fauxAssistantMessage("noted the result", { stopReason: "stop" }),
    fauxAssistantMessage("nothing new", { stopReason: "stop" }),
  ]);
  const repo = new MemorySessionRepository();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, repository: repo });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  const settle = Promise.withResolvers<{ agentStatus: string }>();
  const taskId = session.core.backgroundManager!.registerTask(
    new AgentBackgroundTask(settle.promise, "confirmed helper", { agentId: "helper-ok", address: "main/helper-ok" }),
  );

  await session.prompt("start it");
  settle.resolve({ agentStatus: "completed" });
  await waitFor(() => settleMessages(events).length === 1);
  check("confirmed: the settle reached the conversation", settleMessages(events).length === 1);

  const persisted = await waitFor(async () => true).then(() => storeOf(repo, session.id)).then((s) => readTask(s, taskId));
  check("confirmed: the ledger records both stamps", persisted?.notificationQueuedAt !== undefined && persisted?.notifiedAt !== undefined);

  await session.close();

  const reopened = await harness.resumeSession(session.id);
  const afterEvents: AgentEvent[] = [];
  reopened.onEvent((event) => afterEvents.push(event));
  await reopened.reconcileSubagents();
  await waitFor(() => settleMessages(afterEvents).length > 0, 300);
  check("confirmed: reopening resends nothing", settleMessages(afterEvents).length === 0);

  await reopened.close();
  faux.unregister();
}

/** Queued but never confirmed = lost in the crash window ⇒ resend, and the resend wakes the session. */
async function unconfirmedSettleIsRedelivered(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("started", { stopReason: "stop" }),
    fauxAssistantMessage("acted on the recovered result", { stopReason: "stop" }),
  ]);
  const repo = new MemorySessionRepository();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, repository: repo });
  const session = await harness.createSession();
  await session.prompt("start it");
  const sessionId = session.id;
  await session.close();

  // Plant the crash: terminal work whose notification was queued and never consumed.
  const store = await storeOf(repo, sessionId);
  await store.appendRecord({
    address: "main/helper-crashed",
    type: "context.append_message",
    message: { role: "assistant", content: [{ type: "text", text: "recovered helper result" }] },
  });
  await new StoreBackgroundTaskPersistence(store).writeTask({
    schemaVersion: 2,
    revision: 1,
    taskId: "agent_lost_notice",
    kind: "agent",
    status: "completed",
    description: "helper whose result never landed",
    startedAt: 1,
    endedAt: 2,
    agentId: "helper-crashed",
    outputRef: { kind: "conversation", address: "main/helper-crashed" },
    notificationQueuedAt: 3,
  } satisfies PersistedTask);

  const reopened = await harness.resumeSession(sessionId);
  const events: AgentEvent[] = [];
  reopened.onEvent((event) => events.push(event));
  await reopened.reconcileSubagents();

  const resent = await waitFor(() => settleMessages(events).length === 1);
  check("unconfirmed: the settle was redelivered on reopen", resent);

  const appended = settleMessages(events)[0];
  const text = appended?.type === "message.appended"
    ? appended.message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : "";
  check("unconfirmed: the redelivery names the task", text.includes("helper whose result never landed"));
  check("unconfirmed: it says the durable output survived", text.includes("durable output is still available"));
  check("unconfirmed: it names the read that reaches the shard", text.includes("BackgroundOutput(task_id="));
  check(
    "unconfirmed: the named read returns the recovered result",
    (await reopened.core.backgroundManager!.readOutput("agent_lost_notice")).content === "recovered helper result",
  );
  check("unconfirmed: the redelivery woke the idle session on its own", await waitFor(() => events.some((e) => e.type === "turn.ended")));

  const ledger = await readTask(await storeOf(repo, sessionId), "agent_lost_notice");
  check("unconfirmed: the ledger is closed after consumption", ledger?.notifiedAt !== undefined);

  await reopened.close();

  // And it must not loop: a second reopen has nothing left to resend.
  const twice = await harness.resumeSession(sessionId);
  const againEvents: AgentEvent[] = [];
  twice.onEvent((event) => againEvents.push(event));
  await twice.reconcileSubagents();
  await waitFor(() => settleMessages(againEvents).length > 0, 300);
  check("unconfirmed: a second reopen resends nothing", settleMessages(againEvents).length === 0);

  await twice.close();
  faux.unregister();
}

/**
 * The converse of the agent case above: a command's output was redirected to a log file on the
 * machine, so it outlived the process that queued the notification. Here the resend SHOULD name
 * a read — the bytes are still there — and carry the exit code the settle recorded.
 */
async function unconfirmedProcessSettlePointsAtItsLog(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("started", { stopReason: "stop" }),
    fauxAssistantMessage("read the log", { stopReason: "stop" }),
  ]);
  const repo = new MemorySessionRepository();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, repository: repo });
  const session = await harness.createSession();
  await session.prompt("start it");
  const sessionId = session.id;
  await session.close();

  await new StoreBackgroundTaskPersistence(await storeOf(repo, sessionId)).writeTask({
    schemaVersion: 2,
    revision: 1,
    taskId: "bash_survivor",
    kind: "process",
    status: "failed",
    description: "bash: npm test",
    startedAt: 1,
    endedAt: 2,
    command: "npm test",
    exitCode: 3,
    outputRef: { kind: "file", path: "/home/agent/.operon/tasks/bash-abc123.log" },
    notificationQueuedAt: 3,
  } satisfies PersistedTask);

  const reopened = await harness.resumeSession(sessionId);
  const events: AgentEvent[] = [];
  reopened.onEvent((event) => events.push(event));
  await reopened.reconcileSubagents();

  await waitFor(() => settleMessages(events).length === 1);
  const appended = settleMessages(events)[0];
  const text = appended?.type === "message.appended"
    ? appended.message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : "";
  check("process resend: carries the exit code", text.includes("(exit code 3)"));
  check("process resend: names the surviving log file", text.includes("/home/agent/.operon/tasks/bash-abc123.log"));
  check("process resend: points at a read that still works", text.includes("BackgroundOutput(task_id=\"bash_survivor\")"));
  // The whole point of the change: metadata, not a slab of the command's output.
  check("process resend: carries no output tail", !text.includes("npm ERR"));

  await reopened.close();
  faux.unregister();
}

/** Records with neither stamp owe nothing — a suppressed settle, or a pre-ledger record. */
async function unstampedRecordsAreLeftAlone(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("started", { stopReason: "stop" })]);
  const repo = new MemorySessionRepository();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, repository: repo });
  const session = await harness.createSession();
  await session.prompt("start it");
  const sessionId = session.id;
  await session.close();

  const store = await storeOf(repo, sessionId);
  const persistence = new StoreBackgroundTaskPersistence(store);
  // Written the way a pre-upgrade process would have: terminal, no ledger stamps at all.
  await persistence.writeTask({
    schemaVersion: 2,
    revision: 1,
    taskId: "agent_legacy",
    kind: "agent",
    status: "completed",
    description: "work from before the ledger existed",
    startedAt: 1,
    endedAt: 2,
    outputRef: { kind: "conversation", address: "main/agent_legacy" },
  } satisfies PersistedTask);

  const reopened = await harness.resumeSession(sessionId);
  const events: AgentEvent[] = [];
  reopened.onEvent((event) => events.push(event));
  await reopened.reconcileSubagents();
  await waitFor(() => settleMessages(events).length > 0, 300);
  check("unstamped: no stamps ⇒ nothing was owed ⇒ nothing resent", settleMessages(events).length === 0);

  await reopened.close();
  faux.unregister();
}

async function main(): Promise<void> {
  await confirmedSettleIsNotRedelivered();
  await unconfirmedSettleIsRedelivered();
  await unconfirmedProcessSettlePointsAtItsLog();
  await unstampedRecordsAreLeftAlone();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

await main();
