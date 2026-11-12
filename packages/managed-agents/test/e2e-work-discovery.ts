/**
 * Accepted means "will be claimed", not "is on disk".
 *
 * Every check here is a way an accepted event used to be able to sit with nothing coming for
 * it: accepted on a node with no worker, landed while the only run was on its way out, left
 * behind by a worker that died mid-turn. Each is closed by the work table — the append woke the
 * row, a claim loop takes woken or abandoned rows, and a holder clears the wake before its last
 * look — and each is exercised on its own so a regression names itself.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, LocalEnvironment } from "operon-agents";
import { DiskSessionRepository } from "operon-agents/advanced";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import type { ManagedEventResource, ManagedStreamEvent } from "../src/protocol/types.ts";
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
const message = (text: string) => ({ events: [{ type: "user.message" as const, content: [{ type: "text" as const, text }] }] });

function fixture(name: string, responses: number, options: { readonly ttlMs?: number; readonly work?: (inner: MemorySessionWork) => SessionWork } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const faux = registerFauxProvider();
  faux.setResponses(Array.from({ length: responses }, (_, i) => fauxAssistantMessage(`answer ${String(i + 1)}`, { stopReason: "stop" })));
  const repository = new DiskSessionRepository(join(root, "sessions"));
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir }) };
  const inner = new MemorySessionWork(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {});
  const sessionWork = options.work?.(inner) ?? inner;
  const broadcaster = new MemoryEventBroadcaster();
  const service = new SessionService({ work: sessionWork, metadataStore, broadcaster });
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(workDir) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const errors: unknown[] = [];
  const worker = (overrides: { readonly environments?: ManagedEnvironmentRegistry } = {}) => new SessionWorker({
    profile: "single-tenant", harness, repository, metadataStore, environments: overrides.environments ?? environments,
    work: sessionWork, broadcaster, claimIntervalMs: 20, renewIntervalMs: 20, inputPollIntervalMs: 20,
    onError: (error) => errors.push(error),
  });
  const history = async (id: string): Promise<readonly ManagedEventResource[]> => (await service.listEvents(id, { limit: 1000 })).data;
  const answers = async (id: string): Promise<number> => (await history(id)).filter((e) => e.type === "agent.message").length;
  const until = async (condition: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await condition()) return true;
      await sleep(20);
    }
    return condition();
  };
  const cleanup = async (...workers: SessionWorker[]): Promise<void> => {
    for (const w of workers) await w.stop();
    await harness.close();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, faux, repository, metadataStore, inner, sessionWork, broadcaster, service, harness, errors, worker, history, answers, until, cleanup };
}

/**
 * The deployment the API surface was written for: the API node has no worker at all. The event
 * must still run — on a worker that claimed it from the table.
 */
async function apiNodeWithoutWorker(): Promise<void> {
  const f = fixture("claim-remote", 1);
  const worker = f.worker();
  worker.start();
  const session = await f.service.create({ agent: "default", environment_id: "default" });
  check("claim: a session nothing was sent to is not in line", (await f.sessionWork.claim()) === undefined);
  await f.service.sendEvents(session.id, message("hello from afar"));
  check("claim: an event accepted with no worker in reach runs on one that claims it", await f.until(async () => (await f.answers(session.id)) === 1));
  await sleep(60);
  check("claim: once run, nothing is in line", (await f.sessionWork.claim()) === undefined);
  await f.cleanup(worker);
}

/**
 * The tail race. A holder's last look finds nothing, and it is releasing — when a new event
 * lands. The holder cleared the wake before that look, so the append re-woke the row, release
 * leaves the wake in place, and the claim loop takes it.
 */
async function eventDuringReleaseIsClaimed(): Promise<void> {
  let send: (() => Promise<void>) | undefined;
  const f = fixture("claim-tail", 2, {
    work: (inner) => ({
      append: (id, entries) => inner.append(id, entries),
      wake: (id) => inner.wake(id),
      pending: (id) => inner.pending(id),
      acknowledge: (id, ids, fence) => inner.acknowledge(id, ids, fence),
      recordOutput: (id, events, fence) => inner.recordOutput(id, events, fence),
      listEvents: (id, options) => inner.listEvents(id, options),
      latestStatus: (id) => inner.latestStatus(id),
      purge: (id) => inner.purge(id),
      peek: (id) => inner.peek(id),
      acquire: (id) => inner.acquire(id),
      claim: async () => {
        const lease = await inner.claim();
        if (lease === undefined) return undefined;
        const wrapped: WorkLease = {
          ...lease,
          renew: () => lease.renew(),
          clearWake: () => lease.clearWake(),
          release: async () => {
            const once = send;
            send = undefined;
            await once?.();
            await lease.release();
          },
        };
        return wrapped;
      },
    }),
  });
  const worker = f.worker();
  const session = await f.service.create({ agent: "default", environment_id: "default" });
  send = async () => { await f.service.sendEvents(session.id, message("second")); };
  await f.service.sendEvents(session.id, message("first"));
  worker.start();
  check("tail: an event that landed during release is claimed afterwards", await f.until(async () => (await f.answers(session.id)) === 2));
  await f.cleanup(worker);
}

/**
 * A worker that dies mid-turn leaves its row held past the TTL and a `session.status_running`
 * it never followed with an idle. Nothing new is sent, so nothing wakes the row — the claim loop
 * must take it anyway and tell watchers the turn is over.
 */
async function deadHolderIsClaimedAndClosed(): Promise<void> {
  const f = fixture("dead-holder", 1, { ttlMs: 80 });
  const session = await f.service.create({ agent: "default", environment_id: "default" });
  const dead = (await f.sessionWork.acquire(session.id))!;
  await f.sessionWork.recordOutput(session.id, [{ type: "session.status_running", id: "evt_dead_running", processed_at: null }], dead.fence);
  check("dead: while its lease is live the session reads running", (await f.service.retrieve(session.id)).status === "running");
  check("dead: and is not offered to a claim", (await f.sessionWork.claim()) === undefined);
  await sleep(120);
  check("dead: once the lease lapses it reads rescheduling", (await f.service.retrieve(session.id)).status === "rescheduling");
  const live: ManagedStreamEvent[] = [];
  const unsubscribe = f.broadcaster.subscribe(session.id, (event) => live.push(event));
  const worker = f.worker();
  worker.start();
  await f.until(async () => live.some((e) => e.type === "session.status_idle"));
  unsubscribe();
  check("dead: the dead holder's renew reports the lease lost", (await dead.renew()) === false);
  check("dead: the abandoned session was claimed and watchers told it stopped",
    live.some((e) => e.type === "session.error") && live.some((e) => e.type === "session.status_idle"));
  check("dead: it reads idle again", (await f.service.retrieve(session.id)).status === "idle");
  let refused = false;
  try { await f.sessionWork.recordOutput(session.id, [{ type: "session.status_running", id: "evt_late", processed_at: null }], dead.fence); } catch { refused = true; }
  check("dead: the dead holder can no longer write history", refused);
  await f.cleanup(worker);
}

/**
 * A turn that fails while a live worker runs it. The failure reaches watchers and the history
 * as `session.error` then `session.status_idle`, and the message is processed — a failed turn
 * is done, not retried.
 */
async function modelFailureIsReported(): Promise<void> {
  const f = fixture("model-failure", 0);
  f.faux.setResponses([(async () => { throw new Error("model exploded"); }) as never]);
  const worker = f.worker();
  worker.start();
  const session = await f.service.create({ agent: "default", environment_id: "default", initial_events: message("please fail").events });
  await f.until(async () => (await f.history(session.id)).some((e) => e.type === "session.status_idle"));
  const events = await f.history(session.id);
  const error = events.find((e) => e.type === "session.error");
  const types = events.map((e) => e.type);
  check("failure: the history reports why", error?.type === "session.error" && error.error.message.length > 0 && error.error.message !== "the agent run failed");
  check("failure: error, then idle — once", JSON.stringify(types.slice(-2)) === JSON.stringify(["session.error", "session.status_idle"])
    && types.filter((t) => t === "session.error").length === 1);
  check("failure: the message is processed", events[0]?.processed_at !== null);
  await f.cleanup(worker);
}

/**
 * A failure outside any turn: the environment will not resolve. Watchers learn what went wrong
 * now, and the message stays pending for the next attempt.
 */
async function setupFailureIsReported(): Promise<void> {
  const f = fixture("setup-failure", 1);
  const worker = f.worker({ environments: { resolve: () => { throw new Error("environment unavailable"); } } });
  const session = await f.service.create({ agent: "default", environment_id: "default" });
  const live: ManagedStreamEvent[] = [];
  const unsubscribe = f.broadcaster.subscribe(session.id, (event) => live.push(event));
  await f.service.sendEvents(session.id, message("will not start"));
  worker.start();
  await f.until(async () => live.some((e) => e.type === "session.error"));
  unsubscribe();
  const errored = live.find((e) => e.type === "session.error");
  check("setup: watchers see the error", errored?.type === "session.error" && errored.error.message.includes("environment unavailable"));
  check("setup: onError heard it too", f.errors.length >= 1);
  check("setup: no turn was opened", !live.some((e) => e.type === "session.status_running"));
  check("setup: the message is still pending", (await f.sessionWork.pending(session.id)).length === 1);
  await f.cleanup(worker);
}

async function main(): Promise<void> {
  await apiNodeWithoutWorker();
  await eventDuringReleaseIsClaimed();
  await deadHolderIsClaimedAndClosed();
  await modelFailureIsReported();
  await setupFailureIsReported();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ WORK DISCOVERY E2E PASS");
}

await main();
