// The bot <-> operon managed-agents bridge. Two moves, both against one session: deliver a
// message and follow the turn it starts, or answer the questions a paused turn is waiting on
// and follow the continuation. Following means holding the session's event stream open and
// folding what happens into calls on a `Surface` -- the thing a chat platform gives us to write
// with. The surfaces (src/surfaces.ts) are Linear activities and GitHub comments; the tests use
// a recorder. Nothing here knows which.
//
// The shape is the chat-sdk example's bridge (../../chat-sdk/src/managed-agents.ts) with two
// changes: a turn's interruptions are surfaced as a question instead of a dead end, and a
// resume is followed the same way a delivery is.

import type { AgentEvent, InterruptAnswer, PendingRunInterrupt, PromptOrigin } from "operon-agents";
import { ManagedAgentsClient, ManagedApiClientError } from "operon-managed-agents/client";
import type { ManagedSession } from "operon-managed-agents/protocol";
import { PR_TOOL } from "../server/agent-config.ts";
import { renderPending } from "./answers.ts";

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
  | { readonly status: "waiting"; readonly pending: readonly PendingRunInterrupt[] }
  | { readonly status: "failed" | "cancelled" | "dropped" | "gone" | "refused" };

// The event stream EOF'd mid-turn while the session keeps working server-side -- distinct from a
// failed turn: the work continues, only our view of it is gone.
class StreamDropped extends Error {
  constructor() {
    super("event stream ended before the turn completed");
  }
}

// Session IDs are derived from platform IDs (src/flows.ts), so never trust one blindly: it must
// look like an ID (it becomes an API path segment), resolve, and belong to this bot's agent.
export async function ownedSession(sessionId: string): Promise<ManagedSession | null> {
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(sessionId)) return null;
  try {
    const session = await client.sessions.retrieve(sessionId);
    if (session.agent.id !== AGENT_ID) return null;
    if (session.state === "closed") return null;
    return session;
  } catch (err) {
    // Only a definitive rejection means the session is gone; a transient failure must not.
    if (err instanceof ManagedApiClientError && (err.status === 400 || err.status === 404 || err.status === 410)) return null;
    throw err;
  }
}

// Serialize turns per session: one stream reader, replies in order. Messages from Linear and
// GitHub can land on the same session at the same time; the server queues the input, this
// queues the observers.
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
    run(surface, sessionId, async () => {
      const receipt = await client.sessions.messages.create(sessionId, { input: text, mode: "follow_up" });
      return { steerId: receipt.steerId };
    }),
  );
}

/** Answer the paused turn's interruptions and follow the continuation. */
export function resume(surface: Surface, sessionId: string, answers: Readonly<Record<string, InterruptAnswer>>): Promise<TurnOutcome> {
  return enqueue(sessionId, () =>
    run(surface, sessionId, async () => {
      await client.sessions.resume(sessionId, answers);
      return { resumed: true };
    }),
  );
}

type Anchor = { readonly steerId: string } | { readonly resumed: true };

async function run(surface: Surface, sessionId: string, send: () => Promise<Anchor>): Promise<TurnOutcome> {
  try {
    return await follow(surface, sessionId, send);
  } catch (err) {
    if (err instanceof ManagedApiClientError && err.status === 409) {
      // The server refused the input: the session is paused on a question this message did
      // not answer (a race with another reply), or a resume raced a delivery.
      await surface.error("I'm waiting for an answer to my last question; reply to it and I'll continue.").catch(() => {});
      return { status: "refused" };
    }
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

// The steer a journaled user message -- or the turn it started -- came in as. Undefined for a
// message that went through no bus (a reminder, a compaction summary): those answer nothing of ours.
function steerOf(origin: PromptOrigin | undefined): string | undefined {
  return origin !== undefined && "steerId" in origin ? origin.steerId : undefined;
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

function resultTextOf(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  return rawTextOf(content).trim();
}

/** The first pull request URL in a text, if any. */
export function pullRequestUrlIn(text: string): string | undefined {
  return /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(text)?.[0];
}

// Stream first, then send: the stream resumes after the newest durable event, so the whole turn
// is seen live. `send` returns how to recognize our turn on the stream -- the delivery a fresh
// turn will name, or "resumed": a continuation keeps the paused turn's id and emits no
// turn.started, and nothing else can run on a paused session, so every event until the next
// turn.ended is ours.
async function follow(surface: Surface, sessionId: string, send: () => Promise<Anchor>): Promise<TurnOutcome> {
  const newest = await client.sessions.events.list(sessionId, { limit: 1, order: "desc" });
  const after = newest.data[0]?.eventId;
  const controller = new AbortController();
  const stream = await client.sessions.events.stream(sessionId, { signal: controller.signal, ...(after !== undefined ? { after } : {}) });
  let anchor: Anchor;
  try {
    anchor = await send();
  } catch (err) {
    controller.abort();
    throw err;
  }

  let currentTurn: string | undefined;
  let ourTurn: string | undefined;
  let claimNextTurn = false;
  const resumed = "resumed" in anchor;
  const steerId = "steerId" in anchor ? anchor.steerId : undefined;
  // Tool call id -> trace, so the result can report by name; PR URLs seen in this turn.
  const calls = new Map<string, ToolTrace>();
  let linked: string | undefined;
  const ours = (event: AgentEvent & { readonly turnId?: string }) => resumed || (ourTurn !== undefined && event.turnId === ourTurn);

  try {
    for await (const event of stream) {
      if (event.address !== "main") continue;
      if (!resumed) {
        // ── Anchoring: find the turn that took our delivery ──
        if (event.type === "turn.started") {
          currentTurn = event.turnId;
          if (claimNextTurn || steerOf(event.origin) === steerId) {
            ourTurn = event.turnId;
            claimNextTurn = false;
          }
          continue;
        }
        if (event.type === "message.appended" && event.message.role === "user") {
          if (ourTurn === undefined && steerOf(event.origin) === steerId) {
            if (currentTurn !== undefined) ourTurn = currentTurn;
            else claimNextTurn = true;
          }
          continue;
        }
        // A previous turn is still finishing: its events are not ours to render.
        if (ourTurn === undefined) continue;
      }

      switch (event.type) {
        case "message.appended": {
          if (event.message.role !== "assistant" || (!resumed && ourTurn !== currentTurn)) break;
          const text = rawTextOf(event.message.content).trim();
          const callsTools = event.message.content.some((part) => part.type === "toolCall");
          if (!text) break;
          // Text alongside tool calls is the model thinking out loud; text alone ends the turn.
          if (callsTools) await surface.thought(text);
          else {
            await surface.respond(text);
            const url = pullRequestUrlIn(text);
            if (url && url !== linked) {
              linked = url;
              await surface.link("Pull request", url);
            }
          }
          break;
        }
        case "tool.call.started": {
          const call: ToolTrace = { id: event.toolCallId, name: event.toolName, hint: hintOf(event.args), status: "running" };
          calls.set(event.toolCallId, call);
          await surface.action(call);
          break;
        }
        case "tool.result": {
          const started = calls.get(event.toolCallId);
          const text = resultTextOf(event.result);
          const call: ToolTrace = {
            id: event.toolCallId,
            name: started?.name ?? event.toolName,
            hint: started?.hint ?? "",
            status: event.isError ? "error" : "done",
            result: truncate(text, 400),
          };
          calls.set(event.toolCallId, call);
          await surface.action(call);
          // The PR tool names the PR it opened; link it as soon as it exists rather than waiting
          // for the model to repeat the URL.
          if (event.toolName === PR_TOOL && !event.isError) {
            const url = pullRequestUrlIn(text);
            if (url && url !== linked) {
              linked = url;
              await surface.link("Pull request", url);
            }
          }
          break;
        }
        case "turn.step.retrying":
          if (ours(event)) console.warn(`[bridge] ${sessionId} retry ${event.attempt}/${event.maxAttempts}: ${event.reason ?? ""}`);
          break;
        case "error":
          console.warn(`[bridge] ${sessionId} error: ${event.message}`);
          break;
        case "turn.paused": {
          // The turn stopped on a question or an approval and the session is now interrupted:
          // nothing runs until someone answers. The question goes to the thread, and the next
          // message there answers it (src/flows.ts). No turn.ended follows a pause.
          if (!resumed && ourTurn !== currentTurn) break;
          currentTurn = undefined;
          await surface.ask(renderPending(event.pending));
          return { status: "waiting", pending: event.pending };
        }
        case "turn.ended": {
          currentTurn = undefined;
          if (!ours(event)) break;
          if (event.reason === "completed") return { status: "completed" };
          if (event.reason === "cancelled") {
            await surface.error("I was stopped before finishing.");
            return { status: "cancelled" };
          }
          await surface.error(`The turn failed${event.error ? `: ${truncate(event.error, 300)}` : ""}.`);
          return { status: "failed" };
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
