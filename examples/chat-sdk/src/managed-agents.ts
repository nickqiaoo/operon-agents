// The chat <-> operon managed-agents bridge. The conversation ID *is* the managed session ID --
// there is no mapping table and no server-side state. Everything here depends only on the
// structural BotThread interface, not on any particular chat surface.
//
// This is the file that changes when the agent platform changes: Anthropic's own quickstart
// talks to Claude Managed Agents here (`client.beta.sessions.*`); this one talks to an
// `operon-managed-agents` server through its typed client. The server speaks the same session
// vocabulary (`user.message` in; `agent.message`, `agent.tool_use`, `session.status_idle` out;
// `event_start` / `event_delta` previews on request), so the moves are the same three -- open
// the session's event stream, send the message, fold events into replies.

import { ManagedAgentsClient, ManagedApiClientError } from "operon-managed-agents/client";
import type { ManagedSessionResource } from "operon-managed-agents/protocol";
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

// One line of turn progress: the model starting on the message, a tool call starting or
// finishing, the reply being written. The bridge reports these through TurnHooks.activity; surfaces decide how to
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
export async function ownedSession(sessionId: string): Promise<ManagedSessionResource | null> {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(sessionId)) return null;
  try {
    const session = await client.sessions.retrieve(sessionId);
    if (session.agent.id !== AGENT_ID) return null;
    if (session.archived_at !== null || session.status === "terminated") return null;
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

// Serialize turns per thread: one stream reader per session, replies in order. A message sent
// while an abandoned turn is still finishing is taken into it; the anchor check in streamTurn
// keeps a turn from posting what that turn said before our message reached it.
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
// concatenate without a separator: that is exactly what a preview's `event_delta`s add up to
// when taken in arrival order (block 0's, then block 1's), and the prefix check in streamTurn
// depends on it.
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

// Whether the session is parked on a `requires_action` idle: an approval or an answer this
// bridge cannot give. A message sent now would only be held until someone answers, so the turn
// would never come. The newest status event in the history says.
async function awaitingAction(sessionId: string): Promise<boolean> {
  const { data } = await client.sessions.events.list(sessionId, { limit: 100, order: "desc" });
  const status = data.find((event) => event.type.startsWith("session.status_"));
  return status?.type === "session.status_idle" && status.stop_reason.type === "requires_action";
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
  // The preview this bubble was showing will never become a message (see streamTurn). Marks
  // the bubble so nobody reads it as the reply, then removes it where the platform can.
  abandon(): Promise<void>;
};

// Appended to a bubble whose preview was abandoned. Stays visible where the platform cannot
// delete a sent message (the web adapter streams each reply onto its HTTP response, for good).
export const ABANDONED_MARK = "\n\n_(cut off — not part of the reply)_";

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
    async abandon() {
      if (!posting) {
        // Nothing reached the thread yet: there is no bubble to take back.
        closed = true;
        wake();
        return;
      }
      post.push(ABANDONED_MARK);
      const sent = await post.finish().catch(() => undefined);
      const removable = sent as { delete?: () => Promise<void> } | undefined;
      await removable?.delete?.().catch(() => {});
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
    if (await awaitingAction(sessionId)) {
      // Parked on an approval from an earlier turn; the server holds new input until it is
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
    const { finished, replied } = await streamTurn(thread, sessionId, text, hooks, stats, tools);
    // A cleanly ended turn closes with its trailing messages: the kept tool-call trace (the
    // live feed is progress-only and gone on reload), then the brief card. Gated and ordered
    // exactly like the /api/history replay (src/sessions.ts), so live and replayed transcripts
    // match. If the held response dies before these, the turn itself is complete and replay
    // re-derives both -- their failure must never read as a failed turn.
    if (finished && replied) {
      try {
        if (tools.length > 0) await thread.post(toolsFence(tools));
        if (stats.searches > 0) await thread.post(briefCard(stats));
      } catch (err) {
        console.warn(`[managed-agent] ${sessionId} trailing post failed:`, err);
      }
    }
  } catch (err) {
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

// `finished` is true when the turn ended cleanly; false when it failed or parked on an
// approval -- both already explained to the thread. `replied` is true once the agent posted any
// non-empty message text.
async function streamTurn(
  thread: BotThread,
  sessionId: string,
  text: string,
  hooks: TurnHooks,
  stats: BriefStats,
  tools: ToolCall[],
): Promise<{ finished: boolean; replied: boolean }> {
  const note = hooks.activity ?? (() => {});
  // Stream first, then send: the stream is live-only, so the order is the only way to be sure
  // of seeing the start of the turn. `event_deltas` asks for previews of each agent.message as
  // the model writes it; without them every reply would land in one piece.
  const controller = new AbortController();
  const stream = await client.sessions.events.stream(sessionId, {
    signal: controller.signal,
    event_deltas: ["agent.message"],
  });
  // The accepted event's id is how our message shows up again on the stream: echoed with
  // `processed_at` set once it is in the conversation. A previous turn can still be running
  // server-side (Stop only abandons the response, and a dropped stream leaves the research
  // going); everything it says before the echo is its own, discarded below rather than posted
  // as if it answered this message. The history keeps the discarded replies; reopening the chat
  // replays them.
  let messageId: string;
  try {
    const sent = await client.sessions.events.send(sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
    messageId = sent.data[0]!.id;
  } catch (err) {
    controller.abort();
    throw err;
  }

  // True once our message came back processed: from there on the session is answering it.
  let anchored = false;
  let waitingNoted = false;
  // The streamed bubble for the message being previewed, keyed by the id the buffered
  // agent.message will carry. The buffered message is the authoritative text.
  let open: { id: string; post: StreamingPost } | undefined;
  // True once a persisted agent message carried non-empty text. Streamed text whose buffered
  // message never arrives (a discarded attempt) does not count: the card mirrors what the event
  // history can replay.
  let replied = false;
  // Why the turn failed, if a session.error said so before the idle.
  let failure: string | undefined;
  // The brief card's timing, from the events' own `processed_at` -- our message reaching the
  // conversation to the last reply -- so the replay (src/sessions.ts) computes the same number.
  const at = (stamp: string | null): number => (stamp === null ? Date.now() : Date.parse(stamp));
  let turnStartedAt = 0;
  let lastReplyAt = 0;
  // agent.tool_use id -> its trace entry, so the matching result can report by name and mark the
  // entry failed.
  const openCalls = new Map<string, ToolCall>();
  const closeOpen = async () => {
    if (!open) return;
    const { post } = open;
    open = undefined;
    await post.finish().catch(() => {});
  };
  // The preview on screen will not be reconciled: its request ended without the message, a
  // retry started over, or the worker running it went away.
  const abandonOpen = async () => {
    if (!open) return;
    const { post } = open;
    open = undefined;
    await post.abandon().catch(() => {});
  };

  try {
    for await (const event of stream) {
      // ── Anchoring: wait for our message to reach the conversation ──
      if (!anchored) {
        if (event.type === "user.message" && event.id === messageId && event.processed_at !== null) {
          anchored = true;
          turnStartedAt = at(event.processed_at);
          note({ kind: "model", label: "model request" });
        } else if (!waitingNoted && (event.type.startsWith("agent.") || event.type === "event_start")) {
          // A previous turn is still talking; say so once and keep skipping its events.
          waitingNoted = true;
          note({ kind: "waiting", label: "finishing the previous turn" });
        }
        continue;
      }

      switch (event.type) {
        case "event_start":
          // The model started a message; the bubble opens with its first fragment. A preview
          // still open here belonged to an attempt that was discarded and never reconciled.
          if (event.event.type !== "agent.message") break;
          await abandonOpen();
          open = { id: event.event.id, post: streamingPost(thread) };
          note({ kind: "writing", label: "writing the reply" });
          break;
        case "event_delta":
          if (open?.id === event.event_id) open.post.push(event.delta.content.text);
          break;
        case "agent.message": {
          // The persisted message is the truth. If the streamed bubble is a prefix of it, the
          // rest goes onto the same bubble; if the two diverged (or deltas were shed), close the
          // bubble and post the authoritative text separately.
          // Untrimmed -- see rawTextOf: live and replayed transcripts must match.
          const full = rawTextOf(event.content);
          const hasText = full.trim() !== "";
          if (hasText) {
            replied = true;
            lastReplyAt = at(event.processed_at);
          }
          if (open?.id === event.id) {
            const { post } = open;
            open = undefined;
            const matched = full.startsWith(post.sent);
            if (matched) post.push(full.slice(post.sent.length));
            await post.finish();
            if (!matched && hasText) await thread.post(full);
          } else {
            await abandonOpen();
            if (hasText) await thread.post(full);
          }
          break;
        }
        case "span.model_request_end":
          // A request's message, if it made one, came before this. A preview still open is one
          // the request never delivered -- it failed, was retried, or was cut short.
          await abandonOpen();
          break;
        case "session.status_rescheduled":
          // The worker running the turn went away; the next one starts the request over.
          await abandonOpen();
          break;
        case "agent.tool_use": {
          // A call announced only to ask about it is the pause itself; the idle that follows
          // says so. Everything else is a call that runs.
          if (event.evaluated_permission === "ask") break;
          if (event.name === SEARCH_TOOL) stats.searches++;
          // The feed and the kept trace get the tool name plus a short argument hint (the
          // user's own query); the server log gets the name only -- inputs are derived from
          // user messages and do not belong there.
          const call = toolCallOf(event.name, event.input);
          tools.push(call);
          openCalls.set(event.id, call);
          note({ kind: "tool", label: toolLabel(call) });
          console.log(`[managed-agent] ${sessionId} tool: ${event.name}`);
          break;
        }
        case "agent.tool_result": {
          const call = openCalls.get(event.tool_use_id);
          openCalls.delete(event.tool_use_id);
          if (event.is_error && call) call.error = true;
          const name = call?.name ?? "tool";
          note(event.is_error ? { kind: "tool_error", label: `${name} failed` } : { kind: "tool_done", label: `${name} done` });
          break;
        }
        case "session.error":
          console.warn(`[managed-agent] ${sessionId} error: ${event.error.message}`);
          failure = event.error.message;
          break;
        case "session.status_idle": {
          await abandonOpen();
          if (event.stop_reason.type === "requires_action") {
            // The turn parked on an approval or a question, and the session holds new input
            // until someone answers -- Anthropic's `requires_action`. This bridge has no
            // approval surface, so it can only say so.
            await thread.post(STUCK);
            return { finished: false, replied };
          }
          if (failure === undefined) {
            stats.seconds = Math.max(0, Math.round((lastReplyAt - turnStartedAt) / 1000));
            return { finished: true, replied };
          }
          await thread.post(`Research run failed: ${truncate(failure, 200)}. Try again.`);
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
