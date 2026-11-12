// The bot <-> operon managed-agents bridge. Two moves, both against one session: deliver a
// message and follow the turn it starts, or answer the questions a paused turn is waiting on
// and follow the continuation. Following means holding the session's event stream open and
// folding what happens into calls on a `Surface` -- the thing a chat platform gives us to write
// with. The surfaces (src/surfaces.ts) are Linear activities and GitHub comments; the tests use
// a recorder. Nothing here knows which.
//
// The shape is the chat-sdk example's bridge (../../chat-sdk/src/managed-agents.ts) with two
// changes: a `requires_action` pause is surfaced as a question instead of a dead end, and the
// answers are followed the same way a message is.

import { ManagedAgentsClient, ManagedApiClientError } from "operon-managed-agents/client";
import type { ManagedInputEvent, ManagedSessionResource } from "operon-managed-agents/protocol";
import { PR_TOOL } from "../server/agent-config.ts";
import { isBlocking, renderPending, type BlockingEvent } from "./answers.ts";

export const MANAGED_URL = process.env.OPERON_MANAGED_URL ?? "http://127.0.0.1:8088/v1";
/** The agent sessions are created against (server/agent-config.ts). Sessions of any other agent
 *  on the same server are invisible to this bot. */
export const AGENT_ID = process.env.OPERON_AGENT ?? "engineer";

export const client = new ManagedAgentsClient({
  baseUrl: MANAGED_URL,
  ...(process.env.MANAGED_API_KEY ? { apiKey: process.env.MANAGED_API_KEY } : {}),
});

/** One tool call as the surfaces show it: started, then finished with a short result. */
export interface ToolTrace {
  readonly id: string;
  readonly name: string;
  /** A short extract of the input: the command, the path, the query. May be empty. */
  readonly hint: string;
  readonly status: "running" | "done" | "error";
  /** Finished calls only: the first lines of the result. */
  readonly result?: string;
}

/**
 * What a platform lets the bridge write. Linear maps these onto agent activities one to one;
 * GitHub folds thoughts and actions into the next comment. Every method may be called many
 * times per turn except that a turn ends with exactly one of respond / ask / error.
 */
export interface Surface {
  /** "I'm on it": Linear needs a sign of life within seconds of a session starting. */
  ack(status: string): Promise<void>;
  /** Interim assistant text -- what the model said before calling tools. */
  thought(markdown: string): Promise<void>;
  action(call: ToolTrace): Promise<void>;
  /** The turn's final text. */
  respond(markdown: string): Promise<void>;
  /** The turn paused on a question; the next message in the thread answers it. */
  ask(markdown: string): Promise<void>;
  error(markdown: string): Promise<void>;
  /** A resource the turn produced (the pull request). */
  link(label: string, url: string): Promise<void>;
}

export type TurnOutcome =
  | { readonly status: "completed" }
  | { readonly status: "waiting"; readonly pending: readonly BlockingEvent[] }
  | { readonly status: "failed" | "dropped" | "gone" | "refused" };

// The event stream EOF'd mid-turn while the session keeps working server-side -- distinct from a
// failed turn: the work continues, only our view of it is gone.
class StreamDropped extends Error {
  constructor() {
    super("event stream ended before the turn completed");
  }
}

// Session IDs are derived from platform IDs (src/flows.ts), so never trust one blindly: it must
// look like an ID (it becomes an API path segment), resolve, and belong to this bot's agent.
export async function ownedSession(sessionId: string): Promise<ManagedSessionResource | null> {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(sessionId)) return null;
  try {
    const session = await client.sessions.retrieve(sessionId);
    if (session.agent.id !== AGENT_ID) return null;
    if (session.archived_at !== null || session.status === "terminated") return null;
    return session;
  } catch (err) {
    // Only a definitive rejection means the session is gone; a transient failure must not.
    if (err instanceof ManagedApiClientError && (err.status === 400 || err.status === 404 || err.status === 410)) return null;
    throw err;
  }
}

// Serialize turns per session: one stream reader, replies in order. Messages from Linear and
// GitHub can land on the same session at the same time; the server takes the input in order,
// this queues the observers.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(sessionId: string, turn: () => Promise<T>): Promise<T> {
  const prev = queues.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(turn);
  queues.set(sessionId, next);
  next
    .catch(() => {})
    .finally(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
  return next;
}

/** Send `text` as the session's user and follow the turn it starts. Never rejects: every
 *  failure ends in a message on the surface and an outcome. */
export function deliver(surface: Surface, sessionId: string, text: string): Promise<TurnOutcome> {
  return enqueue(sessionId, () =>
    run(surface, sessionId, [], async () => {
      const sent = await client.sessions.events.send(sessionId, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
      return { messageId: sent.data[0]!.id };
    }),
  );
}

/** Answer what the paused session is blocked on and follow the continuation. */
export function resume(surface: Surface, sessionId: string, pending: readonly BlockingEvent[], answers: readonly ManagedInputEvent[]): Promise<TurnOutcome> {
  return enqueue(sessionId, () =>
    run(surface, sessionId, pending, async () => {
      await client.sessions.events.send(sessionId, { events: answers });
      return { resumed: true };
    }),
  );
}

/**
 * What a session is blocked on, if it is paused: the events its newest `requires_action` idle
 * names. Empty when it is not paused.
 */
export async function pendingActions(sessionId: string): Promise<BlockingEvent[]> {
  const { data } = await client.sessions.events.list(sessionId, { limit: 200, order: "desc" });
  const status = data.find((event) => event.type.startsWith("session.status_"));
  if (status?.type !== "session.status_idle" || status.stop_reason.type !== "requires_action") return [];
  const ids = new Set(status.stop_reason.event_ids);
  return data.filter((event): event is BlockingEvent => ids.has(event.id) && isBlocking(event)).reverse();
}

type Anchor = { readonly messageId: string } | { readonly resumed: true };

async function run(surface: Surface, sessionId: string, pending: readonly BlockingEvent[], send: () => Promise<Anchor>): Promise<TurnOutcome> {
  try {
    return await follow(surface, sessionId, pending, send);
  } catch (err) {
    if (err instanceof StreamDropped) {
      const still = await ownedSession(sessionId).catch(() => null);
      await surface
        .error(still ? "I lost my connection to the session mid-turn; the work continues. Mention me again in a minute for the result." : "This session has ended on the server.")
        .catch(() => {});
      return { status: still ? "dropped" : "gone" };
    }
    console.error(`[bridge] ${sessionId} turn failed:`, err);
    await surface.error("Something went wrong on my side. Send that again?").catch(() => {});
    return { status: "failed" };
  }
}

export function rawTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// "Bash: git status" reads better than "Bash". Tool inputs are free-form JSON; pull the first
// human-meaningful field. Inputs can quote text from files the agent read, so surfaces render
// hints as plain text.
export function hintOf(input: unknown): string {
  const args = input as Record<string, unknown> | null | undefined;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "branch", "title", "questions"]) {
    const value = args?.[key];
    if (typeof value === "string" && value) return truncate(value.replace(/\s+/g, " "), 120);
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0] as { question?: unknown } | undefined;
      if (typeof first?.question === "string") return truncate(first.question, 120);
    }
  }
  return "";
}

function resultTextOf(content: unknown): string {
  return rawTextOf(content).trim();
}

/** The first pull request URL in a text, if any. */
export function pullRequestUrlIn(text: string): string | undefined {
  return /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(text)?.[0];
}

// Stream first, then send: the stream is live-only, so the order is what makes the whole turn
// visible. `send` returns how to recognize our turn on the stream: a message is ours once it
// comes back processed (`processed_at` set: it is in the conversation), and everything before
// that belongs to a turn already running. Answers need no anchor -- nothing runs on a paused
// session, so every event after them is the continuation (their own echo only comes once it is
// over).
async function follow(surface: Surface, sessionId: string, pending: readonly BlockingEvent[], send: () => Promise<Anchor>): Promise<TurnOutcome> {
  const controller = new AbortController();
  const stream = await client.sessions.events.stream(sessionId, { signal: controller.signal });
  let anchor: Anchor;
  try {
    anchor = await send();
  } catch (err) {
    controller.abort();
    throw err;
  }

  let ours = "resumed" in anchor;
  const messageId = "messageId" in anchor ? anchor.messageId : undefined;
  // agent.tool_use id -> trace, so the result can report by name. A call that was waiting on an
  // approval runs under the id it paused with, announced by the turn that paused.
  const calls = new Map<string, ToolTrace>(
    pending.map((event) => [event.id, { id: event.id, name: event.name, hint: hintOf(event.input), status: "running" as const }]),
  );
  // The newest agent.message, not yet placed: text followed by a tool call is the model thinking
  // out loud; text the turn ends on is the reply. agent.message carries text only, so which one
  // it was is known by what comes next.
  let said: string | undefined;
  let failure: string | undefined;
  let linked: string | undefined;
  const link = async (text: string) => {
    const url = pullRequestUrlIn(text);
    if (url && url !== linked) {
      linked = url;
      await surface.link("Pull request", url);
    }
  };
  const thinking = async () => {
    if (said === undefined) return;
    const text = said;
    said = undefined;
    await surface.thought(text);
  };

  try {
    for await (const event of stream) {
      if (!ours) {
        // ── Anchoring: wait for our message to reach the conversation ──
        if (event.type === "user.message" && event.id === messageId && event.processed_at !== null) ours = true;
        continue;
      }

      switch (event.type) {
        case "agent.message": {
          await thinking();
          const text = rawTextOf(event.content).trim();
          if (text) said = text;
          break;
        }
        case "agent.tool_use": {
          await thinking();
          // Announced only to ask about it: the pause, reported when the session goes idle.
          if (event.evaluated_permission === "ask") break;
          const call: ToolTrace = { id: event.id, name: event.name, hint: hintOf(event.input), status: "running" };
          calls.set(event.id, call);
          await surface.action(call);
          break;
        }
        case "agent.custom_tool_use":
          await thinking();
          break;
        case "agent.tool_result": {
          const started = calls.get(event.tool_use_id);
          const text = resultTextOf(event.content);
          const call: ToolTrace = {
            id: event.tool_use_id,
            name: started?.name ?? "tool",
            hint: started?.hint ?? "",
            status: event.is_error ? "error" : "done",
            result: truncate(text, 400),
          };
          calls.set(event.tool_use_id, call);
          await surface.action(call);
          // The PR tool names the PR it opened; link it as soon as it exists rather than waiting
          // for the model to repeat the URL.
          if (call.name === PR_TOOL && !event.is_error) await link(text);
          break;
        }
        case "session.error":
          console.warn(`[bridge] ${sessionId} error: ${event.error.message}`);
          failure = event.error.message;
          break;
        case "session.status_idle": {
          if (event.stop_reason.type === "requires_action") {
            // The turn stopped on a question or an approval: nothing runs until someone answers.
            // The question goes to the thread, and the next message there answers it
            // (src/flows.ts).
            await thinking();
            const ids = new Set(event.stop_reason.event_ids);
            const blocking = (await pendingActions(sessionId)).filter((entry) => ids.has(entry.id));
            await surface.ask(renderPending(blocking));
            return { status: "waiting", pending: blocking };
          }
          if (failure !== undefined) {
            await thinking();
            await surface.error(`The turn failed: ${truncate(failure, 300)}.`);
            return { status: "failed" };
          }
          if (said !== undefined) {
            const text = said;
            said = undefined;
            await surface.respond(text);
            await link(text);
          }
          return { status: "completed" };
        }
      }
    }
  } finally {
    controller.abort();
  }
  // The stream closed without our turn ending. The client reconnects on its own, so reaching
  // here means the server went away for good. The input was accepted, so don't ask for a resend.
  throw new StreamDropped();
}
