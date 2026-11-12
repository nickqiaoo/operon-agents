/**
 * Live previews (`event_deltas[]`), after Claude's contract:
 *
 *  - opt-in per connection: a stream that did not ask gets persisted events only
 *  - `event_start` names the id the buffered `agent.message` will carry; every `event_delta`
 *    carries it too, and the deltas per index concatenate to that block's text
 *  - order: `session.status_running` → `event_start` → `event_delta`* → `agent.message`
 *  - never persisted, and a connection opened mid-message gets no deltas for that message
 *  - best effort: a connection that falls behind sheds the rest of a message's deltas, and
 *    what it did get is still a prefix
 *  - a discarded attempt (`turn.step.reset`) is previewed under an id that is never reconciled
 *  - every model request is a `span.model_request_start` / `span.model_request_end` pair, the end
 *    after the message it produced — or with `is_error` when it produced none, which is what
 *    tells a client an open preview is over
 *  - `event_deltas[]` is validated: known types only, at most 100
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, LocalEnvironment, type AgentEvent } from "operon-agents";
import { DiskSessionRepository } from "operon-agents/advanced";
import { fauxAssistantMessage, fauxText, registerFauxProvider, type FauxResponseStep } from "./faux.ts";
import { ManagedAgentsClient } from "../src/client/client.ts";
import { isManagedPreviewEvent, type ManagedStreamEvent } from "../src/protocol/types.ts";
import { MemoryEventBroadcaster } from "../src/server/broadcast.ts";
import { allowAllRequests, createManagedHttpServer } from "../src/server/http-server.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { ManagedEventTranslator } from "../src/server/wire-events.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const text = (value: string) => ({ type: "user.message" as const, content: [{ type: "text" as const, text: value }] });

async function fixture(name: string, responses: FauxResponseStep[], tokensPerSecond?: number) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const faux = registerFauxProvider({ tokenSize: { min: 2, max: 3 }, ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}) });
  faux.setResponses(responses);
  const repository = new DiskSessionRepository(join(root, "sessions"));
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const work = new MemorySessionWork({ ttlMs: 2_000 });
  const broadcaster = new MemoryEventBroadcaster();
  const service = new SessionService({ work, metadataStore, broadcaster });
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(workDir) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const worker = new SessionWorker({
    profile: "single-tenant",
    harness,
    repository,
    metadataStore,
    environments: { resolve: () => ({ workDir }) },
    work,
    broadcaster,
    inputPollIntervalMs: 30,
    claimIntervalMs: 20,
    renewIntervalMs: 200,
    onError: () => undefined,
  });
  worker.start();
  const http = createManagedHttpServer({ service, authorize: allowAllRequests });
  await http.listen(0, "127.0.0.1");
  const address = http.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${String(port)}/v1`;
  const client = new ManagedAgentsClient({ baseUrl });
  return {
    client, baseUrl, service, broadcaster,
    async close(): Promise<void> {
      await http.close();
      await worker.stop();
      faux.unregister();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Read a stream until the turn goes idle (or time runs out). */
async function collect(stream: AsyncIterable<ManagedStreamEvent>, timeoutMs = 8_000): Promise<ManagedStreamEvent[]> {
  const seen: ManagedStreamEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  const until = Date.now() + timeoutMs;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) break;
    const next = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), left)),
    ]);
    if (next === "timeout" || next.done) break;
    seen.push(next.value);
    if (next.value.type === "session.status_idle") break;
  }
  await iterator.return?.(undefined);
  return seen;
}

/** Concatenated delta text per index, for one previewed event. */
function previewText(events: readonly ManagedStreamEvent[], id: string): string[] {
  const blocks: string[] = [];
  for (const event of events) {
    if (event.type !== "event_delta" || event.event_id !== id) continue;
    blocks[event.delta.index] = (blocks[event.delta.index] ?? "") + event.delta.content.text;
  }
  return blocks;
}

async function optIn(): Promise<void> {
  const answer = "Here is the summary you asked for, streamed a few characters at a time.";
  const f = await fixture("previews-opt-in", [fauxAssistantMessage(answer, { stopReason: "stop" })]);
  try {
    const session = await f.client.sessions.create({ agent: "default", environment_id: "default" });
    const previewing = await f.client.sessions.events.stream(session.id, { event_deltas: ["agent.message"] });
    const plain = await f.client.sessions.events.stream(session.id);
    await f.client.sessions.events.send(session.id, { events: [text("summarize")] });
    const [live, quiet] = await Promise.all([collect(previewing), collect(plain)]);

    const start = live.find((e) => e.type === "event_start");
    const message = live.find((e) => e.type === "agent.message");
    const deltas = live.filter((e) => e.type === "event_delta");
    check("opt-in: an event_start announced an agent.message", start?.type === "event_start" && start.event.type === "agent.message");
    check("opt-in: more than one delta arrived", deltas.length > 1);
    check("opt-in: every delta names the announced id",
      start?.type === "event_start" && deltas.every((e) => e.type === "event_delta" && e.event_id === start.event.id));
    check("opt-in: the buffered agent.message carries the same id",
      start?.type === "event_start" && message !== undefined && "id" in message && message.id === start.event.id);
    check("opt-in: the deltas concatenate to the message text",
      start?.type === "event_start" && JSON.stringify(previewText(live, start.event.id)) === JSON.stringify([answer]));
    const index = (type: string): number => live.findIndex((e) => e.type === type);
    check("opt-in: running → event_start → event_delta → agent.message",
      index("session.status_running") < index("event_start")
        && index("event_start") < index("event_delta")
        && live.findLastIndex((e) => e.type === "event_delta") < index("agent.message"));
    const spanStart = live.find((e) => e.type === "span.model_request_start");
    const spanEnd = live.find((e) => e.type === "span.model_request_end");
    check("span: running → span start → event_start … agent.message → span end",
      index("session.status_running") < index("span.model_request_start")
        && index("span.model_request_start") < index("event_start")
        && index("agent.message") < index("span.model_request_end")
        && index("span.model_request_end") < index("session.status_idle"));
    check("span: the end names its start, succeeded, and reports usage",
      spanEnd?.type === "span.model_request_end" && spanStart !== undefined && "id" in spanStart
        && spanEnd.model_request_start_id === spanStart.id && !spanEnd.is_error && spanEnd.model_usage !== null
        && spanEnd.model_usage.output_tokens > 0);
    check("opt-in: previews carry no id or processed_at of their own",
      live.filter(isManagedPreviewEvent).every((e) => !("id" in e) && !("processed_at" in e)));

    check("no opt-in: no previews on a plain connection", quiet.length > 0 && !quiet.some(isManagedPreviewEvent));
    check("no opt-in: the plain connection still got the full message",
      quiet.some((e) => e.type === "agent.message" && e.content[0]?.text === answer));

    const history = (await f.client.sessions.events.list(session.id, { limit: 100 })).data;
    check("history: previews are never persisted", !history.some((e) => (e.type as string) === "event_start" || (e.type as string) === "event_delta"));
    check("history: the persisted message has the previewed id",
      start?.type === "event_start" && history.some((e) => e.type === "agent.message" && e.id === start.event.id));
  } finally {
    await f.close();
  }
}

async function multipleBlocks(): Promise<void> {
  const f = await fixture("previews-blocks", [fauxAssistantMessage([fauxText("first block"), fauxText("second block")], { stopReason: "stop" })]);
  try {
    const session = await f.client.sessions.create({ agent: "default", environment_id: "default" });
    const stream = await f.client.sessions.events.stream(session.id, { event_deltas: ["agent.message"] });
    await f.client.sessions.events.send(session.id, { events: [text("two blocks")] });
    const live = await collect(stream);
    const start = live.find((e) => e.type === "event_start");
    const message = live.find((e) => e.type === "agent.message");
    check("blocks: one preview for the message", live.filter((e) => e.type === "event_start").length === 1);
    check("blocks: deltas index the message's content blocks",
      start?.type === "event_start" && message?.type === "agent.message"
        && JSON.stringify(previewText(live, start.event.id)) === JSON.stringify(message.content.map((block) => block.text)));
  } finally {
    await f.close();
  }
}

async function joinedMidMessage(): Promise<void> {
  // Slow enough that a second connection can open while the message is still being generated.
  const answer = "a slowly generated answer that takes a while to come out of the model";
  const f = await fixture("previews-late", [fauxAssistantMessage(answer, { stopReason: "stop" })], 60);
  try {
    const session = await f.client.sessions.create({ agent: "default", environment_id: "default" });
    const early = await f.client.sessions.events.stream(session.id, { event_deltas: ["agent.message"] });
    await f.client.sessions.events.send(session.id, { events: [text("go slowly")] });
    const iterator = early[Symbol.asyncIterator]();
    const seenEarly: ManagedStreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      seenEarly.push(next.value);
      if (next.value.type === "event_delta") break;
    }
    const late = await f.client.sessions.events.stream(session.id, { event_deltas: ["agent.message"] });
    const [restEarly, seenLate] = await Promise.all([
      collect({ [Symbol.asyncIterator]: () => iterator }),
      collect(late),
    ]);
    const all = [...seenEarly, ...restEarly];
    check("late: the early connection previewed the message", all.some((e) => e.type === "event_start"));
    check("late: the late connection got no deltas for the in-flight message", !seenLate.some(isManagedPreviewEvent));
    check("late: the late connection still got the buffered message",
      seenLate.some((e) => e.type === "agent.message" && e.content[0]?.text === answer));
  } finally {
    await f.close();
  }
}

async function shedding(): Promise<void> {
  // Straight at the service: publish faster than the connection reads.
  const f = await fixture("previews-shed", []);
  try {
    const session = await f.service.create({ agent: "default", environment_id: "default" });
    const controller = new AbortController();
    const stream = await f.service.stream(session.id, controller.signal, { eventDeltas: ["agent.message"] });
    const id = "sevt_shed";
    const pieces = Array.from({ length: 600 }, (_, i) => `${String(i)},`);
    f.broadcaster.publish(session.id, { type: "event_start", event: { type: "agent.message", id } });
    for (const piece of pieces) {
      f.broadcaster.publish(session.id, { type: "event_delta", event_id: id, delta: { type: "content_delta", index: 0, content: { type: "text", text: piece } } });
    }
    f.broadcaster.publish(session.id, { type: "agent.message", id, processed_at: null, content: [{ type: "text", text: pieces.join("") }] });
    f.broadcaster.publish(session.id, { type: "session.status_idle", id: "sevt_idle", processed_at: null, stop_reason: { type: "end_turn" } });
    const got = await collect(stream, 2_000);
    controller.abort();
    const delivered = got.filter((e) => e.type === "event_delta").length;
    const preview = previewText(got, id)[0] ?? "";
    check("shed: a connection behind by too much drops deltas", delivered > 0 && delivered < pieces.length);
    check("shed: what it delivered is a prefix of the message", pieces.join("").startsWith(preview) && preview.length > 0);
    check("shed: the buffered message still arrives", got.some((e) => e.type === "agent.message"));
  } finally {
    await f.close();
  }
}

function discardedAttempt(): void {
  const translator = new ManagedEventTranslator();
  const base = { eventId: "e", address: "main", timestamp: 0 } as const;
  const feed = (body: object, eventId: string): ManagedStreamEvent[] =>
    translator.translate({ ...base, ...body, eventId } as unknown as AgentEvent);
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 15, cost: {} };
  const out = [
    ...feed({ type: "turn.started", turnId: "t" }, "e1"),
    ...feed({ type: "turn.step.started", turnId: "t", step: 1, stepId: "t.1" }, "e2"),
    ...feed({ type: "assistant.delta", turnId: "t", delta: "half an ans" }, "e3"),
    ...feed({ type: "turn.step.retrying", turnId: "t", step: 1, attempt: 1, maxAttempts: 3, delayMs: 0 }, "e4"),
    ...feed({ type: "turn.step.reset", turnId: "t", step: 1, stepId: "t.1", discardedAttempt: 1, nextAttempt: 2 }, "e5"),
    ...feed({ type: "assistant.delta", turnId: "t", delta: "the answer" }, "e6"),
    ...feed({ type: "turn.step.completed", turnId: "t", step: 1, stepId: "t.1", usage, finishReason: "stop" }, "e7"),
    ...feed({ type: "message.appended", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] } }, "e8"),
  ];
  const starts = out.filter((e) => e.type === "event_start");
  const message = out.find((e) => e.type === "agent.message");
  check("reset: the retry is previewed under a new id", starts.length === 2 && starts[0]?.event.id !== starts[1]?.event.id);
  check("reset: the message reconciles the retry's preview, not the discarded one",
    message !== undefined && "id" in message && message.id === starts[1]?.event.id);

  const spans = out.filter((e) => e.type === "span.model_request_start" || e.type === "span.model_request_end");
  const ends = out.filter((e) => e.type === "span.model_request_end");
  check("retry: each attempt is its own request — start, failed end, start, end",
    spans.map((e) => (e.type === "span.model_request_end" ? `end:${String(e.is_error)}` : "start")).join(",") === "start,end:true,start,end:false");
  check("retry: the failed request ended before the retry previewed anything",
    out.findIndex((e) => e.type === "span.model_request_end") < out.indexOf(starts[1]!));
  check("retry: the request that succeeded ends after its message, with its usage",
    out.indexOf(message!) < out.indexOf(ends[1]!)
      && ends[1]?.type === "span.model_request_end"
      && JSON.stringify(ends[1].model_usage) === JSON.stringify({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }));
  const startIds = spans.filter((e) => e.type === "span.model_request_start").map((e) => ("id" in e ? e.id : ""));
  check("retry: each end names its own start",
    ends.every((e, i) => e.type === "span.model_request_end" && e.model_request_start_id === startIds[i]) && new Set(startIds).size === 2);
}

function cutShort(): void {
  const translator = new ManagedEventTranslator();
  const base = { eventId: "e", address: "main", timestamp: 0 } as const;
  const feed = (body: object, eventId: string): ManagedStreamEvent[] =>
    translator.translate({ ...base, ...body, eventId } as unknown as AgentEvent);
  const interrupted = [
    ...feed({ type: "turn.started", turnId: "t" }, "e1"),
    ...feed({ type: "turn.step.started", turnId: "t", step: 1, stepId: "t.1" }, "e2"),
    ...feed({ type: "assistant.delta", turnId: "t", delta: "partial" }, "e3"),
    ...feed({ type: "turn.step.interrupted", turnId: "t", step: 1, reason: "cancelled" }, "e4"),
    ...feed({ type: "turn.ended", turnId: "t", reason: "cancelled" }, "e5"),
  ];
  const end = interrupted.find((e) => e.type === "span.model_request_end");
  check("cut short: a request with no message still ends, as an error",
    end?.type === "span.model_request_end" && end.is_error && !interrupted.some((e) => e.type === "agent.message"));
  check("cut short: the end comes before the idle",
    interrupted.indexOf(end!) < interrupted.findIndex((e) => e.type === "session.status_idle"));

  const toolStep = [
    ...feed({ type: "turn.started", turnId: "u" }, "f1"),
    ...feed({ type: "turn.step.started", turnId: "u", step: 1, stepId: "u.1" }, "f2"),
    ...feed({ type: "turn.step.completed", turnId: "u", step: 1, stepId: "u.1", finishReason: "toolUse" }, "f3"),
    ...feed({ type: "message.appended", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "Read", arguments: {} }] } }, "f4"),
    ...feed({ type: "tool.call.started", turnId: "u", toolCallId: "c", toolName: "Read", args: {} }, "f5"),
  ];
  const types = toolStep.map((e) => e.type);
  check("tool step: a request that only called a tool ends before the call is announced",
    types.indexOf("span.model_request_end") > types.indexOf("span.model_request_start")
      && types.indexOf("span.model_request_end") < types.indexOf("agent.tool_use"));
}

async function validation(): Promise<void> {
  const f = await fixture("previews-validate", []);
  try {
    const session = await f.client.sessions.create({ agent: "default", environment_id: "default" });
    const url = (query: string): string => `${f.baseUrl}/sessions/${session.id}/events/stream?${query}`;
    const bad = await fetch(url("event_deltas%5B%5D=agent.tool_use"));
    const body = await bad.json() as { error?: { type?: string; message?: string } };
    check("validate: an unknown type is a 400 naming event_deltas",
      bad.status === 400 && body.error?.type === "invalid_request_error" && body.error.message?.includes("event_deltas") === true);
    const many = await fetch(url(Array.from({ length: 101 }, () => "event_deltas%5B%5D=agent.message").join("&")));
    await many.body?.cancel();
    check("validate: more than 100 values is a 400", many.status === 400);
    const controller = new AbortController();
    const ok = await fetch(url("event_deltas%5B%5D=agent.message&event_deltas%5B%5D=agent.thinking"), { signal: controller.signal });
    check("validate: agent.message and agent.thinking are accepted", ok.status === 200);
    controller.abort();
  } finally {
    await f.close();
  }
}

async function main(): Promise<void> {
  await optIn();
  await multipleBlocks();
  await joinedMidMessage();
  await shedding();
  discardedAttempt();
  cutShort();
  await validation();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ LIVE PREVIEWS E2E PASS");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
