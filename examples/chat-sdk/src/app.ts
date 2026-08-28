// The platform-neutral core: the /api routes as one fetch-native Hono app. Every import is
// Web-standard, so the same app drops into any host that can run a fetch handler -- with one
// ambient dependency: configuration comes from process.env, read at module scope
// (src/managed-agents.ts), so the host must populate it before imports run. src/main.ts mounts
// this behind the Node server that also serves the page.

import { Hono, type Context } from "hono";
import { subscribeActivity } from "./activity.ts";
import { activityThreadId, authenticate, bot } from "./bot.ts";
import { createSession, eventsOf, historyOf, listSessions, ownedSession } from "./sessions.ts";

// Same identity boundary as /api/chat: an anonymous caller gets a 401 before any managed
// agents call happens.
function withUser(handler: (request: Request) => Promise<Response>) {
  return async (c: Context): Promise<Response> => {
    if (!(await authenticate(c.req.raw))) return new Response("Unauthorized", { status: 401 });
    return handler(c.req.raw);
  };
}

// A browser-supplied session ID is only ever used after it passed the ownership check.
function withSession(handler: (request: Request, sessionId: string) => Promise<Response>) {
  return withUser(async (request) => {
    const conversation = new URL(request.url).searchParams.get("conversation");
    if (!conversation) return new Response("missing ?conversation", { status: 400 });
    if (!(await ownedSession(conversation))) return new Response("Not found", { status: 404 });
    return handler(request, conversation);
  });
}

// Routes carry their full /api/... paths: hosts' rewrites forward the original request URL, so
// a plain route("/", api) mount matches with no prefix juggling.
export const api = new Hono();

api.post("/api/chat", (c) => bot.webhooks.web(c.req.raw));

// The sidebar: conversations are managed sessions, nothing more.
api.get("/api/sessions", withUser(async () => Response.json(await listSessions())));
api.post("/api/sessions", withUser(async () => Response.json(await createSession())));

// Transcript replay from the session's event log. The ownership check matters: the
// conversation ID comes from the browser, and this route must not replay sessions that belong
// to other agents on the server.
api.get("/api/history", withSession(async (_request, sessionId) => Response.json(await historyOf(sessionId))));

// The raw durable event log behind a conversation -- what the "brief ready" card links to. The
// managed server serves the same thing at /v1/sessions/{id}/events; this route puts it behind
// the chat app's own auth instead of handing the browser a managed API key.
api.get("/api/events", withSession(async (_request, sessionId) => Response.json(await eventsOf(sessionId))));

// Server-sent activity for one conversation: tool calls, model requests, retries, all
// published by the bridge while its turn runs. Progress only -- message text travels
// exclusively on /api/chat. The fan-out is in-process (src/activity.ts): on a host that may
// route this request to a different instance than the turn's /api/chat, the feed stays silent
// -- cosmetic only, the chat lane is unaffected.
api.get("/api/activity", (c) => activityTail(c.req.raw));

async function activityTail(request: Request): Promise<Response> {
  const conversation = new URL(request.url).searchParams.get("conversation");
  if (!conversation) return new Response("missing ?conversation", { status: 400 });
  // Beyond withUser's 401, the watched thread is scoped to the caller getUser resolves.
  const threadId = await activityThreadId(request, conversation);
  if (!threadId) return new Response("Unauthorized", { status: 401 });
  // Same ownership rule as /api/history: this route also takes a browser-supplied session ID.
  if (!(await ownedSession(conversation))) return new Response("Not found", { status: 404 });
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // A first byte so EventSource reports the connection open immediately.
      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = subscribeActivity(threadId, (item) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
        } catch {
          // The tab is gone but cancel() has not run yet -- drop the subscription.
          unsubscribe();
        }
      });
      // A closed tab that never receives another publish would otherwise leave its subscriber
      // registered until one arrives and throws.
      request.signal.addEventListener("abort", () => unsubscribe());
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
