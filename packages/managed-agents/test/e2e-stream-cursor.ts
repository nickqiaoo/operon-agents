import { T } from "operon-agents";
/**
 * The event stream has a durable cursor, and the client uses it.
 *
 * Before: every stream replayed the whole log, an SSE `id:` was stamped on events the log
 * does not contain (token deltas), and a dropped connection ended the iteration. Each check
 * here is one of those, closed: resume after an id, replay only when the id is unknown, no
 * id on live-only frames, and a client that reconnects with `Last-Event-ID` and delivers
 * each event once.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  DiskSessionRepository,
  LocalMachine,
  type AgentEvent,
} from "operon-agents";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { MemoryEventBroadcaster } from "../src/server/broadcast.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";
import { allowAllRequests, createManagedHttpServer } from "../src/server/http-server.ts";
import { ManagedAgentsClient } from "../src/client/client.ts";
import { parseSse, type SseFrame } from "../src/protocol/sse.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "stream-cursor-"));
  const work = join(root, "work");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first answer", { stopReason: "stop" }),
    fauxAssistantMessage("second answer", { stopReason: "stop" }),
    fauxAssistantMessage("third answer", { stopReason: "stop" }),
  ]);
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
  const server = createManagedHttpServer({ service, worker, heartbeatMs: 50, authorize: allowAllRequests });
  await server.listen(0, "127.0.0.1");
  const address = server.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
  const client = new ManagedAgentsClient({ baseUrl });

  // A session with history.
  const session = await client.sessions.create({ agent: "default", environment: "default" });
  await service.appendEvent(session.id, { input: "first" });
  await worker.drain(session.id);
  const history = (await service.listEvents(session.id, { limit: 200 })).data;
  const lastId = history[history.length - 1]!.eventId;
  check("setup: the session has history", history.length > 3);

  // ── service: `after` resumes past the history ─────────────────────────────────
  const collect = async (options: { after?: string }, ms: number): Promise<AgentEvent[]> => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    const seen: AgentEvent[] = [];
    for await (const event of service.watchEvents(session.id, { ...options, signal: controller.signal })) seen.push(event);
    return seen;
  };
  check("after: resuming after the last event replays nothing", (await collect({ after: lastId }, 150)).length === 0);
  check("after: an id the log does not contain replays from the start", (await collect({ after: "evt_not_a_real_id" }, 150)).length === history.length);
  const midId = history[2]!.eventId;
  const fromMid = await collect({ after: midId }, 150);
  check("after: resuming mid-log yields exactly what follows", fromMid.length === history.length - 3 && fromMid[0]!.eventId === history[3]!.eventId);

  // ── transport: `id:` only on durable frames ───────────────────────────────────
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/sessions/${session.id}/events/stream`, {
    headers: { accept: "text/event-stream", "last-event-id": lastId },
    signal: controller.signal,
  });
  const frames: SseFrame[] = [];
  const reading = (async () => {
    try {
      for await (const frame of parseSse(response.body!)) frames.push(frame);
    } catch {
      // aborted
    }
  })();
  await service.appendEvent(session.id, { input: "second" });
  await worker.drain(session.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await reading;
  const deltaFrames = frames.filter((f) => (f.data as AgentEvent).type === "assistant.delta");
  const durableFrames = frames.filter((f) => (f.data as AgentEvent).type === "message.appended");
  check("sse: live-only frames (token deltas) arrived", deltaFrames.length > 0);
  check("sse: live-only frames carry no id", deltaFrames.every((f) => f.id === undefined));
  check("sse: durable frames carry their event id", durableFrames.length > 0 && durableFrames.every((f) => f.id === (f.data as AgentEvent).eventId));
  check("sse: Last-Event-ID skipped the history", !frames.some((f) => (f.data as AgentEvent).eventId === lastId));

  // ── client: reconnects with Last-Event-ID, delivers each event once ─────────
  // A fetch that drops the first connection after a few frames, then serves the rest.
  const headersSent: Array<string | undefined> = [];
  let connection = 0;
  const droppingFetch: typeof fetch = async (input, init) => {
    const upstream = await fetch(input, init);
    const url = String(input);
    if (!url.includes("/events/stream")) return upstream;
    const headers = new Headers(init?.headers);
    headersSent.push(headers.get("last-event-id") ?? undefined);
    connection += 1;
    if (connection !== 1) return upstream;
    // First connection: pass through exactly three SSE frames, then end the body as a drop would.
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let passed = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        for (;;) {
          const separator = buffer.indexOf("\n\n");
          if (separator !== -1) {
            const frame = buffer.slice(0, separator + 2);
            buffer = buffer.slice(separator + 2);
            if (frame.startsWith(":")) continue; // comments are not frames
            passed += 1;
            ctl.enqueue(encoder.encode(frame));
            if (passed >= 3) {
              await reader.cancel().catch(() => undefined);
              ctl.close();
            }
            return;
          }
          const { value, done } = await reader.read();
          if (done) { ctl.close(); return; }
          buffer += decoder.decode(value, { stream: true });
        }
      },
      cancel: () => reader.cancel().catch(() => undefined),
    });
    return new Response(body, { status: upstream.status, headers: upstream.headers });
  };
  const flaky = new ManagedAgentsClient({ baseUrl, fetch: droppingFetch });
  const abort = new AbortController();
  const stream = await flaky.sessions.events.stream(session.id, { signal: abort.signal });
  const delivered: AgentEvent[] = [];
  const consuming = (async () => {
    try {
      for await (const event of stream) delivered.push(event);
    } catch {
      // aborted at the end
    }
  })();
  // Wait until the replay has been re-delivered past the drop, then stop.
  const everything = (await service.listEvents(session.id, { limit: 200 })).data;
  for (let i = 0; i < 100 && delivered.length < everything.length; i += 1) await new Promise((r) => setTimeout(r, 20));
  abort.abort();
  await consuming;
  const ids = delivered.map((e) => e.eventId);
  check("client: the stream reconnected after the drop", connection >= 2);
  check("client: the reconnect carried Last-Event-ID from the last durable frame", typeof headersSent[1] === "string" && ids.includes(headersSent[1]!));
  check("client: every event was delivered exactly once", new Set(ids).size === ids.length && ids.length === everything.length);
  check("client: in log order", ids.join() === everything.map((e) => e.eventId).join());
  check("client: lastEventId is the cursor to continue from", stream.lastEventId === everything[everything.length - 1]!.eventId);

  await server.close();
  faux.unregister();
  rmSync(root, { recursive: true, force: true });

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ STREAM CURSOR E2E PASS");
}

await main();
