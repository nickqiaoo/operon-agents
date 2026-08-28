// The sidebar's data source. There is no database: managed sessions ARE the conversation
// store. Listing, creating, and replaying a chat are all plain API calls against /v1/sessions
// -- restart the chat server and every conversation is still here.

import { SessionProjection, type AgentEvent, type Message, type PromptOrigin } from "operon-agents";
import type { ManagedSession } from "operon-managed-agents/protocol";
import { cardFence, toolsFence, type ToolCall } from "./brief.ts";
import {
  AGENT_ID,
  client,
  DEFAULT_SESSION_TITLE,
  ENVIRONMENT_ID,
  ownedSession,
  rawTextOf,
  SEARCH_TOOL,
  toolCallOf,
  deliveryOf,
  userTextOf,
} from "./managed-agents.ts";

export type SessionSummary = {
  id: string;
  title: string;
  status: string;
  created_at: string;
};

function toSummary(session: ManagedSession): SessionSummary {
  return {
    id: session.id,
    title: session.title || DEFAULT_SESSION_TITLE,
    status: session.state,
    created_at: new Date(session.createdAt).toISOString(),
  };
}

// Sessions for this app's agent only. The managed API lists every session on the server; the
// agent filter is ours, and closed ones are left out because ownedSession would reject them
// anyway -- a sidebar entry for one would just be a dead button.
export async function listSessions(): Promise<SessionSummary[]> {
  const { data } = await client.sessions.list();
  return data
    .filter((session) => session.agent.id === AGENT_ID && session.state !== "closed")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(toSummary);
}

// "New chat" in the sidebar. The session is created before the first message is sent, so its
// ID can be the useChat conversation ID from the start; the first message retitles it (see
// runTurn).
export async function createSession(): Promise<SessionSummary> {
  const session = await client.sessions.create({
    agent: AGENT_ID,
    environment: ENVIRONMENT_ID,
    title: DEFAULT_SESSION_TITLE,
    metadata: { quickstart: "chat-sdk" },
  });
  console.log(`[managed-agent] new session ${session.id}`);
  return toSummary(session);
}

// Every durable event of a session, oldest first. Persisted lifecycle events (turns, pauses)
// and every journaled message are here; token deltas and tool progress are live-only and are
// not (they fold into the messages).
export async function eventsOf(sessionId: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let page: string | undefined;
  do {
    const result = await client.sessions.events.list(sessionId, { limit: 500, ...(page !== undefined ? { page } : {}) });
    events.push(...result.data);
    page = result.nextPage ?? undefined;
  } while (page !== undefined);
  return events;
}

// What useChat expects as initial messages: id + role + text parts.
type UIMessageJSON = {
  id: string;
  role: "user" | "assistant";
  parts: { type: "text"; text: string }[];
};

// Rebuild a conversation's transcript from the session's event log -- the single source of
// truth. User and assistant messages become chat bubbles; each research turn's tool-call trace
// and "brief ready" card are re-derived from the same log (tool calls sit inside the assistant
// messages, timestamps on every message), so both survive a server restart without being
// stored anywhere (the clean-turn gate is at closeTurn below).
//
// The messages come out of `SessionProjection`, the engine's own reducer: history is not
// append-only (compaction rewrites it), and the projection folds the log exactly as a reopened
// session would. What the projection does not keep -- which turn each delivery started and how
// that turn ended -- is a second pass over the same events.
//
// Callers must have passed the session through ownedSession() first.
export async function historyOf(sessionId: string): Promise<UIMessageJSON[]> {
  const events = await eventsOf(sessionId);
  const projection = new SessionProjection(sessionId);
  // delivery id -> the turn it started; turn id -> how it ended. A turn with no end yet is
  // still running, and a still-running final turn hasn't earned its trace or card. The log
  // journals a delivered prompt ahead of its turn, so the pairing is by order: the next turn to
  // start after an external message is that message's turn (the same rule the live bridge and
  // the client's `run()` apply to the stream).
  const turnOf = new Map<string, string>();
  const endOf = new Map<string, "completed" | "cancelled" | "failed">();
  let running: string | undefined;
  let pendingDelivery: string | undefined;
  for (const event of events) {
    projection.apply(event);
    if (event.address !== "main") continue;
    if (event.type === "message.appended") {
      if (event.message.role === "user") pendingDelivery = deliveryOf(event.origin) ?? pendingDelivery;
    } else if (event.type === "turn.started") {
      running = event.turnId;
      const delivery = deliveryOf(event.origin) ?? pendingDelivery;
      if (delivery !== undefined) turnOf.set(delivery, event.turnId);
      pendingDelivery = undefined;
    } else if (event.type === "turn.ended") {
      endOf.set(event.turnId, event.reason);
      if (running === event.turnId) running = undefined;
    }
  }
  const main = projection.snapshot().agents.find((agent) => agent.address === "main");
  const messages: UIMessageJSON[] = [];
  if (!main) return messages;

  let searches = 0;
  let tools: ToolCall[] = [];
  const openCalls = new Map<string, ToolCall>();
  let turnId: string | undefined;
  let turnStartedAt = 0;
  let lastReplyAt = 0;
  let lastReplyId = "";

  const closeTurn = () => {
    // Only a cleanly ended turn gets its trailing messages -- the same `finished` gate the live
    // bridge applies (src/managed-agents.ts) -- and in the same order: trace, then card.
    if (turnId === undefined || endOf.get(turnId) !== "completed" || !lastReplyId) return;
    if (tools.length > 0) {
      messages.push({ id: `${lastReplyId}-tools`, role: "assistant", parts: [{ type: "text", text: toolsFence(tools) }] });
    }
    if (searches === 0) return;
    const seconds = Math.max(0, Math.round((lastReplyAt - turnStartedAt) / 1000));
    messages.push({
      id: `${lastReplyId}-card`,
      role: "assistant",
      parts: [{ type: "text", text: cardFence({ searches, seconds, sessionId }) }],
    });
  };

  main.messages.forEach((message: Message, index: number) => {
    const origin: PromptOrigin | undefined = main.origins[index];
    const id = `m${index}`;
    switch (message.role) {
      case "user": {
        // Only prompts that came through the chat are bubbles, and those are the ones that
        // answer a delivery. Everything else the engine journals as a user-role message --
        // compaction summaries, injected reminders -- is context for the model, not something
        // the colleague said.
        const delivery = deliveryOf(origin);
        if (delivery === undefined) return;
        closeTurn();
        searches = 0;
        tools = [];
        openCalls.clear();
        turnId = turnOf.get(delivery);
        turnStartedAt = message.timestamp;
        lastReplyId = "";
        const text = userTextOf(message.content);
        if (text) messages.push({ id, role: "user", parts: [{ type: "text", text }] });
        return;
      }
      case "assistant": {
        // Raw (untrimmed), matching what the live bridge streams -- see rawTextOf.
        const text = rawTextOf(message.content);
        if (text.trim()) {
          messages.push({ id, role: "assistant", parts: [{ type: "text", text }] });
          lastReplyAt = message.timestamp;
          lastReplyId = id;
        }
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          if (part.name === SEARCH_TOOL) searches++;
          const call = toolCallOf(part.name, part.arguments);
          tools.push(call);
          openCalls.set(part.id, call);
        }
        return;
      }
      case "toolResult": {
        const call = openCalls.get(message.toolCallId);
        openCalls.delete(message.toolCallId);
        if (message.isError && call) call.error = true;
        return;
      }
    }
  });
  // Earlier turns are closed by the next user message; a still-running final turn is held
  // back by the log itself (its turn has no end, so closeTurn's gate refuses it).
  if (running === undefined) closeTurn();
  return messages;
}

export { ownedSession };
