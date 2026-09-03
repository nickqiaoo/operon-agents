import { T } from "operon-agents";
/**
 * Accepted means "will be claimed", not "is on disk".
 *
 * Every check here is a way an accepted input used to be able to sit in the log with nothing
 * coming for it: accepted on a node with no worker, landed while the only run was on its way
 * out, left behind by a worker that died mid-turn. Each is closed by the work table — the
 * append woke the row, and a claim loop takes woken rows — and each is exercised on its own so
 * a regression names itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "operon-agents";
import { createHarness, DiskSessionRepository, LocalMachine } from "operon-agents";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { MemoryEventBroadcaster } from "../src/server/broadcast.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";
import type { SessionWork, WorkLease } from "../src/server/work.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(name: string, responses: number, options: { readonly ttlMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const work = join(root, "work");
  const faux = registerFauxProvider();
  faux.setResponses(Array.from({ length: responses }, (_, i) => fauxAssistantMessage(`answer ${String(i + 1)}`, { stopReason: "stop" })));
  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: work }) };
  const sessionWork = new MemorySessionWork({ repository, ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}) });
  const harness = createHarness({
    harness: (s) => {
      s.register(T.SessionRepository, repository, { owned: false });
      s.register(T.MachineFactory, new LocalMachine(work), { owned: false });
    },
    model: faux.getChatModel(),
    permission: { mode: "yolo" },
  });
  const assistants = async (service: SessionService, id: string): Promise<number> =>
    (await service.listEvents(id, { limit: 200 })).data.filter(
      (e) => e.type === "message.appended" && e.message.role === "assistant",
    ).length;
  const until = async (condition: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await condition()) return true;
      await sleep(20);
    }
    return condition();
  };
  const cleanup = async (): Promise<void> => {
    await harness.close();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, work, faux, repository, metadataStore, environments, sessionWork, harness, assistants, until, cleanup };
}

/**
 * The deployment the API surface was written for: this node has no worker at all. The input
 * must still run — on a worker that claimed it from the table, not through a nudge.
 */
async function apiNodeWithoutWorker(): Promise<void> {
  const f = fixture("claim-remote", 1);
  // The API node: writes, nudges nobody.
  const service = new SessionService({ repository: f.repository, work: f.sessionWork, metadataStore: f.metadataStore, environments: f.environments });
  // The worker node: shares only the store and the table.
  const worker = new SessionWorker({
    harness: f.harness, repository: f.repository, metadataStore: f.metadataStore, environments: f.environments,
    work: f.sessionWork, claimIntervalMs: 20,
  });
  worker.start();
  const session = await service.create({ agent: "default", environment: "default" });
  check("claim: an unwritten session is not in line", (await f.sessionWork.claim()) === undefined);
  await service.appendEvent(session.id, { input: "hello from afar" });
  await f.until(async () => (await f.assistants(service, session.id)) === 1);
  check("claim: an input accepted on a node with no worker runs on a worker elsewhere", (await f.assistants(service, session.id)) === 1);
  check("claim: once run, nothing is in line", (await f.sessionWork.claim()) === undefined);
  await worker.stop();
  f.faux.unregister();
  rmSync(f.root, { recursive: true, force: true });
}

/**
 * The tail race. A run reads an empty inbox, decides it is done, and is releasing — when a new
 * input lands. No nudge can help: the run is past reading. The append woke the row, release
 * leaves the wake in place, and the claim loop takes it.
 */
async function inputDuringReleaseIsClaimed(): Promise<void> {
  const f = fixture("claim-tail", 2);
  let service: SessionService;
  let sessionId = "";
  let injected = false;
  // A table whose release — the very last step of a run — is where the second input lands.
  const table: SessionWork = {
    append: (id, record) => f.sessionWork.append(id, record),
    claim: () => f.sessionWork.claim(),
    peek: (id) => f.sessionWork.peek(id),
    acquire: async (id) => {
      const lease = await f.sessionWork.acquire(id);
      if (lease === undefined) return undefined;
      const wrapped: WorkLease = {
        ...lease,
        release: async () => {
          if (!injected) {
            injected = true;
            await service.appendEvent(sessionId, { input: "second" });
          }
          await lease.release();
        },
      };
      return wrapped;
    },
  };
  service = new SessionService({ repository: f.repository, work: table, metadataStore: f.metadataStore, environments: f.environments });
  const worker = new SessionWorker({
    harness: f.harness, repository: f.repository, metadataStore: f.metadataStore, environments: f.environments,
    work: table, claimIntervalMs: 20,
  });
  const session = await service.create({ agent: "default", environment: "default" });
  sessionId = session.id;
  await service.appendEvent(sessionId, { input: "first" });
  await worker.drain(sessionId);
  check("tail: the nudged run processed only what it could see", (await f.assistants(service, sessionId)) === 1);
  worker.start();
  await f.until(async () => (await f.assistants(service, sessionId)) === 2);
  check("tail: an input that landed during release is claimed afterwards", (await f.assistants(service, sessionId)) === 2);
  await worker.stop();
  f.faux.unregister();
  rmSync(f.root, { recursive: true, force: true });
}

/**
 * The stall detector must tell "idle with history" apart from "waiting for a worker". It
 * compares the inbox with the cursor — not the log head, which every completed turn leaves
 * ahead of the cursor — and asks the table whether anyone holds the session.
 */
async function strandedMeansUnprocessedInbox(): Promise<void> {
  const f = fixture("stranded", 1);
  const service = new SessionService({
    repository: f.repository, work: f.sessionWork, metadataStore: f.metadataStore, environments: f.environments,
    broadcaster: new MemoryEventBroadcaster(), stallCheckMs: 60,
  });
  const worker = new SessionWorker({ harness: f.harness, repository: f.repository, metadataStore: f.metadataStore, environments: f.environments, work: f.sessionWork });
  const session = await service.create({ agent: "default", environment: "default" });
  await service.appendEvent(session.id, { input: "hello" });
  await worker.drain(session.id);

  const warnings = async (ms: number): Promise<number> => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    let count = 0;
    for await (const event of service.watchEvents(session.id, { signal: controller.signal })) {
      if ((event as AgentEvent).type === "warning") count += 1;
    }
    return count;
  };
  check("stranded: an idle session with history is NOT reported stranded", (await warnings(250)) === 0);
  await service.appendEvent(session.id, { input: "nobody will run this" });
  check("stranded: an unprocessed input with no holder IS reported", (await warnings(250)) === 1);
  await f.cleanup();
}

/**
 * A worker that dies mid-turn leaves its row held past the TTL and a `turn.started` with no
 * end. Nothing new is appended, so nothing wakes the row — the claim loop must take it anyway,
 * close the turn as failed, and tell live subscribers.
 */
async function crashedTurnIsClaimedAndClosed(): Promise<void> {
  const f = fixture("crashed-turn", 1, { ttlMs: 80 });
  const broadcaster = new MemoryEventBroadcaster();
  const service = new SessionService({ repository: f.repository, work: f.sessionWork, metadataStore: f.metadataStore, environments: f.environments, broadcaster });
  const worker = new SessionWorker({
    harness: f.harness, repository: f.repository, metadataStore: f.metadataStore, environments: f.environments,
    work: f.sessionWork, broadcaster, claimIntervalMs: 20, renewIntervalMs: 20,
  });
  const session = await service.create({ agent: "default", environment: "default" });
  await service.appendEvent(session.id, { input: "hello" });
  await worker.drain(session.id);
  check("crash: a healthy, idle session is not in line", (await f.sessionWork.claim()) === undefined);

  // What a dead worker leaves behind: a lease it never released, and a turn that started and
  // never ended. Written raw, as the crashed process's store would have — no session object.
  const dead = (await f.sessionWork.acquire(session.id))!;
  const handle = (await f.repository.open(session.id))!;
  await handle.store.appendRecord({
    type: "event.lifecycle",
    eventId: "evt_crashed_start",
    time: Date.now(),
    address: "main",
    event: { type: "turn.started", turnId: "t-crashed" },
  });
  await handle.store.close?.();
  check("crash: while the lease is live, the session is not offered", (await f.sessionWork.claim()) === undefined);
  const live: AgentEvent[] = [];
  const unsubscribe = broadcaster.subscribe(session.id, (event) => live.push(event));

  await sleep(120); // the TTL lapses; the dead holder never renewed
  worker.start();
  await f.until(async () => live.some((e) => e.type === "turn.ended"));
  unsubscribe();
  check("crash: the dead holder's renew reports the lease lost", (await dead.renew()) === "lost");
  const ended = live.find((e) => e.type === "turn.ended");
  check("crash: the abandoned session was claimed and its open turn closed as failed", ended?.type === "turn.ended" && ended.turnId === "t-crashed" && ended.reason === "failed");
  const persisted = (await service.listEvents(session.id, { limit: 200 })).data;
  check("crash: the close is in the log for anyone who reads later", persisted.some((e) => e.type === "turn.ended" && e.turnId === "t-crashed"));
  await sleep(50);
  check("crash: once closed, nothing is in line again", (await f.sessionWork.claim()) === undefined);
  await worker.stop();
  f.faux.unregister();
  rmSync(f.root, { recursive: true, force: true });
}

/**
 * A turn that fails while a live worker is running it — the model errors, an overflow the
 * recovery cannot claim. The worker does not die, so nothing is orphaned; the failure must
 * still reach a watcher. The runner closes the turn it opened (`turn.ended`, reason `failed`),
 * broadcast live AND persisted, so a client learns the turn is over instead of waiting on a
 * `turn.ended` that never comes.
 */
async function modelFailureIsSeenAsFailedTurn(): Promise<void> {
  const f = fixture("model-failure", 0);
  // A model that errors instead of answering.
  f.faux.setResponses([(async () => { throw new Error("model exploded"); }) as never]);
  const broadcaster = new MemoryEventBroadcaster();
  const service = new SessionService({ repository: f.repository, work: f.sessionWork, metadataStore: f.metadataStore, environments: f.environments, broadcaster });
  const worker = new SessionWorker({ harness: f.harness, repository: f.repository, metadataStore: f.metadataStore, environments: f.environments, work: f.sessionWork, broadcaster });
  const session = await service.create({ agent: "default", environment: "default" });
  const live: AgentEvent[] = [];
  const unsubscribe = broadcaster.subscribe(session.id, (event) => live.push(event));
  await service.appendEvent(session.id, { input: "please fail" });
  await worker.drain(session.id);
  unsubscribe();

  const ended = live.find((e) => e.type === "turn.ended");
  check("failure: a live subscriber sees the turn end as failed, not silence", ended?.type === "turn.ended" && ended.reason === "failed");
  const persisted = (await service.listEvents(session.id, { limit: 200 })).data;
  check("failure: the failed close is in the log for a later reader", persisted.some((e) => e.type === "turn.ended" && e.reason === "failed"));
  check("failure: no completed turn was reported", !live.some((e) => e.type === "turn.ended" && e.reason === "completed"));
  check("failure: nothing is left in line — a failed turn is done, not retried", (await f.sessionWork.claim()) === undefined);
  await f.cleanup();
}

/**
 * A failure OUTSIDE any turn: the environment will not resolve, so no turn ever starts. There
 * is nothing for the runner to close, so the worker itself broadcasts an `error` event — a
 * watcher learns what went wrong now, not only that the stream went quiet.
 */
async function setupFailureIsBroadcastAsError(): Promise<void> {
  const f = fixture("setup-failure", 1);
  const broadcaster = new MemoryEventBroadcaster();
  // The service resolves fine (creation just records the workDir); the WORKER's environment
  // refuses to resolve — the sandbox will not boot on the node that tries to run it.
  const service = new SessionService({ repository: f.repository, work: f.sessionWork, metadataStore: f.metadataStore, environments: f.environments, broadcaster });
  const brokenEnvironments: ManagedEnvironmentRegistry = {
    resolve: () => { throw new Error("environment unavailable"); },
  };
  const errors: unknown[] = [];
  const worker = new SessionWorker({
    harness: f.harness, repository: f.repository, metadataStore: f.metadataStore, environments: brokenEnvironments,
    work: f.sessionWork, broadcaster, onError: (error) => errors.push(error),
  });
  const session = await service.create({ agent: "default", environment: "default" });
  const live: AgentEvent[] = [];
  const unsubscribe = broadcaster.subscribe(session.id, (event) => live.push(event));
  await service.appendEvent(session.id, { input: "will not start" });
  await worker.drain(session.id);
  unsubscribe();

  const errored = live.find((e) => e.type === "error");
  check("setup: a live subscriber sees an error event when the turn could not start", errored?.type === "error" && errored.message.includes("environment unavailable"));
  check("setup: the failure was reported to onError too", errors.length === 1);
  check("setup: no turn was opened", !live.some((e) => e.type === "turn.started"));
  await f.cleanup();
}

async function main(): Promise<void> {
  await apiNodeWithoutWorker();
  await inputDuringReleaseIsClaimed();
  await strandedMeansUnprocessedInbox();
  await crashedTurnIsClaimedAndClosed();
  await modelFailureIsSeenAsFailedTurn();
  await setupFailureIsBroadcastAsError();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ WORK DISCOVERY E2E PASS");
}

await main();
