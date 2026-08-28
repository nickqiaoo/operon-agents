// The chat <-> operon managed-agents bridge. The conversation ID *is* the managed session ID --
// there is no mapping table and no server-side state. Everything here depends only on the
// structural BotThread interface, not on any particular chat surface.
//
// This is the file that changes when the agent platform changes: Anthropic's own quickstart
// talks to Claude Managed Agents here (`client.beta.sessions.*`); this one talks to an
// `operon-managed-agents` server through its typed client. Both expose the same three moves --
// open the session's event stream, send the message, fold events into replies -- so the shape
// of the file is the same and only the event vocabulary differs.

import type { AgentEvent } from "operon-agents";
import { ManagedAgentsClient, ManagedApiClientError } from "operon-managed-agents/client";
import type { ManagedSession } from "operon-managed-agents/protocol";
import { toolLabel, toolsFence, truncate, TITLE_MAX, type BriefStats, type ToolCall } from "./brief.ts";
import { briefCard } from "./card.tsx";

export const MANAGED_URL = process.env.OPERON_MANAGED_URL ?? "http://127.0.0.1:8088/v1";
/** The agent chats are created against (server/agent-config.ts). Sessions of any other agent
 *  on the same server are invisible to this app. */
export const AGENT_ID = process.env.OPERON_AGENT ?? "analyst";
export const ENVIRONMENT_ID = process.env.OPERON_ENVIRONMENT ?? "research";

export const client = new ManagedAgentsClient({
  baseUrl: MANAGED_URL,
  ...(process.env.MANAGED_API_KEY ? { apiKey: process.env.MANAGED_API_KEY } : {}),
});

// Fresh sessions carry this title until the first message renames them; the retitle gate in
// runTurn and the sidebar fallback (src/sessions.ts) must agree on it.
export const DEFAULT_SESSION_TITLE = "New chat";

/** The tool the brief card counts. Named in server/main.ts (`webSearchTool`). */
export const SEARCH_TOOL = "WebSearch";

// One line of turn progress: a tool call starting or finishing, a model request, a thinking
// block, a retry. The bridge reports these through TurnHooks.activity; surfaces decide how to
// show them (the web page streams them to a live feed). The user-facing reply never travels
// here -- that is /api/chat's lane.
export type ActivityItem = {
  kind: "model" | "thinking" | "tool" | "tool_done" | "tool_error" | "writing" | "retry" | "waiting";
  label: string;
};

export type TurnHooks = {
  // Called for each ActivityItem as the turn produces it.
  activity?: (item: ActivityItem) => void;
  // First message of a fresh conversation: becomes the session title, so the sidebar shows
  // what the chat is about.
  title?: string;
};

// The minimal thread surface this module needs; satisfied by the Chat SDK's real thread
// object. post() takes a complete markdown string, an async iterable of fragments (the Chat
// SDK's portable streaming API: the web adapter pumps each fragment onto the open response as
// a text-delta), or a card (see src/card.tsx).
export interface BotThread {
  id: string;
  post(message: string | AsyncIterable<string> | ReturnType<typeof briefCard>): Promise<unknown>;
}

const SESSION_ENDED = "This session has ended on the server. Start a new chat from the sidebar.";

const STUCK =
  "The agent asked for an approval this bridge doesn't handle, and this conversation is stuck waiting for it. Start a new chat from the sidebar; see README.md about tool permissions.";

// The event stream EOF'd mid-turn while the session keeps working server-side -- distinct from
// a failed turn, because the right advice is "check back", not "resend" (a resend would queue a
// duplicate research run).
class StreamDropped extends Error {
  constructor() {
    super("event stream ended before the turn completed");
  }
}

// Conversation IDs come from the browser, so never trust one blindly: it must look like an ID
// (it becomes an API path segment), resolve to a real session, and belong to this app's agent.
// This is the ownership check for every route that touches a session.
export async function ownedSession(sessionId: string): Promise<ManagedSession | null> {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(sessionId)) return null;
  try {
    const session = await client.sessions.retrieve(sessionId);
    if (session.agent.id !== AGENT_ID) return null;
    if (session.state === "closed") return null;
    return session;
  } catch (err) {
    // Only a definitive rejection of this ID means the session is gone: not found, or a 400 for
    // an ID the API says can never resolve. A transient failure (5xx/network) must not read as
    // "session ended" -- rethrow and let the caller fail the one request instead of abandoning
    // the conversation.
    if (err instanceof ManagedApiClientError && (err.status === 400 || err.status === 404 || err.status === 410)) {
      return null;
    }
    throw err;
  }
}

// Serialize turns per thread: one stream reader per session, replies in order. The server
// queues follow-up messages behind a running turn; the anchor check in streamTurn keeps a turn
// from consuming its predecessor's events when an abandoned turn is still finishing.
const queues = new Map<string, Promise<void>>();

export function enqueueTurn(threadId: string, turn: () => Promise<void>): Promise<void> {
  const prev = queues.get(threadId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(turn);
  queues.set(threadId, next);
  next
    .catch(() => {})
    .finally(() => {
      if (queues.get(threadId) === next) queues.delete(threadId);
    });
  return next;
}

// Join a message's text parts the same way for streamed previews, buffered messages, and the
// /api/history replay (src/sessions.ts), so all three line up character for character. Parts
// concatenate without a separator: that is exactly what the `assistant.delta` fragments of one
// step add up to, and the prefix check in streamTurn depends on it.
export function rawTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function textOf(content: unknown): string {
  return rawTextOf(content).trim();
}

// A chat message is delivered as the session's user and journaled bare. Sessions recorded before
// the managed API could say so hold each message inside an `<external-message …>` envelope --
// the framing for relayed words, with a stamp that they are not the user's -- so the display
// strips it and old transcripts read the same as new ones (see README.md, "What the model is
// told").
const EXTERNAL_ENVELOPE = /^<external-message [^>]*>\n(?:\[system:[^\]]*\]\n)?([\s\S]*?)\n<\/external-message>$/;

export function userTextOf(content: unknown): string {
  const text = textOf(content);
  const match = EXTERNAL_ENVELOPE.exec(text);
  return match?.[1] !== undefined ? match[1].trim() : text;
}

// Which delivery a journaled user message -- or the turn it started -- came in as, whichever
// origin it was filed under: `user` for the colleague's own words, `external` for a relayed
// party's. Undefined for everything else the engine puts in the user role (reminders,
// compaction summaries): those answer no delivery.
export function deliveryOf(origin: { readonly kind: string; readonly deliveryId?: string } | undefined): string | undefined {
  return origin?.kind === "user" || origin?.kind === "user_follow_up" || origin?.kind === "external"
    ? origin.deliveryId
    : undefined;
}

// "WebSearch: solid-state batteries" reads better than "WebSearch". Tool inputs are free-form
// JSON; pull the first human-meaningful field and truncate it. Shared with the /api/history
// replay (src/sessions.ts) so the kept trace shows the same lines live and replayed.
export function toolCallOf(name: string, input: unknown): ToolCall {
  const called = truncate(name, 70);
  const args = input as Record<string, unknown> | null | undefined;
  for (const key of ["query", "url", "pattern", "path", "file_path", "command"]) {
    const value = args?.[key];
    if (typeof value === "string" && value) return { name: called, hint: truncate(value, 70) };
  }
  return { name: called, hint: "" };
}

// One streamed reply in flight. `sent` is the exact text already handed to thread.post; push()
// appends to a pending buffer an async generator drains, so fragments coalesce instead of
// queueing one array entry per token. The post itself starts lazily on the first non-empty
// fragment: a step that never produces text never renders an empty bubble.
type StreamingPost = {
  sent: string;
  push(text: string): void;
  finish(): Promise<unknown>;
};

function streamingPost(thread: BotThread): StreamingPost {
  let pending = "";
  let closed = false;
  let wake = () => {};
  let posting: Promise<unknown> | undefined;
  const fragments = (async function* () {
    for (;;) {
      if (pending) {
        const chunk = pending;
        pending = "";
        yield chunk;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  })();
  const post: StreamingPost = {
    sent: "",
    push(text) {
      if (!text) return;
      post.sent += text;
      pending += text;
      if (!posting) {
        posting = thread.post(fragments);
        // Mark handled so an early failure is not an unhandled rejection; finish() returns the
        // same promise, so the failure still surfaces.
        posting.catch(() => {});
      }
      wake();
    },
    finish() {
      closed = true;
      wake();
      return posting ?? Promise.resolve();
    },
  };
  return post;
}

// One user message in, the agent's replies out. Holds the session's SSE stream open for the
// whole turn (minutes for a research request) and posts each agent message as it lands. Never
// rejects: every failure path ends in a message to the thread.
export async function runTurn(thread: BotThread, sessionId: string, text: string, hooks: TurnHooks = {}): Promise<void> {
  try {
    const session = await ownedSession(sessionId);
    if (!session) {
      await thread.post(SESSION_ENDED);
      return;
    }
    if (session.state === "interrupted") {
      // Parked on an approval from an earlier turn; the server refuses new input until it is
      // answered, and this bridge has no way to answer it.
      await thread.post(STUCK);
      return;
    }
    // Only an untitled session takes the title hint: the hint is client metadata, and without
    // this gate any request could rename an existing conversation. Fire-and-forget -- a failed
    // retitle never fails the turn.
    if (hooks.title && (session.title ?? DEFAULT_SESSION_TITLE) === DEFAULT_SESSION_TITLE) {
      void client.sessions.update(sessionId, { title: truncate(hooks.title, TITLE_MAX) }).catch(() => {});
    }
    const stats: BriefStats = { searches: 0, seconds: 0, sessionId };
    const tools: ToolCall[] = [];
    const startedAt = Date.now();
    const { finished, replied } = await streamTurn(thread, sessionId, text, hooks, stats, tools);
    // A cleanly ended turn closes with its trailing messages: the kept tool-call trace (the
    // live feed is progress-only and gone on reload), then the brief card. Gated and ordered
    // exactly like the /api/history replay (src/sessions.ts), so live and replayed transcripts
    // match. If the held response dies before these, the turn itself is complete and replay
    // re-derives both -- their failure must never read as a failed turn.
    if (finished && replied) {
      try {
        if (tools.length > 0) await thread.post(toolsFence(tools));
        if (stats.searches > 0) {
          stats.seconds = Math.round((Date.now() - startedAt) / 1000);
          await thread.post(briefCard(stats));
        }
      } catch (err) {
        console.warn(`[managed-agent] ${sessionId} trailing post failed:`, err);
      }
    }
  } catch (err) {
    if (err instanceof ManagedApiClientError && err.status === 409) {
      // The server refused the message: the session is interrupted (see above) -- the race
      // where it parked between our ownership check and the send.
      await thread.post(STUCK).catch(() => {});
      return;
    }
    console.error(`[managed-agent] turn failed for ${sessionId}:`, err);
    let message = "Hit a snag on my end. Send that again?";
    if (err instanceof StreamDropped) {
      // Distinguish "the connection died" from "the session is gone" before advising.
      const still = await ownedSession(sessionId).catch(() => null);
      message = still
        ? "I lost my connection mid-research, but the work continues on the server. Reopen this chat from the sidebar in a minute or two to see the reply."
        : SESSION_ENDED;
    }
    await thread.post(message).catch(() => {});
  }
}

// `finished` is true when the turn ended cleanly; false when it stopped early, failed, or parked
// on an approval -- all already explained to the thread. `replied` is true once the agent
// posted any non-empty message text.
async function streamTurn(
  thread: BotThread,
  sessionId: string,
  text: string,
  hooks: TurnHooks,
  stats: BriefStats,
  tools: ToolCall[],
): Promise<{ finished: boolean; replied: boolean }> {
  const note = hooks.activity ?? (() => {});
  // Stream first, then send: what happens between the two is only in the replay, and the
  // ordering is the only way to be sure of seeing the start of the turn live. The stream
  // normally opens with the session's whole durable history -- for a chat that is the transcript
  // the page already shows -- so resume after the newest durable event instead: `after` takes
  // the very cursor a reconnect would, and live-only events (token deltas) never carry one.
  const newest = await client.sessions.events.list(sessionId, { limit: 1, order: "desc" });
  const after = newest.data[0]?.eventId;
  const controller = new AbortController();
  const stream = await client.sessions.events.stream(sessionId, {
    signal: controller.signal,
    ...(after !== undefined ? { after } : {}),
  });
  // The receipt names our delivery. A previous turn can still be running server-side (Stop only
  // abandons the response, and a dropped stream leaves the research going); `follow_up` queues
  // the message as its own turn behind it, rather than steering it into the running one.
  // Everything on the stream before our turn begins is therefore that turn's leftovers,
  // discarded below rather than posted as if it answered this message. The event log keeps the
  // discarded replies; reopening the chat replays them.
  let deliveryId: string;
  try {
    const receipt = await client.sessions.messages.create(sessionId, { input: text, mode: "follow_up" });
    deliveryId = receipt.deliveryId;
  } catch (err) {
    controller.abort();
    throw err;
  }

  // Which turn is ours. Unknown until the delivery shows up -- as the origin of a fresh
  // `turn.started`, or as a `message.appended` inside a turn already running (the server
  // journals the prompt ahead of its turn, so the next turn to start is then ours).
  let currentTurn: string | undefined;
  let ourTurn: string | undefined;
  let claimNextTurn = false;
  let waitingNoted = false;
  // The streamed bubble for the step being written, if any. One step = one assistant message =
  // one bubble; the buffered `message.appended` at the step's end is the authoritative text.
  let open: StreamingPost | undefined;
  let thinkingNoted = false;
  // True once a persisted assistant message carried non-empty text. Streamed text whose
  // buffered message never arrives (a failed step) does not count: the card mirrors what the
  // event log can replay.
  let replied = false;
  // Tool call id -> its trace entry, so the matching result can report by name and mark the
  // entry failed.
  const openCalls = new Map<string, ToolCall>();
  const closeOpen = async () => {
    if (!open) return;
    const post = open;
    open = undefined;
    await post.finish().catch(() => {});
  };
  const ours = (event: AgentEvent & { readonly turnId?: string }) =>
    ourTurn !== undefined && event.turnId === ourTurn;

  try {
    for await (const event of stream) {
      if (event.address !== "main") continue;
      // ── Anchoring: find the turn that took our delivery ──
      if (event.type === "turn.started") {
        currentTurn = event.turnId;
        if (claimNextTurn || deliveryOf(event.origin) === deliveryId) {
          ourTurn = event.turnId;
          claimNextTurn = false;
        }
        continue;
      }
      if (event.type === "message.appended" && event.message.role === "user") {
        if (ourTurn === undefined && deliveryOf(event.origin) === deliveryId) {
          if (currentTurn !== undefined) ourTurn = currentTurn;
          else claimNextTurn = true;
        }
        continue;
      }
      if (ourTurn === undefined) {
        // A previous turn is still finishing; say so once and keep skipping its events.
        if (!waitingNoted && event.type !== "turn.ended") {
          waitingNoted = true;
          note({ kind: "waiting", label: "finishing the previous turn" });
        }
        continue;
      }

      switch (event.type) {
        case "turn.step.started":
          if (!ours(event)) break;
          thinkingNoted = false;
          note({ kind: "model", label: "model request" });
          break;
        case "thinking.delta":
          // Fragments of the model's reasoning; the feed only says that it is happening.
          if (!ours(event) || thinkingNoted) break;
          thinkingNoted = true;
          note({ kind: "thinking", label: "thinking" });
          break;
        case "assistant.delta":
          // The model is writing a message; the bubble opens with its first fragment.
          if (!ours(event)) break;
          if (!open) {
            open = streamingPost(thread);
            note({ kind: "writing", label: "writing the reply" });
          }
          open.push(event.delta);
          break;
        case "message.appended": {
          // The journaled assistant message is the truth. If the streamed bubble is a prefix
          // of it, the rest goes onto the same bubble; if the two somehow diverged, close the
          // bubble and post the authoritative text separately -- the persisted message always
          // wins over live deltas.
          if (event.message.role !== "assistant" || ourTurn !== currentTurn) break;
          // Untrimmed -- see rawTextOf: live and replayed transcripts must match.
          const full = rawTextOf(event.message.content);
          const hasText = full.trim() !== "";
          if (hasText) replied = true;
          if (open) {
            const post = open;
            open = undefined;
            const matched = full.startsWith(post.sent);
            if (matched) post.push(full.slice(post.sent.length));
            await post.finish();
            if (!matched && hasText) await thread.post(full);
          } else if (hasText) {
            await thread.post(full);
          }
          break;
        }
        case "tool.call.started": {
          if (event.toolName === SEARCH_TOOL) stats.searches++;
          // The feed and the kept trace get the tool name plus a short argument hint (the
          // user's own query); the server log gets the name only -- inputs are derived from
          // user messages and do not belong there.
          const call = toolCallOf(event.toolName, event.args);
          tools.push(call);
          openCalls.set(event.toolCallId, call);
          note({ kind: "tool", label: toolLabel(call) });
          console.log(`[managed-agent] ${sessionId} tool: ${event.toolName}`);
          break;
        }
        case "tool.result": {
          const call = openCalls.get(event.toolCallId);
          openCalls.delete(event.toolCallId);
          if (event.isError && call) call.error = true;
          const name = call?.name ?? event.toolName;
          note(event.isError ? { kind: "tool_error", label: `${name} failed` } : { kind: "tool_done", label: `${name} done` });
          break;
        }
        case "turn.step.retrying":
          // A failed model request being retried (overload, rate limit); the turn goes on.
          if (!ours(event)) break;
          console.warn(`[managed-agent] ${sessionId} retry ${event.attempt}/${event.maxAttempts}: ${event.reason ?? ""}`);
          note({ kind: "retry", label: `${event.reason ?? "error"}, retrying` });
          break;
        case "error":
          console.warn(`[managed-agent] ${sessionId} error: ${event.message}`);
          break;
        case "turn.ended": {
          currentTurn = undefined;
          if (!ours(event)) break;
          await closeOpen();
          if (event.reason === "completed") {
            // A turn that parked on an approval also ends; only the interruption list tells the
            // two apart. This bridge cannot answer one (no approval surface), and the session
            // refuses new input until someone does -- the same dead end Anthropic's
            // `requires_action` stop reason names.
            const pending = await client.sessions.interruptions(sessionId);
            if (pending.data.length > 0) {
              await thread.post(STUCK);
              return { finished: false, replied };
            }
            return { finished: true, replied };
          }
          if (event.reason === "cancelled") {
            await thread.post("Research run stopped early (cancelled). Try again.");
            return { finished: false, replied };
          }
          await thread.post(`Research run failed${event.error ? `: ${truncate(event.error, 200)}` : ""}. Try again.`);
          return { finished: false, replied };
        }
      }
    }
  } finally {
    // However the loop exits, no streamed bubble is left open and the connection is released.
    await closeOpen();
    controller.abort();
  }

  // The stream closed without our turn ending. The client reconnects on its own, so reaching
  // here means the server went away for good or refused the resume. The message is already
  // accepted server-side (the send succeeded), so runTurn's catch must NOT tell the user to
  // resend -- see StreamDropped.
  throw new StreamDropped();
}
