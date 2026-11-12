/**
 * The live path: worker → broadcast → API → SSE → client.
 *
 *  1. Cross-process. The worker publishing and the API subscribing are NOT the same object: two
 *     independent `RedisEventBroadcaster`s share only a (fake) pub/sub bus, as a worker node and
 *     an API replica would. A client streaming through the API sees what the worker emitted, in
 *     the managed vocabulary, with nothing of the runtime's leaking through.
 *  2. Live-only, and the client fills the gap. The stream carries only what is emitted after it
 *     opens; a dropped connection loses events, and the client recovers them from the history,
 *     delivering each exactly once.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, LocalEnvironment } from "operon-agents";
import { DiskSessionRepository } from "operon-agents/advanced";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { ManagedAgentsClient, ManagedSessionEventStream } from "../src/client/client.ts";
import type { SseFrame } from "../src/protocol/sse.ts";
import type { ListSessionEventsResponse, ManagedEventResource } from "../src/protocol/types.ts";
import { RedisEventBroadcaster } from "../src/server/broadcast.ts";
import { allowAllRequests, createManagedHttpServer } from "../src/server/http-server.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** A pub/sub bus that unrelated clients connect to, like a real Redis server. */
function fakeRedis() {
  const bus = new Map<string, Set<(channel: string, message: string) => void>>();
  const subscriber = () => {
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
  return { subscriber, publisher };
}

async function crossProcess(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "broadcast-"));
  const workDir = join(root, "work");
  mkdirSync(workDir);
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("hello from the worker", { stopReason: "stop" })]);
  const redis = fakeRedis();
  // Shared durable state, as Postgres would be.
  const work = new MemorySessionWork();
  const metadataStore = new MemoryManagedSessionMetadataStore();
  // The API replica: its own broadcaster instance, no worker, no harness.
  const service = new SessionService({ work, metadataStore, broadcaster: new RedisEventBroadcaster({ publisher: redis.publisher, subscriber: redis.subscriber() }) });
  const http = createManagedHttpServer({ service, authorize: allowAllRequests });
  await http.listen(0, "127.0.0.1");
  // The worker node: a different broadcaster instance on the same bus.
  const repository = new DiskSessionRepository(join(root, "sessions"));
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(workDir) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const worker = new SessionWorker({
    profile: "single-tenant", harness, repository, metadataStore, environments: { resolve: () => ({ workDir }) }, work,
    broadcaster: new RedisEventBroadcaster({ publisher: redis.publisher, subscriber: redis.subscriber() }),
    claimIntervalMs: 20, inputPollIntervalMs: 20,
  });
  worker.start();
  const address = http.server.address();
  const client = new ManagedAgentsClient({ baseUrl: `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}/v1` });
  try {
    const session = await client.sessions.create({ agent: "default", environment_id: "default" });
    const controller = new AbortController();
    const stream = await client.sessions.events.stream(session.id, { signal: controller.signal });
    const sent = await client.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] });
    const seen: ManagedEventResource[] = [];
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      for await (const event of stream) {
        seen.push(event);
        if (event.type === "session.status_idle") break;
      }
    } catch { /* aborted */ }
    clearTimeout(timeout);
    controller.abort();
    const types = seen.map((e) => e.type);
    check("cross-process: the client saw the worker's events through the API", types.includes("agent.message") && types.at(-1) === "session.status_idle");
    check("cross-process: its own message echoed back processed", seen.some((e) => e.id === sent.data[0]!.id && e.processed_at !== null));
    check("cross-process: only managed vocabulary on the wire", seen.every((e) => /^(user|agent|session|span)\./.test(e.type)));
    const history = (await client.sessions.events.list(session.id)).data.map((e) => e.id);
    check("cross-process: every streamed event is in the history", seen.every((e) => history.includes(e.id)));
  } finally {
    await http.close();
    await worker.stop();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  }
}

async function reconnectFillsTheGap(): Promise<void> {
  const event = (id: string, type = "agent.message"): ManagedEventResource =>
    ({ type, id, processed_at: "2026-01-01T00:00:00.000Z", content: [{ type: "text", text: id }] }) as ManagedEventResource;
  const frames = (events: readonly ManagedEventResource[]): AsyncIterator<SseFrame> =>
    (async function* () { for (const e of events) yield { event: e.type, id: e.id, data: e }; })();
  // History, newest first, as the client asks for it. e0 predates the stream.
  const all = ["e0", "e1", "e2", "e3", "e4", "e5"].map((id) => event(id));
  const history = async (): Promise<ListSessionEventsResponse> => ({ data: [...all].reverse(), next_page: null });
  let connections = 0;
  // The first connection drops after e2; e3 and e4 are emitted while it is down; the second
  // connection opens in time for e5 and then e6.
  const connect = async (): Promise<AsyncIterator<SseFrame>> => {
    connections += 1;
    return frames([event("e5"), event("e6")]);
  };
  const stream = new ManagedSessionEventStream(connect, history, frames([event("e1"), event("e2")]), "e0", { reconnect: true });
  const delivered: string[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  for (let i = 0; i < 6; i += 1) {
    const next = await iterator.next();
    if (next.done) break;
    delivered.push(next.value.id);
  }
  check("reconnect: the stream reopened after the drop", connections === 1);
  check("reconnect: the gap came from the history, each event once, in order", delivered.join() === "e1,e2,e3,e4,e5,e6");
  check("reconnect: nothing from before the stream opened", !delivered.includes("e0"));
  await iterator.return?.();
}

await crossProcess();
await reconnectFillsTheGap();
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
console.log("✅ BROADCAST E2E PASS");
