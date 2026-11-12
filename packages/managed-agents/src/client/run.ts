/**
 * `run()` — send a message and wait for the agent to be done with it.
 *
 * The protocol underneath is asynchronous and cannot be otherwise: a turn outlives any request,
 * survives the client disconnecting, and can be started by something that is not a client at all.
 * But "send this and tell me when it's finished" is what most callers actually want, and writing
 * that loop correctly is harder than it looks. The traps, in the order people hit them:
 *
 *  1. The stream is live-only, so it must be opened BEFORE the message is sent, or what happens
 *     in between is never seen.
 *  2. A session that was already busy goes idle at the end of the turn it was on. That idle is
 *     not ours. Nothing counts until our own message comes back processed — the moment it went
 *     into the conversation — and only the idle after that is an ending.
 *  3. A `requires_action` idle is not an ending. Treating it as one leaves the agent waiting
 *     forever for a confirmation nobody will send.
 *  4. Waiting forever is also wrong. Without a handler the correct move is to fail loudly, not
 *     to hang — a caller that cannot answer confirmations should learn that immediately.
 *
 * Anthropic's Managed Agents documentation devotes a section to warning about the same loop
 * ("Do not break on session.status_idle alone"). A hazard that needs its own documentation
 * section is one the library should absorb.
 */
import type { ManagedAgentsClient } from "./client.ts";
import type {
  ManagedEventResource,
  ManagedInputEvent,
  ManagedSessionResource,
  TextBlock,
} from "../protocol/types.ts";

export interface RunInterruptRequest {
  readonly sessionId: string;
  /** The `agent.tool_use` / `agent.custom_tool_use` events the session is blocked on. */
  readonly pending: readonly ManagedEventResource[];
}

export interface RunOptions {
  /**
   * Answer what the session is blocked on: return the `user.tool_confirmation` /
   * `user.custom_tool_result` events to send, one per pending event.
   *
   * Omitting it is a statement that this caller never expects to be asked. If the agent does ask,
   * `run` rejects rather than waiting — a hang here is indistinguishable from a slow model, and
   * would be diagnosed hours later.
   */
  readonly onInterrupt?: (request: RunInterruptRequest) => Promise<readonly ManagedInputEvent[]>;
  /** Observe events as they arrive. Purely informational; `run` handles control flow. */
  readonly onEvent?: (event: ManagedEventResource) => void;
  readonly signal?: AbortSignal;
  /** Give up after this long with no terminal state. Off by default. */
  readonly timeoutMs?: number;
}

export interface RunResult {
  readonly sessionId: string;
  /** Every event seen while running, in arrival order. */
  readonly events: readonly ManagedEventResource[];
  /** The last agent text, when the run produced any. */
  readonly output?: string;
  /** How many times the session was unblocked along the way. */
  readonly interruptionsAnswered: number;
  readonly session: ManagedSessionResource;
}

export class RunInterruptedError extends Error {
  readonly sessionId: string;
  readonly pending: readonly ManagedEventResource[];

  constructor(sessionId: string, pending: readonly ManagedEventResource[]) {
    super(
      `session "${sessionId}" is waiting for a confirmation, but run() was called without onInterrupt. ` +
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
  input: string | readonly TextBlock[],
  options: RunOptions = {},
): Promise<RunResult> {
  const content = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(abort, options.timeoutMs);

  const events: ManagedEventResource[] = [];
  const seen = new Map<string, ManagedEventResource>();
  let interruptionsAnswered = 0;
  let output: string | undefined;
  let iterator: AsyncIterator<ManagedEventResource> | undefined;
  try {
    // Trap 1: subscribe first, then send.
    const stream = await client.sessions.events.stream(sessionId, { signal: controller.signal });
    iterator = stream[Symbol.asyncIterator]();
    const sent = await client.sessions.events.send(sessionId, { events: [{ type: "user.message", content }] });
    const messageId = sent.data[0]!.id;
    let ours = false;
    for (;;) {
      let next: IteratorResult<ManagedEventResource>;
      try {
        next = await iterator.next();
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
      if (next.done) break;
      const event = next.value;
      events.push(event);
      seen.set(event.id, event);
      options.onEvent?.(event);
      // Trap 2: only after our message is in the conversation does an idle mean us.
      if (event.id === messageId && event.processed_at !== null) {
        ours = true;
        continue;
      }
      if (!ours) continue;
      if (event.type === "agent.message") {
        const text = event.content.map((block) => block.text).join("");
        if (text !== "") output = text;
        continue;
      }
      if (event.type !== "session.status_idle") continue;
      if (event.stop_reason.type === "end_turn") {
        const session = await client.sessions.retrieve(sessionId);
        return { sessionId, events, ...(output !== undefined ? { output } : {}), interruptionsAnswered, session };
      }
      // Traps 3 and 4: blocked is not done, and an unanswerable block fails now.
      const pending = event.stop_reason.event_ids.map((id) => seen.get(id)).filter((e): e is ManagedEventResource => e !== undefined);
      if (options.onInterrupt === undefined) throw new RunInterruptedError(sessionId, pending);
      const answers = await options.onInterrupt({ sessionId, pending });
      await client.sessions.events.send(sessionId, { events: answers });
      interruptionsAnswered += 1;
    }
    if (options.signal?.aborted === true) throw options.signal.reason;
    if (controller.signal.aborted && options.timeoutMs !== undefined) throw new RunTimeoutError(sessionId, options.timeoutMs);
    throw new Error(`the event stream for session "${sessionId}" ended before the run did`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
    await iterator?.return?.(undefined).catch(() => undefined);
  }
}
