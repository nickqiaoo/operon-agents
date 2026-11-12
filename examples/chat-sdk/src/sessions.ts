// The sidebar's data source. There is no database: managed sessions ARE the conversation
// store. Listing, creating, and replaying a chat are all plain API calls against /v1/sessions
// -- restart the chat server and every conversation is still here.

import type { ManagedEventResource, ManagedSessionResource } from "operon-managed-agents/protocol";
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
  userTextOf,
} from "./managed-agents.ts";

export type SessionSummary = {
  id: string;
  title: string;
  status: string;
  created_at: string;
};

function toSummary(session: ManagedSessionResource): SessionSummary {
  return {
    id: session.id,
    title: session.title || DEFAULT_SESSION_TITLE,
    status: session.status,
    created_at: session.created_at,
  };
}

// Sessions for this app's agent only, newest first. The managed API lists every session on the
// server; the agent filter is ours, and archived or terminated ones are left out because
// ownedSession would reject them anyway -- a sidebar entry for one would just be a dead button.
export async function listSessions(): Promise<SessionSummary[]> {
  const { data } = await client.sessions.list({ limit: 100, order: "desc" });
  return data
    .filter((session) => session.agent.id === AGENT_ID && session.archived_at === null && session.status !== "terminated")
    .slice(0, 50)
    .map(toSummary);
}

// "New chat" in the sidebar. The session is created before the first message is sent, so its
// ID can be the useChat conversation ID from the start; the first message retitles it (see
// runTurn).
export async function createSession(): Promise<SessionSummary> {
  const session = await client.sessions.create({
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
    title: DEFAULT_SESSION_TITLE,
    metadata: { quickstart: "chat-sdk" },
  });
  console.log(`[managed-agent] new session ${session.id}`);
  return toSummary(session);
}

// A session's event history, oldest first: every message sent and every event the session
// emitted. Live previews (`event_start` / `event_delta`) are never in it -- they fold into the
// agent.message each one previewed.
export async function eventsOf(sessionId: string): Promise<ManagedEventResource[]> {
  const events: ManagedEventResource[] = [];
  let page: string | undefined;
  do {
    const result = await client.sessions.events.list(sessionId, { limit: 500, order: "asc", ...(page !== undefined ? { page } : {}) });
    events.push(...result.data);
    page = result.next_page ?? undefined;
  } while (page !== undefined);
  return events;
}

// What useChat expects as initial messages: id + role + text parts.
type UIMessageJSON = {
  id: string;
  role: "user" | "assistant";
  parts: { type: "text"; text: string }[];
};

// Rebuild a conversation's transcript from the session's event history -- the single source of
// truth. Each user.message and agent.message becomes a chat bubble; each research turn's
// tool-call trace and "brief ready" card are re-derived from the same history (agent.tool_use /
// agent.tool_result, and `processed_at` for the timing), so both survive a server restart
// without being stored anywhere.
//
// A turn here is everything from one user.message to the next. It earns its trailing trace and
// card only if it ended cleanly -- an end_turn idle with no session.error -- the same `finished`
// gate the live bridge applies (src/managed-agents.ts), so live and replayed transcripts match.
//
// Callers must have passed the session through ownedSession() first.
export async function historyOf(sessionId: string): Promise<UIMessageJSON[]> {
  const events = await eventsOf(sessionId);
  const messages: UIMessageJSON[] = [];

  let searches = 0;
  let tools: ToolCall[] = [];
  const openCalls = new Map<string, ToolCall>();
  let turnStartedAt = 0;
  let lastReplyAt = 0;
  let lastReplyId = "";
  let ended = false;
  let failed = false;

  const closeTurn = () => {
    // Trace, then card -- the order the live bridge posts them in.
    if (!ended || failed || !lastReplyId) return;
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
  const at = (event: ManagedEventResource): number => (event.processed_at === null ? 0 : Date.parse(event.processed_at));

  for (const event of events) {
    switch (event.type) {
      case "user.message": {
        closeTurn();
        searches = 0;
        tools = [];
        openCalls.clear();
        turnStartedAt = at(event);
        lastReplyId = "";
        ended = false;
        failed = false;
        const text = userTextOf(event.content);
        if (text) messages.push({ id: event.id, role: "user", parts: [{ type: "text", text }] });
        break;
      }
      case "agent.message": {
        // Raw (untrimmed), matching what the live bridge streams -- see rawTextOf.
        const text = rawTextOf(event.content);
        if (text.trim()) {
          messages.push({ id: event.id, role: "assistant", parts: [{ type: "text", text }] });
          lastReplyAt = at(event);
          lastReplyId = event.id;
        }
        break;
      }
      case "agent.tool_use": {
        // Announced only to ask about it: the pause, not a call that ran (see the bridge).
        if (event.evaluated_permission === "ask") break;
        if (event.name === SEARCH_TOOL) searches++;
        const call = toolCallOf(event.name, event.input);
        tools.push(call);
        openCalls.set(event.id, call);
        break;
      }
      case "agent.tool_result": {
        const call = openCalls.get(event.tool_use_id);
        openCalls.delete(event.tool_use_id);
        if (event.is_error && call) call.error = true;
        break;
      }
      case "session.error":
        failed = true;
        break;
      case "session.status_idle":
        if (event.stop_reason.type === "end_turn") ended = true;
        break;
    }
  }
  // Earlier turns are closed by the next user message; a still-running final turn has no idle
  // yet, so closeTurn's gate refuses it.
  closeTurn();
  return messages;
}

export { ownedSession };
