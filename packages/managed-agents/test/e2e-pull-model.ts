/**
 * The pull model end to end: the API persists what is sent, a started worker pulls it, and
 * nothing connects the two but the work table — not even here, where both run in one process.
 *
 *  - create without events provisions nothing; with `initial_events` it runs
 *  - a message sent while a turn runs is pulled mid-turn and steered into it
 *  - `user.interrupt` stops a run; a message after it starts the next turn
 *  - a paused tool call is answered with `user.tool_confirmation`, by any worker
 *  - a message a previous holder already put in the conversation is not delivered twice
 *  - the HTTP API + client: `run()`, history, delete
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, LocalEnvironment } from "operon-agents";
import { DiskSessionRepository } from "operon-agents/advanced";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxResponseStep } from "./faux.ts";
import { ManagedAgentsClient } from "../src/client/client.ts";
import { run } from "../src/client/run.ts";
import type { ManagedEventResource } from "../src/protocol/types.ts";
import { MemoryEventBroadcaster } from "../src/server/broadcast.ts";
import { allowAllRequests, createManagedHttpServer } from "../src/server/http-server.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function waitFor<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 5_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

function fixture(name: string, options: { readonly permission?: "yolo" | "manual"; readonly start?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const faux = registerFauxProvider();
  const repository = new DiskSessionRepository(join(root, "sessions"));
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir }) };
  const work = new MemorySessionWork({ ttlMs: 2_000 });
  const broadcaster = new MemoryEventBroadcaster();
  const service = new SessionService({ work, metadataStore, broadcaster });
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(workDir) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: options.permission ?? "yolo" } } }
  });
  const worker = new SessionWorker({
    profile: "single-tenant",
    harness,
    repository,
    metadataStore,
    environments,
    work,
    broadcaster,
    inputPollIntervalMs: 30,
    claimIntervalMs: 20,
    renewIntervalMs: 200,
    onError: () => undefined,
  });
  if (options.start !== false) worker.start();
  const history = async (id: string): Promise<readonly ManagedEventResource[]> => (await service.listEvents(id, { limit: 1000 })).data;
  const idleCount = async (id: string): Promise<number> => (await history(id)).filter((e) => e.type === "session.status_idle").length;
  return {
    root, workDir, faux, repository, metadataStore, work, broadcaster, service, harness, worker, history, idleCount,
    async close(): Promise<void> {
      await worker.stop();
      faux.unregister();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const text = (value: string) => ({ type: "user.message" as const, content: [{ type: "text" as const, text: value }] });
const lastUserText = (context: { readonly messages: readonly { readonly role: string; readonly content: unknown }[] }): string => {
  const users = context.messages.filter((m) => m.role === "user");
  const content = users.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
};

async function createAndRun(): Promise<void> {
  const f = fixture("pull-create");
  f.faux.setResponses([fauxAssistantMessage("first answer", { stopReason: "stop" })]);

  const empty = await f.service.create({ agent: "default", environment_id: "default" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  check("create without events: idle", (await f.service.retrieve(empty.id)).status === "idle");
  check("create without events: no runtime session was made", (await f.repository.get(empty.id)) === undefined);
  check("create without events: empty history", (await f.history(empty.id)).length === 0);

  const session = await f.service.create({ agent: "default", environment_id: "default", initial_events: [text("hello")] });
  const done = await waitFor(async () => (await f.idleCount(session.id)) > 0);
  const events = await f.history(session.id);
  const types = events.map((e) => e.type);
  check("initial_events ran a turn", done === true);
  check("history: message, running, model request, agent.message, idle — in order",
    JSON.stringify(types) === JSON.stringify(["user.message", "session.status_running", "span.model_request_start", "agent.message", "span.model_request_end", "session.status_idle"]));
  check("the sent message is marked processed", events[0]?.processed_at !== null);
  check("the runtime session was created by the worker", (await f.repository.get(session.id)) !== undefined);
  check("the session reads idle again", (await waitFor(async () => (await f.service.retrieve(session.id)).status === "idle")) === true);
  await f.close();
}

async function steerMidTurn(): Promise<void> {
  const f = fixture("pull-steer");
  const hold = gate();
  const contexts: string[] = [];
  const slow: FauxResponseStep = async (context) => {
    contexts.push(lastUserText(context));
    await hold.wait;
    return fauxAssistantMessage("working", { stopReason: "stop" });
  };
  const second: FauxResponseStep = async (context) => {
    contexts.push(lastUserText(context));
    return fauxAssistantMessage("took the steer", { stopReason: "stop" });
  };
  f.faux.setResponses([slow, second]);
  const session = await f.service.create({ agent: "default", environment_id: "default", initial_events: [text("start")] });
  await waitFor(async () => (await f.history(session.id)).some((e) => e.type === "session.status_running"));
  const [steer] = (await f.service.sendEvents(session.id, { events: [text("also do this")] })).data;
  // The worker pulls on its own schedule; the message is on the Harness's queue before the turn ends.
  const pulled = await waitFor(async () => (await f.repository.open(session.id).then(async (h) => {
    const page = await h!.store.readRecordPage({ limit: 200 });
    await h!.store.close?.();
    return page.data.some((r) => JSON.stringify(r.record).includes(steer!.id));
  })));
  check("steer: pulled into the running session without anyone notifying the worker", pulled === true);
  hold.open();
  await waitFor(async () => (await f.history(session.id)).find((e) => e.id === steer!.id)?.processed_at != null);
  await waitFor(async () => (await f.service.retrieve(session.id)).status === "idle");
  const events = await f.history(session.id);
  check("steer: the next model call saw it", contexts[1]?.includes("also do this") === true);
  check("steer: taken within the running turn (one idle)", events.filter((e) => e.type === "session.status_idle").length === 1);
  check("steer: processed", events.find((e) => e.id === steer!.id)?.processed_at !== null);
  await f.close();
}

async function interrupt(): Promise<void> {
  const f = fixture("pull-interrupt");
  const hang: FauxResponseStep = (_context, options) => new Promise((resolve) => {
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("aborted", { stopReason: "aborted" })), { once: true });
  });
  f.faux.setResponses([hang, fauxAssistantMessage("after the interrupt", { stopReason: "stop" })]);
  const session = await f.service.create({ agent: "default", environment_id: "default", initial_events: [text("long job")] });
  await waitFor(async () => (await f.history(session.id)).some((e) => e.type === "session.status_running"));
  const [stop] = (await f.service.sendEvents(session.id, { events: [{ type: "user.interrupt" }] })).data;
  const stopped = await waitFor(async () => (await f.history(session.id)).find((e) => e.id === stop!.id)?.processed_at != null);
  check("interrupt: processed", stopped === true);
  check("interrupt: the turn ended idle", (await f.idleCount(session.id)) === 1);
  await f.service.sendEvents(session.id, { events: [text("next")] });
  await waitFor(async () => (await f.idleCount(session.id)) === 2);
  const messages = (await f.history(session.id)).filter((e) => e.type === "agent.message");
  check("interrupt: a later message starts the next turn",
    messages.some((e) => e.type === "agent.message" && e.content[0]?.text === "after the interrupt"));
  await f.close();
}

async function toolConfirmation(): Promise<void> {
  const f = fixture("pull-confirm", { permission: "manual" });
  const file = join(f.root, "work", "out.txt");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "ok\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("wrote it", { stopReason: "stop" }),
  ]);
  const session = await f.service.create({ agent: "default", environment_id: "default", initial_events: [text("write the file")] });
  const paused = await waitFor(async () => (await f.history(session.id)).find((e) =>
    e.type === "session.status_idle" && e.stop_reason.type === "requires_action"));
  const blocking = paused?.type === "session.status_idle" && paused.stop_reason.type === "requires_action" ? paused.stop_reason.event_ids : [];
  const toolUse = (await f.history(session.id)).find((e) => e.id === blocking[0]);
  check("confirm: paused with requires_action naming an agent.tool_use", toolUse?.type === "agent.tool_use" && toolUse.name === "Write");
  check("confirm: a paused session reads idle", (await waitFor(async () => (await f.service.retrieve(session.id)).status === "idle")) === true);
  // A message sent while paused waits for the answer instead of failing the session.
  const [held] = (await f.service.sendEvents(session.id, { events: [text("and then?")] })).data;
  f.faux.appendResponses([fauxAssistantMessage("then this", { stopReason: "stop" })]);
  await f.service.sendEvents(session.id, { events: [{ type: "user.tool_confirmation", tool_use_id: blocking[0]!, result: "allow" }] });
  const finished = await waitFor(async () => (await f.history(session.id)).find((e) => e.id === held!.id)?.processed_at != null, 8_000);
  await waitFor(async () => (await f.service.retrieve(session.id)).status === "idle");
  let written = "";
  try { written = readFileSync(file, "utf8"); } catch { /* checked below */ }
  const events = await f.history(session.id);
  check("confirm: the approved call ran", written === "ok\n");
  check("confirm: its result references the blocking tool_use", events.some((e) => e.type === "agent.tool_result" && e.tool_use_id === blocking[0]));
  check("confirm: the held message went in after the answer", finished === true);
  await f.close();
}

/** A question the agent asked is answered with `user.custom_tool_result`: text, keyed per question. */
async function customToolResult(): Promise<void> {
  // Not yolo: there AskUserQuestion is refused outright instead of asking.
  const f = fixture("pull-question", { permission: "manual" });
  const question = "Which greeting should it use?";
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("AskUserQuestion", { questions: [{ question, header: "Greeting", options: [{ label: "Hello" }, { label: "Hi" }] }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("going with hi", { stopReason: "stop" }),
  ]);
  const session = await f.service.create({ agent: "default", environment_id: "default", initial_events: [text("greet")] });
  const paused = await waitFor(async () => (await f.history(session.id)).find((e) =>
    e.type === "session.status_idle" && e.stop_reason.type === "requires_action"));
  const blocking = paused?.type === "session.status_idle" && paused.stop_reason.type === "requires_action" ? paused.stop_reason.event_ids : [];
  const asked = (await f.history(session.id)).find((e) => e.id === blocking[0]);
  check("question: paused on an agent.custom_tool_use", asked?.type === "agent.custom_tool_use" && asked.name === "AskUserQuestion");
  await f.service.sendEvents(session.id, {
    events: [{ type: "user.custom_tool_result", custom_tool_use_id: blocking[0]!, content: [{ type: "text", text: "hi, short and friendly" }] }],
  });
  const result = await waitFor(async () => (await f.history(session.id)).find((e) => e.type === "agent.tool_result" && e.tool_use_id === blocking[0]), 8_000);
  const answer = result?.type === "agent.tool_result" ? JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}") as { answers?: Record<string, string> } : {};
  check("question: the text answered the question it was asked under", answer.answers?.[question] === "hi, short and friendly");
  check("question: the turn continued to its end",
    (await waitFor(async () => (await f.history(session.id)).some((e) => e.type === "agent.message" && e.content[0]?.text === "going with hi"))) === true);
  await f.close();
}

/** The worker that paused is gone; a different one, with its own harness, takes the answer. */
async function anotherWorkerAnswers(): Promise<void> {
  const f = fixture("pull-handover", { permission: "manual" });
  const file = join(f.workDir, "handover.txt");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "ok\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done elsewhere", { stopReason: "stop" }),
  ]);
  const session = await f.service.create({ agent: "default", environment_id: "default", initial_events: [text("write it")] });
  const paused = await waitFor(async () => (await f.history(session.id)).find((e) => e.type === "session.status_idle" && e.stop_reason.type === "requires_action"));
  await f.worker.stop();
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: f.repository, environment: new LocalEnvironment(f.workDir) }),
    ...f.faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...f.faux.harnessModel().config.defaults, permission: { mode: "manual" } } }
  });
  const other = new SessionWorker({
    profile: "single-tenant", harness, repository: f.repository, metadataStore: f.metadataStore,
    environments: { resolve: () => ({ workDir: f.workDir }) }, work: f.work, broadcaster: f.broadcaster,
    inputPollIntervalMs: 30, claimIntervalMs: 20, onError: () => undefined,
  });
  other.start();
  const blocking = paused?.type === "session.status_idle" && paused.stop_reason.type === "requires_action" ? paused.stop_reason.event_ids[0]! : "";
  await f.service.sendEvents(session.id, { events: [{ type: "user.tool_confirmation", tool_use_id: blocking, result: "allow" }] });
  const done = await waitFor(async () => (await f.history(session.id)).some((e) => e.type === "agent.message" && e.content[0]?.text === "done elsewhere"), 8_000);
  let written = "";
  try { written = readFileSync(file, "utf8"); } catch { /* checked */ }
  check("handover: a worker that never saw the pause answers it", done === true && written === "ok\n");
  await other.stop();
  f.faux.unregister();
  rmSync(f.root, { recursive: true, force: true });
}

async function recoveryDoesNotRedeliver(): Promise<void> {
  const f = fixture("pull-recover", { start: false });
  let calls = 0;
  f.faux.setResponses([
    async () => { calls += 1; return fauxAssistantMessage("answered by the old holder", { stopReason: "stop" }); },
    async () => { calls += 1; return fauxAssistantMessage("should not run", { stopReason: "stop" }); },
  ]);
  const session = await f.service.create({ agent: "default", environment_id: "default" });
  const [message] = (await f.service.sendEvents(session.id, { events: [text("only once")] })).data;
  // A previous holder put it in the conversation and finished the turn, then died before
  // marking it processed.
  const old = await f.harness.createSession({ id: session.id, workDir: f.workDir });
  await old.steerTo("main", "only once", { kind: "user" }, { id: message!.id }).journaled;
  await old.whenIdle();
  await old.close();
  f.worker.start();
  const processed = await waitFor(async () => (await f.history(session.id)).find((e) => e.id === message!.id)?.processed_at != null);
  await waitFor(async () => !(await f.work.peek(session.id)));
  check("recover: the message is marked processed", processed === true);
  check("recover: the agent was not asked twice", calls === 1);
  const handle = await f.repository.open(session.id);
  const page = await handle!.store.readRecordPage({ limit: 500 });
  await handle!.store.close?.();
  const appended = page.data.filter((r) => {
    const record = r.record as { type: string; origin?: { steerId?: string } };
    return record.origin?.steerId === message!.id && record.type !== "event.lifecycle";
  }).length;
  check("recover: the conversation holds it once", appended === 1);
  await f.close();
}

async function overHttp(): Promise<void> {
  const f = fixture("pull-http");
  f.faux.setResponses([
    fauxAssistantMessage("first answer", { stopReason: "stop" }),
    fauxAssistantMessage("second answer", { stopReason: "stop" }),
  ]);
  const http = createManagedHttpServer({ service: f.service, authorize: allowAllRequests });
  await http.listen(0, "127.0.0.1");
  const address = http.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const client = new ManagedAgentsClient({ baseUrl: `http://127.0.0.1:${String(port)}/v1` });
  try {
    const session = await client.sessions.create({ agent: "default", environment_id: "default", title: "over http" });
    check("http: created a session resource", session.type === "session" && session.title === "over http" && session.status === "idle");
    const first = await run(client, session.id, "question one", { timeoutMs: 8_000 });
    check("http: run() returned the agent's answer", first.output === "first answer");
    const second = await run(client, session.id, "question two", { timeoutMs: 8_000 });
    check("http: a second run is not fooled by the first turn's idle", second.output === "second answer");
    const history = await client.sessions.events.list(session.id, { limit: 3 });
    check("http: history pages", history.data.length === 3 && history.next_page !== null);
    const next = await client.sessions.events.list(session.id, { limit: 100, page: history.next_page! });
    check("http: the next page continues it", next.data[0]?.id !== history.data.at(-1)?.id && next.next_page === null);
    const renamed = await client.sessions.update(session.id, { title: "renamed" });
    check("http: update", renamed.title === "renamed");
    const listed = await client.sessions.list();
    check("http: list", listed.data.some((s) => s.id === session.id));
    await client.sessions.delete(session.id);
    let gone = false;
    try { await client.sessions.retrieve(session.id); } catch (error) { gone = (error as { status?: number }).status === 404; }
    check("http: deleted sessions are gone", gone);
    const cleaned = await waitFor(async () => (await f.metadataStore.get(session.id)) === undefined);
    check("http: the worker removed the runtime session and the tombstone", cleaned === true && (await f.repository.get(session.id))?.deletedAt !== undefined);
  } finally {
    await http.close();
    await f.close();
  }
}

async function main(): Promise<void> {
  await createAndRun();
  await steerMidTurn();
  await interrupt();
  await toolConfirmation();
  await customToolResult();
  await anotherWorkerAnswers();
  await recoveryDoesNotRedeliver();
  await overHttp();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ PULL MODEL E2E PASS");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
