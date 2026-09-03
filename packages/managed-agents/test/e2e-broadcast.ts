import { T } from "operon-agents";
/**
 * The live path, and specifically the two things the store alone cannot do.
 *
 *  1. Carry an event that is never written down. Token deltas and warnings exist only while a
 *     turn is running; a subscriber reading the log will never see them, however long it waits.
 *  2. Hand over from backfill to live without a gap. The subscription is opened before the log
 *     is read, so an event produced during the read lands in the buffer rather than in neither.
 *
 * The seam is the part worth testing: an event can legitimately arrive from both sides, and a
 * client that sees it twice is as broken as one that never sees it.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "operon-agents";
import {
  createHarness,
  DiskSessionRepository,
  LocalMachine,
} from "operon-agents";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";
import { SessionService } from "../src/server/session-service.ts";
import { MemoryEventBroadcaster, RedisEventBroadcaster } from "../src/server/broadcast.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function liveOnly(sessionId: string, id: string, message: string): AgentEvent {
  // `warning` has no record type — it exists on the live stream and nowhere else.
  return { type: "warning", message, address: "main", sessionId, eventId: id } as unknown as AgentEvent;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "broadcast-"));
  const repository = new DiskSessionRepository(root);
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: join(root, "work") }) };
  const broadcaster = new MemoryEventBroadcaster();
  const service = new SessionService({
    repository,
    work: new MemorySessionWork({ repository }),
    environments,
    metadataStore: new MemoryManagedSessionMetadataStore(),
    broadcaster,
  });

  const session = await service.create({ agent: "default", environment: "default" });
  // One persisted event exists before anyone subscribes, so the backfill has something to do.
  await service.appendEvent(session.id, { input: "first" });

  // ── live-only events reach a subscriber ───────────────────────────────────────
  const seen: AgentEvent[] = [];
  const controller = new AbortController();
  const consuming = (async () => {
    for await (const event of service.watchEvents(session.id, { signal: controller.signal })) {
      seen.push(event);
      if (seen.length === 3) controller.abort();
    }
  })();

  // Give the backfill a moment, then emit something that is never written to the log.
  await new Promise((r) => setTimeout(r, 40));
  broadcaster.publish(session.id, liveOnly(session.id, "evt_live_1", "token delta"));
  broadcaster.publish(session.id, liveOnly(session.id, "evt_live_2", "another delta"));
  await consuming;

  check("backfill delivered the persisted event", seen[0]?.type === "delivery.accepted");
  const live = seen.filter((e) => e.type === "warning");
  check("live-only events reached the subscriber", live.length === 2);
  check(
    "and in order",
    (live[0] as { message: string }).message === "token delta" &&
      (live[1] as { message: string }).message === "another delta",
  );

  // ── the seam does not duplicate ───────────────────────────────────────────────
  // Publish the SAME persisted event the backfill will also produce. A naive implementation
  // yields it twice; this must yield it once.
  const events = await service.listEvents(session.id, { limit: 10 });
  const persisted = events.data.find((e) => e.type === "delivery.accepted")!;

  const seen2: AgentEvent[] = [];
  const controller2 = new AbortController();
  const consuming2 = (async () => {
    for await (const event of service.watchEvents(session.id, { signal: controller2.signal })) {
      seen2.push(event);
      if (seen2.length === 2) controller2.abort();
    }
  })();
  await new Promise((r) => setTimeout(r, 40));
  broadcaster.publish(session.id, persisted); // the duplicate
  broadcaster.publish(session.id, liveOnly(session.id, "evt_live_3", "after the seam"));
  await consuming2;

  const acceptedCount = seen2.filter((e) => e.eventId === persisted.eventId).length;
  check("an event arriving from both sides is delivered once", acceptedCount === 1);
  check("and the stream continues past the seam", seen2.some((e) => e.eventId === "evt_live_3"));

  // ── without a broadcaster, the stream still works (just thinner) ───────────────
  const plain = new SessionService({
    repository,
    work: new MemorySessionWork({ repository }),
    environments,
    metadataStore: new MemoryManagedSessionMetadataStore(),
  });
  const plainSession = await plain.create({ agent: "default", environment: "default" });
  await plain.appendEvent(plainSession.id, { input: "hello" });
  const controller3 = new AbortController();
  const seen3: AgentEvent[] = [];
  for await (const event of plain.watchEvents(plainSession.id, { signal: controller3.signal })) {
    seen3.push(event);
    controller3.abort();
  }
  check("no broadcaster: persisted events still stream", seen3[0]?.type === "delivery.accepted");

  // ── the real thing: deltas produced by an actual turn ─────────────────────────
  // Everything above uses hand-published events to pin the seam logic. This runs a turn and
  // asserts that what the engine emits mid-flight — token deltas, which are never written to
  // the log — actually reaches a subscriber. Without this the channel could be plumbed
  // correctly and still carry nothing worth having.
  await realTurnProducesDeltas();
  await crossProcessBroadcast();
  await strandedSessionIsReported();

  rmSync(root, { recursive: true, force: true });
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  assert.equal(passed, checks.length);
  console.log("✅ BROADCAST E2E PASS");
}

async function realTurnProducesDeltas(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "broadcast-live-"));
  const work = join(root, "work");
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("a streamed answer", { stopReason: "stop" })]);

  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: work }) };
  const broadcaster = new MemoryEventBroadcaster();
  const harness = createHarness({
    harness: (s) => {
      s.register(T.SessionRepository, repository, { owned: false });
      s.register(T.MachineFactory, new LocalMachine(work), { owned: false });
    },
    model: faux.getChatModel(),
    permission: { mode: "yolo" },
  });
  const sessionWork = new MemorySessionWork({ repository });
  const worker = new SessionWorker({ harness, repository, metadataStore, environments, work: sessionWork, broadcaster });
  const service = new SessionService({ repository, work: sessionWork, metadataStore, environments, broadcaster });

  const session = await service.create({ agent: "default", environment: "default" });
  const live: AgentEvent[] = [];
  const unsubscribe = broadcaster.subscribe(session.id, (event) => live.push(event));
  await service.appendEvent(session.id, { input: "say something" });
  await worker.drain(session.id);
  unsubscribe();

  const deltas = live.filter((e) => e.type === "assistant.delta");
  check("a real turn emits token deltas onto the channel", deltas.length > 0);

  // And they are genuinely absent from the log — otherwise this proves nothing about the
  // channel, only that events exist.
  const persisted = await service.listEvents(session.id, { limit: 200 });
  check(
    "those deltas are nowhere in the persisted stream",
    !persisted.data.some((e) => e.type === "assistant.delta"),
  );
  check(
    "while the persisted stream does carry the finished message",
    persisted.data.some((e) => e.type === "message.appended"),
  );

  await harness.close();
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}

/**
 * The cross-process case, which is the one the architecture actually runs in: the worker
 * publishing and the subscriber listening are NOT the same object. A fake Redis stands in for
 * the wire — what it verifies is that this broadcaster keeps no local state that delivery
 * depends on, so two independent instances still talk.
 */
async function crossProcessBroadcast(): Promise<void> {
  // A pub/sub bus that two unrelated clients connect to, like a real server.
  const bus = new Map<string, Set<(channel: string, message: string) => void>>();
  const makeSubscriber = () => {
    let handler: ((channel: string, message: string) => void) | undefined;
    const channels = new Set<string>();
    return {
      subscribe: async (channel: string) => {
        channels.add(channel);
        let set = bus.get(channel);
        if (set === undefined) { set = new Set(); bus.set(channel, set); }
        set.add((c, m) => { if (channels.has(c)) handler?.(c, m); });
      },
      unsubscribe: async (channel: string) => { channels.delete(channel); },
      on: (_event: "message", listener: (channel: string, message: string) => void) => { handler = listener; },
    };
  };
  const publisher = {
    publish: async (channel: string, message: string) => {
      for (const fn of bus.get(channel) ?? []) fn(channel, message);
      return 1;
    },
  };

  // Two separate instances — as if one lived in a worker and one in an API replica.
  const workerSide = new RedisEventBroadcaster({ publisher, subscriber: makeSubscriber() });
  const apiSide = new RedisEventBroadcaster({ publisher, subscriber: makeSubscriber() });

  const received: AgentEvent[] = [];
  apiSide.subscribe("s-cross", (event) => received.push(event));
  await new Promise((r) => setTimeout(r, 10));

  workerSide.publish("s-cross", liveOnly("s-cross", "evt_x1", "delta from another process"));
  await new Promise((r) => setTimeout(r, 20));

  check("cross-process: a subscriber elsewhere receives the event", received.length === 1);
  check(
    "cross-process: the payload survives the wire intact",
    (received[0] as { message?: string } | undefined)?.message === "delta from another process",
  );

  // And an event for a session nobody subscribed to must not leak into this listener.
  workerSide.publish("s-other", liveOnly("s-other", "evt_x2", "not yours"));
  await new Promise((r) => setTimeout(r, 20));
  check("cross-process: events are scoped per session", received.length === 1);
}

/**
 * A worker dying mid-turn is invisible to a subscriber — the stream is attached to the service,
 * not the worker, so it does not break, it just goes quiet. Quiet is also what a model thinking
 * looks like, so the stream must say which one this is.
 *
 * The check requires BOTH unprocessed input and no holder. Each case below exists because one
 * condition alone would misreport it.
 */
async function strandedSessionIsReported(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "stranded-"));
  const repository = new DiskSessionRepository(root);
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: join(root, "work") }) };
  const work = new MemorySessionWork({ repository });
  const service = new SessionService({
    repository,
    work,
    environments,
    metadataStore: new MemoryManagedSessionMetadataStore(),
    broadcaster: new MemoryEventBroadcaster(),
    stallCheckMs: 30,
  });

  // Idle session, nothing pending: silence here is normal and must NOT be reported.
  const idle = await service.create({ agent: "default", environment: "default" });
  const idleController = new AbortController();
  const idleSeen: AgentEvent[] = [];
  const idleWatch = (async () => {
    for await (const event of service.watchEvents(idle.id, { signal: idleController.signal })) {
      idleSeen.push(event);
    }
  })();
  await new Promise((r) => setTimeout(r, 120));
  idleController.abort();
  await idleWatch;
  check("an idle session with no pending work is not reported as stranded",
    !idleSeen.some((e) => e.type === "warning"));

  // Pending input and nobody holding it: this is the real thing.
  const stuck = await service.create({ agent: "default", environment: "default" });
  await service.appendEvent(stuck.id, { input: "nobody will run this" });
  const stuckController = new AbortController();
  const stuckSeen: AgentEvent[] = [];
  const stuckWatch = (async () => {
    for await (const event of service.watchEvents(stuck.id, { signal: stuckController.signal })) {
      stuckSeen.push(event);
      if (event.type === "warning") stuckController.abort();
    }
  })();
  await new Promise((r) => setTimeout(r, 200));
  stuckController.abort();
  await stuckWatch;
  check("pending input with no runner is reported", stuckSeen.some((e) => e.type === "warning"));

  // Same session, but now held: a worker IS on it, so silence is expected again.
  const held = await service.create({ agent: "default", environment: "default" });
  await service.appendEvent(held.id, { input: "someone is working" });
  const lease = await work.acquire(held.id);
  const heldController = new AbortController();
  const heldSeen: AgentEvent[] = [];
  const heldWatch = (async () => {
    for await (const event of service.watchEvents(held.id, { signal: heldController.signal })) {
      heldSeen.push(event);
    }
  })();
  await new Promise((r) => setTimeout(r, 150));
  heldController.abort();
  await heldWatch;
  await lease!.release();
  check("pending input WITH a live lease is not reported", !heldSeen.some((e) => e.type === "warning"));

  rmSync(root, { recursive: true, force: true });
}

await main();
