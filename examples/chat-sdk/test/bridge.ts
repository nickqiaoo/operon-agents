/**
 * The bridge, end to end, without a model or a network: a managed-agents server with a faux
 * model and a canned WebSearch runs in-process, and the chat app talks to it over HTTP exactly
 * as `pnpm dev` does. Three passes --
 *
 *   1. `runTurn` against a recording thread: streamed reply, kept tool trace, brief card,
 *      the retitle, and the replay (`historyOf`) matching the live posts bubble for bubble.
 *   2. A follow-up on the same session: the stream resumes past the history and only the new
 *      turn is rendered.
 *   3. The whole HTTP surface through the Hono app: POST /api/chat with a `useChat` body, the
 *      AI SDK message stream it answers with, then /api/sessions, /api/history, /api/events.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  compactionCapability,
  createHarness,
  createModelRuntime,
  defineAgent,
  defineModel,
  DiskSessionRepository,
  webSearchTool,
  type WebSearchProvider,
} from "operon-agents";
import {
  allowAllRequests,
  createManagedHttpServer,
  DiskManagedSessionMetadataStore,
  MemoryEventBroadcaster,
  MemorySessionWork,
  SessionService,
  SessionWorker,
  StaticEnvironmentRegistry,
} from "operon-managed-agents/server";
// Type-only, so importing it here does not run the module before the environment is set.
import type { ActivityItem, BotThread } from "../src/managed-agents.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, detail?: unknown): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
  if (!ok && detail !== undefined) console.log("   ", JSON.stringify(detail, null, 2));
}

// ── The analyst server, faux edition ────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), "chat-sdk-home-"));
const work = mkdtempSync(join(tmpdir(), "chat-sdk-work-"));
const faux = fauxProvider();
const runtime = createModelRuntime({ builtins: false });
runtime.models.setProvider(faux.provider);
const descriptor = faux.getModel();
if (descriptor === undefined) throw new Error("faux model unavailable");
const model = defineModel({ runtime, descriptor });

const searched: string[] = [];
const cannedSearch: WebSearchProvider = {
  async search(query) {
    searched.push(query);
    return [{ title: "Result", url: "https://example.com/ssb", snippet: `about ${query}` }];
  },
};
const tools = [webSearchTool(cannedSearch)];
const repository = new DiskSessionRepository(home);
const harness = createHarness({
  model,
  repository,
  agent: defineAgent({ name: "analyst", model, instructions: "You are a research analyst.", tools }),
  tools,
  subagentProvider: null,
  workflowTool: false,
  capabilities: () => [compactionCapability({ maxContextTokens: 200_000 })],
  workDir: work,
  permission: { mode: "workspace" },
});
const metadataStore = new DiskManagedSessionMetadataStore(join(home, "managed"));
const environments = new StaticEnvironmentRegistry({ research: { workDir: work } });
const broadcaster = new MemoryEventBroadcaster();
const sessionWork = new MemorySessionWork({ repository });
const worker = new SessionWorker({ harness, repository, metadataStore, environments, broadcaster, work: sessionWork, defaultAgentId: "analyst" });
worker.start();
const service = new SessionService({ repository, work: sessionWork, metadataStore, environments, broadcaster });
const managed = createManagedHttpServer({ service, worker, authorize: allowAllRequests, heartbeatMs: 50 });
await managed.listen(0, "127.0.0.1");
const address = managed.server.address();
if (address === null || typeof address === "string") throw new Error("expected a TCP address");

// The chat app reads its configuration at import time, so point it at the server first.
process.env.OPERON_MANAGED_URL = `http://127.0.0.1:${address.port}/v1`;
process.env.OPERON_AGENT = "analyst";
process.env.OPERON_ENVIRONMENT = "research";
const { client, runTurn } = await import("../src/managed-agents.ts");
const { createSession, historyOf } = await import("../src/sessions.ts");
const { api } = await import("../src/app.ts");

// A thread that remembers what was posted, in order. Streams are drained to their full text
// (tagged so the test can tell a streamed bubble from a buffered one); cards keep their
// fallback text, which is what the web adapter would send.
function recorder(id: string) {
  const posts: string[] = [];
  const thread: BotThread = {
    id,
    async post(message) {
      if (typeof message === "string") posts.push(message);
      else if (Symbol.asyncIterator in message) {
        let text = "";
        for await (const fragment of message) text += fragment;
        posts.push(`stream:${text}`);
      } else posts.push(`card:${message.fallbackText}`);
    },
  };
  return { thread, posts };
}
const untag = (post: string) => post.replace(/^(stream|card):/, "");

try {
  // ── 1. One research turn ────────────────────────────────────────────────────────────────
  faux.setResponses([
    fauxAssistantMessage([fauxText("On it."), fauxToolCall("WebSearch", { query: "solid-state batteries" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("**Solid-state batteries** -- the brief.")], { stopReason: "stop" }),
  ]);
  const session = await createSession();
  check("create: a fresh session carries the default title", session.title === "New chat");

  const first = recorder("web:local:one");
  const activity: ActivityItem[] = [];
  await runTurn(first.thread, session.id, "give me a brief on solid-state batteries", {
    title: "give me a brief on solid-state batteries",
    activity: (item) => activity.push(item),
  });
  const texts = first.posts.map(untag);
  check("turn: the acknowledgment and the brief are separate bubbles", texts[0] === "On it." && texts[1] === "**Solid-state batteries** -- the brief.", first.posts);
  check("turn: the reply was streamed onto the response", first.posts.some((post) => post.startsWith("stream:")), first.posts);
  check("turn: the search ran with the model's query", searched.length === 1 && searched[0] === "solid-state batteries");
  check("turn: the kept trace names the call", texts[2] === '```tools\n[{"name":"WebSearch","hint":"solid-state batteries"}]\n```', texts[2]);
  check("turn: the brief card counts one search", texts[3]?.startsWith("```card\n") === true && JSON.parse(texts[3]!.split("\n")[1]!).searches === 1, texts[3]);
  check("turn: nothing else was posted", first.posts.length === 4, first.posts);
  const kinds: string[] = activity.map((item) => item.kind);
  check(
    "activity: model, tool, tool_done, writing all reported",
    ["model", "tool", "tool_done", "writing"].every((kind) => kinds.includes(kind)),
    activity,
  );
  check("activity: the tool line carries the query", activity.some((item) => item.label === "WebSearch: solid-state batteries"), activity);
  const retitled = await client.sessions.retrieve(session.id);
  check("title: the first message renamed the session", retitled.title === "give me a brief on solid-state batteries", retitled.title);

  const replay = await historyOf(session.id);
  check(
    "replay: the transcript rebuilds from the log, bubble for bubble",
    replay.map((m) => m.parts[0]?.text).join("\n---\n") === ["give me a brief on solid-state batteries", ...texts].join("\n---\n"),
    replay,
  );
  check("replay: roles line up", replay.map((m) => m.role).join(",") === "user,assistant,assistant,assistant,assistant");

  // ── 2. A follow-up on the same session ──────────────────────────────────────────────────
  faux.setResponses([fauxAssistantMessage([fauxText("From the same research: yes.")], { stopReason: "stop" })]);
  const second = recorder("web:local:one");
  await runTurn(second.thread, session.id, "is that current?", { title: "should not apply" });
  check("follow-up: only the new turn is rendered", second.posts.map(untag).join("|") === "From the same research: yes.", second.posts);
  check("follow-up: no card without a search", second.posts.length === 1);
  check("follow-up: the title gate held", (await client.sessions.retrieve(session.id)).title === "give me a brief on solid-state batteries");
  const replay2 = await historyOf(session.id);
  check(
    "follow-up: replay has both turns",
    replay2.length === 7 && replay2[5]?.parts[0]?.text === "is that current?" && replay2[6]?.parts[0]?.text === "From the same research: yes.",
    replay2,
  );

  // ── 3. The HTTP surface, as the page drives it ──────────────────────────────────────────
  faux.setResponses([fauxAssistantMessage([fauxText("Hello from HTTP.")], { stopReason: "stop" })]);
  const created = await api.fetch(new Request("http://chat.local/api/sessions", { method: "POST" }));
  const web = (await created.json()) as { id: string; title: string };
  check("http: POST /api/sessions creates a session", created.status === 200 && web.title === "New chat");
  const chat = await api.fetch(
    new Request("http://chat.local/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: web.id,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "say hello" }], metadata: { title: "say hello" } }],
      }),
    }),
  );
  const raw = await chat.text();
  const chunks = raw
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.startsWith("data: [DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string });
  const streamed = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta ?? "").join("");
  check("http: POST /api/chat answers with an AI SDK message stream", chat.status === 200 && (chat.headers.get("content-type") ?? "").includes("text/event-stream"), chat.headers.get("content-type"));
  check("http: the reply arrived as text deltas", streamed === "Hello from HTTP.", { streamed, types: chunks.map((c) => c.type) });
  check("http: the stream finished cleanly", chunks.some((chunk) => chunk.type === "finish"));
  const listed = (await (await api.fetch(new Request("http://chat.local/api/sessions"))).json()) as { id: string; title: string }[];
  check("http: GET /api/sessions shows the retitled chat first", listed[0]?.id === web.id && listed[0]?.title === "say hello", listed);
  const history = (await (await api.fetch(new Request(`http://chat.local/api/history?conversation=${web.id}`))).json()) as { role: string; parts: { text: string }[] }[];
  check("http: GET /api/history replays the exchange", history.map((m) => `${m.role}:${m.parts[0]?.text}`).join("|") === "user:say hello|assistant:Hello from HTTP.", history);
  const events = (await (await api.fetch(new Request(`http://chat.local/api/events?conversation=${web.id}`))).json()) as { type: string }[];
  check("http: GET /api/events serves the durable log", events.some((e) => e.type === "turn.started") && events.some((e) => e.type === "turn.ended"));
  const bogus = await api.fetch(new Request("http://chat.local/api/history?conversation=nope-nope"));
  check("http: an unknown conversation is a 404", bogus.status === 404);
  const foreign = await service.create({ agent: "analyst", environment: "research", title: "x" });
  await client.sessions.delete(foreign.id);
  check("http: a deleted session is gone from the sidebar", !(listed.some((s) => s.id === foreign.id)));
} finally {
  await managed.close();
  runtime.models.deleteProvider(faux.provider.id);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
console.log("✅ CHAT SDK BRIDGE E2E PASS");
process.exit(0);
