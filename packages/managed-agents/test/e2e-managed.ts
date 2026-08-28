import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  createModelRuntime,
  defineModel,
  DiskSessionRepository,
  SessionProjection,
} from "operon-agents";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import type { SessionSummary } from "operon-agents";
import { ManagedAgentsClient, ManagedApiClientError } from "../src/client/index.ts";
import {
  createManagedHttpServer,
  DiskManagedSessionMetadataStore,
  type ManagedAuthorizationContext,
  ManagedUnauthorizedError,
  SessionService,
  SessionWorker,
  MemorySessionWork,
  StaticEnvironmentRegistry,
} from "../src/server/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Every authorization the server asked for, so a test can see what the hook was told. */
const authorized: ManagedAuthorizationContext[] = [];

function textOf(message: { content: unknown }): string {
  const parts = message.content as ReadonlyArray<{ type: string; text?: string }>;
  return parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function createFauxModel() {
  const provider = fauxProvider();
  const runtime = createModelRuntime({ builtins: false });
  runtime.models.setProvider(provider.provider);
  const descriptor = provider.getModel();
  if (descriptor === undefined) throw new Error("faux model unavailable");
  return {
    provider,
    model: defineModel({ runtime, descriptor }),
    close: () => runtime.models.deleteProvider(provider.provider.id),
  };
}

async function start(
  home: string,
  work: string,
  model: ReturnType<typeof createFauxModel>["model"],
) {
  const repository = new DiskSessionRepository(home);
  const harness = createHarness({
    model,
    repository,
    permission: { mode: "yolo" },
  });
  const sessionWork = new MemorySessionWork({ repository });
  const host = new SessionService({
    repository,
    work: sessionWork,
    metadataStore: new DiskManagedSessionMetadataStore(join(home, "managed")),
    environments: new StaticEnvironmentRegistry({ workspace: { workDir: work } }),
  });
  const worker = new SessionWorker({
    harness,
    repository,
    metadataStore: new DiskManagedSessionMetadataStore(join(home, "managed")),
    environments: new StaticEnvironmentRegistry({ workspace: { workDir: work } }),
    work: sessionWork,
  });
  const managed = createManagedHttpServer({
    service: host,
    worker,
    heartbeatMs: 50,
    authorize: (request, context) => {
      authorized.push(context);
      if (request.headers.authorization !== "Bearer managed-test-key") {
        throw new ManagedUnauthorizedError();
      }
    },
  });
  await managed.listen(0, "127.0.0.1");
  const address = managed.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    managed,
    host,
    harness,
    repository,
    baseUrl,
    client: new ManagedAgentsClient({ baseUrl, apiKey: "managed-test-key" }),
  };
}

async function listAllEvents(
  client: ManagedAgentsClient,
  sessionId: string,
  address?: string,
): Promise<import("operon-agents").AgentEvent[]> {
  const events: import("operon-agents").AgentEvent[] = [];
  let page: string | undefined;
  do {
    const result = await client.sessions.events.list(sessionId, {
      limit: 3,
      ...(page !== undefined ? { page } : {}),
      ...(address !== undefined ? { address } : {}),
    });
    events.push(...result.data);
    page = result.nextPage ?? undefined;
  } while (page !== undefined);
  return events;
}

async function nextEvent(
  iterator: AsyncIterator<import("operon-agents").AgentEvent>,
  type: string,
) {
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error(`stream ended before ${type}`);
    if (next.value.type === type) return next.value;
  }
}

const home = mkdtempSync(join(tmpdir(), "operon-managed-home-"));
const work = mkdtempSync(join(tmpdir(), "operon-managed-work-"));
const faux = createFauxModel();
try {
  faux.provider.setResponses([
    fauxAssistantMessage("first answer", { stopReason: "stop" }),
    fauxAssistantMessage("second answer", { stopReason: "stop" }),
    fauxAssistantMessage("third answer", { stopReason: "stop" }),
  ]);
  let running = await start(home, work, faux.model);
  let unauthorized = false;
  try {
    await new ManagedAgentsClient({ baseUrl: running.baseUrl }).sessions.list();
  } catch (error) {
    unauthorized = error instanceof ManagedApiClientError
      && error.status === 401
      && error.code === "unauthorized";
  }
  check("auth: embedding server can reject missing credentials", unauthorized);

  const session = await running.client.sessions.create({
    title: "managed e2e",
    agent: "default",
    environment: "workspace",
  });
  check("create: stable managed resource", session.agent.id === "default" && session.environment.id === "workspace");

  const renamed = await running.client.sessions.update(session.id, { title: "renamed e2e" });
  check(
    "update: PATCH renames the session over HTTP",
    renamed.title === "renamed e2e" && (await running.client.sessions.retrieve(session.id)).title === "renamed e2e",
  );

  const probeSession = await running.client.sessions.create({
    id: "catalog-list-probe",
    agent: "default",
    environment: "workspace",
  });
  await (await running.harness.resumeSession(probeSession.id)).close();
  const interruptedProbe = {
    id: probeSession.id,
    workDir: work,
    createdAt: probeSession.createdAt,
    updatedAt: Date.now(),
    durableState: "interrupted",
  } satisfies SessionSummary;
  // Listing must be answerable from the catalog alone. Opening a store per row would make the
  // cost of listing scale with how much history each session has, and — before the API stopped
  // reaching through a runtime — could have woken sessions merely to enumerate them.
  const originalList = running.repository.list.bind(running.repository);
  const originalOpen = running.repository.open.bind(running.repository);
  let opens = 0;
  running.repository.list = async () => [interruptedProbe];
  running.repository.open = async (...args) => {
    opens += 1;
    return originalOpen(...args);
  };
  const catalogList = await running.host.list();
  check(
    "sessions.list: consumes catalog summaries without opening any session store",
    catalogList[0]?.state === "interrupted" && opens === 0,
  );
  running.repository.list = originalList;
  running.repository.open = originalOpen;
  await running.client.sessions.delete(probeSession.id);

  const controller = new AbortController();
  const stream = await running.client.sessions.events.stream(session.id, { signal: controller.signal });
  const iterator = stream[Symbol.asyncIterator]();

  const [receipt, duplicate] = await Promise.all([
    running.client.sessions.messages.create(
      session.id,
      { input: "hello" },
      { idempotencyKey: "message-1" },
    ),
    running.client.sessions.messages.create(
      session.id,
      { input: "hello" },
      { idempotencyKey: "message-1" },
    ),
  ]);
  // Always "queued" now: accepting an input and running it are separate, so a receipt cannot
  // claim a turn has started — whoever holds the lease decides that later.
  check("message: returns acceptance receipt", receipt.status === "queued" && receipt.sessionId === session.id);
  check("message: concurrent idempotency key returns the same receipt", duplicate.deliveryId === receipt.deliveryId);
  const liveMessage = await nextEvent(iterator, "message.appended");
  const ended = await nextEvent(iterator, "turn.ended");
  check("stream: prompt events arrive independently", ended.address === "main");
  check(
    "stream: turn.ended carries lifecycle only",
    !("message" in ended) && !("toolResults" in ended),
  );
  // The caller holds this session's credential, so its words are the user's: journaled bare, as
  // a prompt typed into a local session would be — no envelope, no "not from the user" stamp.
  check(
    "message: the caller's own words reach the model bare, as the user",
    liveMessage.type === "message.appended"
      && liveMessage.origin?.kind === "user"
      && liveMessage.origin.deliveryId === receipt.deliveryId
      && textOf(liveMessage.message) === "hello",
  );

  // Relaying someone else's words is declared, and only then does the envelope appear.
  const relayed = await running.client.sessions.messages.create(session.id, {
    input: "the build is red",
    origin: "external",
    source: "ci",
    actor: "ci-bot",
  });
  const relayedMessage = await nextEvent(iterator, "message.appended");
  await nextEvent(iterator, "turn.ended");
  check(
    "message: relayed words reach the model inside the external envelope",
    relayedMessage.type === "message.appended"
      && relayedMessage.origin?.kind === "external"
      && relayedMessage.origin.deliveryId === relayed.deliveryId
      && textOf(relayedMessage.message).startsWith('<external-message source="ci" deliveryId="')
      && textOf(relayedMessage.message).includes('actor="ci-bot"')
      && textOf(relayedMessage.message).includes("NOT a message from the user")
      && textOf(relayedMessage.message).includes("the build is red"),
  );
  check(
    "authorize: is told whose words a delivery claims to be",
    authorized.some((context) => context.action === "messages.create" && context.sessionId === session.id && context.origin === "user")
      && authorized.some((context) => context.action === "messages.create" && context.sessionId === session.id && context.origin === "external"),
  );
  let relayAttributesRefused = false;
  try {
    await running.client.sessions.messages.create(session.id, { input: "x", actor: "someone" });
  } catch (error) {
    relayAttributesRefused = error instanceof ManagedApiClientError && error.status === 400 && error.code === "invalid_request";
  }
  check("message: relay attributes without origin: external are refused", relayAttributesRefused);
  controller.abort();

  // turn.ended is live; the run settles only after its journal flush completes. Historical
  // reads deliberately expose committed store state, not an in-memory pending overlay.
  for (let i = 0; i < 100; i++) {
    if ((await running.client.sessions.retrieve(session.id)).state === "idle") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const history = await listAllEvents(running.client, session.id);
  check("events.list: returns persisted AgentEvents", history.some((event) => event.type === "message.appended"));
  check(
    "events.list: terminal events do not duplicate transcript payloads",
    history.every((event) => event.type !== "agent.ended" || !("messages" in event))
      && history.every((event) => event.type !== "turn.ended" || (!("message" in event) && !("toolResults" in event))),
  );
  check(
    "events.list: persists stateful lifecycle needed to rebuild UI state",
    history.some((event) => event.type === "agent.started")
      && history.some((event) => event.type === "turn.started")
      && history.some((event) => event.type === "turn.ended"),
  );
  check(
    "events.list: cursor pages expose stable non-overlapping event ids",
    new Set(history.map((event) => event.eventId)).size === history.length,
  );
  check(
    "events.list/stream: durable event keeps one identity",
    history.some((event) => event.eventId === liveMessage.eventId),
  );
  check(
    "message: concurrent idempotency key injected one user input",
    history.filter(
      (event) => event.type === "message.appended"
        && event.message.role === "user"
        && event.origin?.kind === "user"
        && event.origin.deliveryId === receipt.deliveryId,
    ).length === 1,
  );

  const mainHistory = await listAllEvents(running.client, session.id, "main");
  check("events.list: address filter is symmetric", mainHistory.length === history.length);

  const rebuilt = new SessionProjection(session.id);
  for (const event of history) rebuilt.apply(event);
  const rebuiltMain = rebuilt.snapshot().agents.find((agent) => agent.address === "main");
  check(
    "events.list: reconstructs settled projection state without a snapshot endpoint",
    rebuiltMain?.messages.some((message) => message.role === "assistant") === true
      && rebuiltMain.turn === undefined
      && rebuiltMain.live === false,
  );

  await (await running.harness.resumeSession(session.id)).close();
  const readonlyHistory = await listAllEvents(running.client, session.id);
  const readonlySession = await running.client.sessions.retrieve(session.id);
  check(
    "read paths: history and resource state do not instantiate HarnessSession",
    readonlyHistory.length === history.length
      && readonlySession.id === session.id
      && running.harness.getSession(session.id) === undefined,
  );

  const reopenedLive = await running.client.sessions.events.stream(session.id);
  const reopenedLiveIterator = reopenedLive[Symbol.asyncIterator]();
  const liveReceipt = await running.client.sessions.messages.create(session.id, { input: "again" });
  // A cold session accepts work the same way a warm one does — acceptance is a write, so there
  // is nothing to reopen before it succeeds. The turn follows once a worker picks it up.
  check("host: reopened session receives work", liveReceipt.status === "queued");
  const liveEnded = await nextEvent(reopenedLiveIterator, "turn.ended");
  check("stream: observes reopened HarnessSession", liveEnded.sessionId === session.id);
  await reopenedLiveIterator.return?.();

  // The stream follows the log, so what it carries is what the log holds. Live-only events
  // (warnings, token deltas) are by definition not there — delivering those is a broadcast
  // channel's job, not the store's. Address filtering is exercised with persisted records.
  const filteredLive = await running.client.sessions.events.stream(session.id, { address: "main/helper" });
  const filteredIterator = filteredLive[Symbol.asyncIterator]();
  const waitForFiltered = filteredIterator.next();
  const filterStore = (await running.repository.open(session.id))!.store;
  await filterStore.appendRecord({
    type: "event.lifecycle",
    eventId: "evt_managed_filter_root",
    time: Date.now(),
    address: "main",
    event: { type: "turn.started", turnId: "filter-root" },
  });
  await filterStore.appendRecord({
    type: "event.lifecycle",
    eventId: "evt_managed_filter_helper",
    time: Date.now(),
    address: "main/helper",
    event: { type: "turn.started", turnId: "filter-helper" },
  });
  const filteredEvent = await waitForFiltered;
  check("events.stream: address filter is symmetric", !filteredEvent.done && filteredEvent.value.address === "main/helper");
  await filteredIterator.return?.();

  await running.managed.close();
  running = await start(home, work, faux.model);
  const reopened = await running.client.sessions.retrieve(session.id);
  check("restart: metadata and conversation reopen by id", reopened.id === session.id && reopened.agent.id === "default");
  const afterRestart = await listAllEvents(running.client, session.id);
  const restartedProjection = new SessionProjection(session.id);
  for (const event of afterRestart) restartedProjection.apply(event);
  check(
    "restart: projection rebuilds from events.list",
    restartedProjection.snapshot().agents.find((agent) => agent.address === "main")?.messages
      .filter((message) => message.role === "assistant").length === 3,
  );

  // A stream open is the managed runtime's cold-open boundary. If the previous process died
  // after durable start events but before terminal lifecycle, recovery appends terminal facts
  // to history; it does not synthesize replay frames onto the new live stream.
  const crashedSession = await running.client.sessions.create({
    id: "crash-recovery-managed",
    agent: "default",
    environment: "workspace",
  });
  await (await running.harness.resumeSession(crashedSession.id)).close();
  const crashedStore = (await running.harness.inspectSession(crashedSession.id))!.store;
  await crashedStore.appendRecord({
    type: "event.lifecycle",
    eventId: "evt_managed_crash_agent_started",
    time: 1,
    address: "main",
    event: { type: "agent.started", agent: "root" },
  });
  await crashedStore.appendRecord({
    type: "event.lifecycle",
    eventId: "evt_managed_crash_turn_started",
    time: 2,
    address: "main",
    event: { type: "turn.started", turnId: "managed-crashed-turn" },
  });
  // Recovery happens when a session is OPENED, and opening is now execution's job alone —
  // subscribing to a stream no longer does it. A read path with a write side effect was never
  // right; here the runtime is asked for explicitly.
  await (await running.harness.resumeSession(crashedSession.id)).close();
  const recoveredHistory = await listAllEvents(running.client, crashedSession.id);
  check(
    "restart: events.list exposes durable failed-turn recovery",
    recoveredHistory.some(
      (event) => event.type === "turn.ended"
        && event.turnId === "managed-crashed-turn"
        && event.reason === "failed",
    ) && recoveredHistory.some((event) => event.type === "agent.ended" && event.agent === "root"),
  );
  const recoveredProjection = new SessionProjection(crashedSession.id);
  for (const event of recoveredHistory) recoveredProjection.apply(event);
  const recoveredAgent = recoveredProjection.snapshot().agents.find((agent) => agent.address === "main");
  check(
    "restart: recovered managed history rebuilds an idle Projection",
    recoveredAgent !== undefined && recoveredAgent.turn === undefined && recoveredAgent.live === false,
  );
  await running.client.sessions.delete(crashedSession.id);

  const duplicateId = "duplicate-managed-id";
  await running.client.sessions.create({ id: duplicateId, agent: "default", environment: "workspace" });
  let conflict = false;
  try {
    await running.client.sessions.create({ id: duplicateId, agent: "default", environment: "workspace" });
  } catch (error) {
    conflict = error instanceof ManagedApiClientError && error.status === 409 && error.code === "conflict";
  }
  check(
    "create: duplicate id returns conflict without deleting original metadata",
    conflict && (await running.client.sessions.retrieve(duplicateId)).id === duplicateId,
  );
  await running.client.sessions.delete(duplicateId);

  const second = await running.client.sessions.messages.create(session.id, { input: "again" });
  check("restart: reopened session can continue", second.status === "queued");
  // Wait for the fire-and-observe delivery before deleting its durable store.
  const active = running.managed.server.listening;
  check("server: remains live after immediate receipt", active);
  for (let i = 0; i < 100; i++) {
    const state = await running.client.sessions.retrieve(session.id);
    if (state.state === "idle") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await running.client.sessions.delete(session.id);
  const listed = await running.client.sessions.list();
  check("delete: removes managed and session resources", !listed.data.some((entry) => entry.id === session.id));
  await running.managed.close();
} finally {
  faux.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
