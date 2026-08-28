/**
 * `run()` — send an input and wait for the agent to be done with it.
 *
 * The protocol underneath is asynchronous and cannot be otherwise: a turn outlives any request,
 * survives the client disconnecting, and can be started by something that is not a client at all.
 * But "send this and tell me when it's finished" is what most callers actually want, and writing
 * that loop correctly is harder than it looks. The traps, in the order people hit them:
 *
 *  1. The stream must be opened BEFORE the input is sent, or what happens in between is only in
 *     the replay — and the ordering is still the only way to be sure of seeing it live.
 *  2. The stream begins with history. On a session that has run before, the first `turn.ended`
 *     to arrive is an OLD one; ending on it returns the previous answer for the new question.
 *     Nothing counts until the turn that took our delivery is known, and only that turn's end
 *     is an ending.
 *  3. Idle is transient. A session goes idle between parallel tool executions and while waiting
 *     for an answer from you; breaking on the first idle ends the loop mid-conversation.
 *  4. A pause that needs an answer is not an ending. Treating it as one leaves the agent waiting
 *     forever for a reply nobody will send.
 *  5. Waiting forever is also wrong. Without a handler the correct move is to fail loudly, not
 *     to hang — a caller that cannot answer approvals should learn that immediately.
 *
 * Anthropic's Managed Agents documentation devotes a section to warning about the same loop
 * ("Do not break on session.status_idle alone"). A hazard that needs its own documentation
 * section is one the library should absorb.
 */
import type { AgentEvent } from "operon-agents";
import type { ManagedAgentsClient } from "./client.ts";
import type { CreateManagedMessageRequest, ManagedSession } from "../protocol/types.ts";

/** A pause the agent cannot get past without an answer from the caller. */
export interface RunInterruptRequest {
  readonly sessionId: string;
  /** The pending approvals / tool-input requests, as reported by the session. */
  readonly pending: readonly unknown[];
}

export interface RunOptions {
  /**
   * Answer a durable interruption so the run can continue. Receives the pending requests and
   * returns the answers keyed the way `sessions.resume` expects.
   *
   * Omitting it is a statement that this caller never expects to be asked. If the agent does ask,
   * `run` rejects rather than waiting — a hang here is indistinguishable from a slow model, and
   * would be diagnosed hours later.
   */
  readonly onInterrupt?: (request: RunInterruptRequest) => Promise<Record<string, unknown>>;
  /** Observe events as they arrive. Purely informational; `run` handles control flow. */
  readonly onEvent?: (event: AgentEvent) => void;
  readonly signal?: AbortSignal;
  /** Give up after this long with no terminal state. Off by default. */
  readonly timeoutMs?: number;
}

export interface RunResult {
  readonly sessionId: string;
  /** Every event seen while running, in arrival order. */
  readonly events: readonly AgentEvent[];
  /** The last assistant text, when the run produced any. */
  readonly output?: string;
  /** How many interruptions were answered along the way. */
  readonly interruptionsAnswered: number;
  readonly session: ManagedSession;
}

export class RunInterruptedError extends Error {
  readonly sessionId: string;
  readonly pending: readonly unknown[];

  constructor(sessionId: string, pending: readonly unknown[]) {
    super(
      `session "${sessionId}" is waiting for an answer, but run() was called without onInterrupt. ` +
        `Pass onInterrupt to answer it, or use the event stream directly.`,
    );
    this.name = "RunInterruptedError";
    this.sessionId = sessionId;
    this.pending = pending;
  }
}

export class RunTimeoutError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, timeoutMs: number) {
    super(`session "${sessionId}" did not finish within ${String(timeoutMs)}ms`);
    this.name = "RunTimeoutError";
    this.sessionId = sessionId;
  }
}

export async function run(
  client: ManagedAgentsClient,
  sessionId: string,
  input: CreateManagedMessageRequest | string,
  options: RunOptions = {},
): Promise<RunResult> {
  const request: CreateManagedMessageRequest = typeof input === "string" ? { input } : input;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer =
    options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs);

  const events: AgentEvent[] = [];
  let interruptionsAnswered = 0;
  let output: string | undefined;
  let timedOut = false;

  let iterator: AsyncIterator<AgentEvent> | undefined;
  try {
    // Trap 1: open first, then send. Reversing these can drop everything in between.
    const stream = await client.sessions.events.stream(sessionId, { signal: controller.signal });
    iterator = stream[Symbol.asyncIterator]();
    const { deliveryId } = await client.sessions.messages.create(sessionId, request);

    // Trap 2: which turn is ours. Unknown until the delivery shows up — as the origin of a
    // fresh `turn.started`, or as a `message.appended` inside a turn already running (a steer).
    let currentTurn: string | undefined;
    let ourTurn: string | undefined;
    // After answering a pause, the continuation is ours whatever id it runs under.
    let claimNextTurn = false;

    for (;;) {
      let sawTerminal = false;
      for (;;) {
        let next: IteratorResult<AgentEvent>;
        try {
          next = await iterator.next();
        } catch (error) {
          if (controller.signal.aborted) break;
          throw error;
        }
        if (next.done) break;
        const event = next.value;
        events.push(event);
        options.onEvent?.(event);
        if (event.address !== "main") continue;

        if (event.type === "turn.started") {
          currentTurn = event.turnId;
          if (claimNextTurn || deliveryOf(event.origin) === deliveryId) {
            ourTurn = event.turnId;
            claimNextTurn = false;
          }
          continue;
        }
        if (event.type === "message.appended") {
          if (ourTurn === undefined && deliveryOf(event.origin) === deliveryId) {
            // Inside a turn: a steer, and that turn is ours. Between turns: the prompt was
            // journaled ahead of its turn, so the next one to start is ours.
            if (currentTurn !== undefined) ourTurn = currentTurn;
            else claimNextTurn = true;
          }
          if (ourTurn !== undefined && ourTurn === currentTurn && event.message.role === "assistant") {
            const text = textOf(event.message.content);
            if (text !== undefined) output = text;
          }
          continue;
        }
        // Traps 3 and 4: only OUR turn ending is an ending, and even then only if nothing is
        // waiting on us — the interruption check below decides which of the two this is.
        if (event.type === "turn.ended") {
          const ours = ourTurn !== undefined && event.turnId === ourTurn;
          currentTurn = undefined;
          if (ours) {
            sawTerminal = true;
            break;
          }
        }
      }
      if (controller.signal.aborted) {
        if (options.timeoutMs !== undefined && options.signal?.aborted !== true) timedOut = true;
        break;
      }
      if (!sawTerminal) break;

      const pending = (await client.sessions.interruptions(sessionId)).data;
      if (pending.length === 0) break;

      // Trap 5: no handler means fail now, loudly, rather than wait on an answer that is not coming.
      if (options.onInterrupt === undefined) throw new RunInterruptedError(sessionId, pending);

      const answers = await options.onInterrupt({ sessionId, pending });
      // The stream stays open across the pause, so the continuation cannot be missed.
      claimNextTurn = true;
      await client.sessions.resume(sessionId, answers as never);
      interruptionsAnswered += 1;
    }

    if (timedOut) throw new RunTimeoutError(sessionId, options.timeoutMs!);
    const session = await client.sessions.retrieve(sessionId);
    return {
      sessionId,
      events,
      ...(output !== undefined ? { output } : {}),
      interruptionsAnswered,
      session,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
    await iterator?.return?.(undefined).catch(() => undefined);
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
    .map((part) => part.text);
  return parts.length === 0 ? undefined : parts.join("");
}

/**
 * The delivery a journaled prompt — or the turn it started — came in as, on whichever origin it
 * was filed under: `user` for the caller's own words, `external` for a relayed party's. Undefined
 * for everything else in the user role (reminders, compaction summaries): those answer no delivery.
 */
function deliveryOf(origin: { readonly kind: string; readonly deliveryId?: string } | undefined): string | undefined {
  return origin?.kind === "user" || origin?.kind === "user_follow_up" || origin?.kind === "external"
    ? origin.deliveryId
    : undefined;
}
