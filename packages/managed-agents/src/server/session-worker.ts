/**
 * The execution half: moves a session's inbox into its conversation, and runs it.
 *
 * A worker is not part of the API surface and does not look for work on its own terms. It
 * claims from the work table (`SessionWork`) — one row per session that has been appended to
 * or is being run — and everything it does with a session happens under that session's lease.
 * That is what lets the HTTP layer stay stateless, lets any node run any session, and lets a
 * cancel reach the node that is running a turn without anyone knowing which node that is.
 *
 * ## What "processed" means
 *
 * An input is processed once it is IN THE CONVERSATION — once the session's own record holds
 * it and the next turn, whoever runs it, will see it. That is the whole contract. Whether the
 * turn it started reaches its end is not part of it: a turn that fails or dies halfway leaves
 * the history intact up to where it stopped, the session reopens idle, and the next message
 * continues from there. Nothing is re-run, so nothing is run twice.
 *
 * ## How work arrives
 *
 * Three ways, and all lead to `run()`:
 *
 *  1. `start()`: the claim loop. Asks the table for one woken session, runs it, asks again;
 *     when there is none, waits `claimIntervalMs`. This is the only path that exists across
 *     nodes, and it is one indexed statement per ask — the same thing a queue consumer's fetch
 *     is, and the same cost when the queue is empty.
 *  2. A nudge: `drain(id)` from the API layer in the same process. Latency only — the append
 *     already woke the row, so a nudge that is lost or loses the lease race changes nothing
 *     except when the claim loop gets to it.
 *  3. The heartbeat. While a session is held, every `renew` reports whether anything was
 *     appended since the last one. That is how a message or a cancel reaches a turn already
 *     running on this node when it was accepted on another.
 *
 * ## A worker that died mid-turn
 *
 * Leaves its row held past its TTL, and a `turn.started` with no end in the log. The claim
 * loop takes such a row like any other; the first thing done under the new lease is to close
 * the turn (`turn.ended`, reason `failed`) and hand that to live subscribers — so a client
 * waiting on the turn learns it is over, instead of waiting for a message that will not come.
 */
import {
  closeOrphanedTurns,
  newAgentEventId,
  type AgentEvent,
  type AgentRecord,
  type Harness,
  type HarnessSession,
  type SessionRepository,
  type SessionStore,
} from "operon-agents";
import type { ManagedSessionMetadata, ManagedSessionMetadataStore } from "./metadata.ts";
import type { ManagedAgentRegistry, ManagedEnvironmentRegistry } from "./registries.ts";
import type { EventBroadcaster } from "./broadcast.ts";
import { DefaultAgentRegistry } from "./registries.ts";
import type { SessionWork, WorkLease } from "./work.ts";
import {
  INBOX_CURSOR_KEY,
  inboxItemId,
  readInbox,
  readInboxCursor,
  type InboxItem,
} from "./inbox.ts";

export interface SessionWorkerOptions<TContext = unknown> {
  readonly harness: Harness<TContext>;
  readonly repository: SessionRepository;
  readonly metadataStore: ManagedSessionMetadataStore;
  readonly environments: ManagedEnvironmentRegistry;
  readonly agents?: ManagedAgentRegistry<TContext>;
  /** The work table. MUST be the same one the service appends through, or nothing is ever claimed. */
  readonly work: SessionWork;
  readonly defaultAgentId?: string;
  /**
   * Heartbeat period while holding a session. MUST be comfortably below the table's TTL, and
   * it is also the latency bound for a message or cancel accepted on another node to reach a
   * turn running here — the renew is what carries it. Default 2s.
   */
  readonly renewIntervalMs?: number;
  /** How long the claim loop waits after finding nothing. Default 1s. */
  readonly claimIntervalMs?: number;
  /** How many sessions the claim loop may hold at once. Nudges are not counted. Default 16. */
  readonly concurrency?: number;
  /**
   * Where to republish this session's events for live subscribers.
   *
   * The worker is the only thing that sees an event at the moment it happens — including the
   * ones that are never written down (token deltas, warnings). Handing them to a broadcaster
   * here is what lets a subscriber elsewhere see them at all.
   */
  readonly broadcaster?: EventBroadcaster;
  /**
   * A run that threw — the environment would not resolve, the model was unreachable. The lease
   * is released either way; what was not processed stays in the inbox, and the next append
   * to that session wakes it again. Default: `console.error`.
   */
  readonly onError?: (error: unknown, sessionId: string) => void;
}

/**
 * One in-flight run of a session: nudges and heartbeats raise its wake, `drain` awaits its end.
 */
interface Running {
  readonly wake: Wakeup;
  readonly done: Promise<void>;
}

export class SessionWorker<TContext = unknown> {
  private readonly harness: Harness<TContext>;
  private readonly repository: SessionRepository;
  private readonly metadata: ManagedSessionMetadataStore;
  private readonly environments: ManagedEnvironmentRegistry;
  private readonly agents: ManagedAgentRegistry<TContext>;
  private readonly work: SessionWork;
  private readonly renewIntervalMs: number;
  private readonly claimIntervalMs: number;
  private readonly concurrency: number;
  private readonly broadcaster: EventBroadcaster | undefined;
  private readonly onError: (error: unknown, sessionId: string) => void;
  private readonly running = new Map<string, Running>();
  /** Runs the claim loop started, counted synchronously so the cap is exact; nudges are not. */
  private claimed = 0;
  private claiming = false;
  private stopping = false;
  private interruptPause: (() => void) | undefined;

  constructor(options: SessionWorkerOptions<TContext>) {
    this.harness = options.harness;
    this.repository = options.repository;
    this.metadata = options.metadataStore;
    this.environments = options.environments;
    this.agents = options.agents ?? new DefaultAgentRegistry(options.defaultAgentId ?? "default");
    this.work = options.work;
    this.renewIntervalMs = options.renewIntervalMs ?? 2_000;
    this.claimIntervalMs = options.claimIntervalMs ?? 1_000;
    this.concurrency = options.concurrency ?? 16;
    this.broadcaster = options.broadcaster;
    this.onError = options.onError ?? ((error, sessionId) => { console.error(`session ${sessionId}:`, error); });
  }

  /** Begin claiming. Without this a worker only runs what it is nudged about in-process. */
  start(): void {
    if (this.claiming) return;
    this.claiming = true;
    void this.claimLoop();
  }

  /**
   * Stop claiming, end every run, release every lease. Runs are ended by closing the harness
   * (which aborts their turns) and told to go no further, so the leases come back promptly
   * and another node can take the sessions over without waiting out a TTL.
   */
  async stop(): Promise<void> {
    this.claiming = false;
    this.stopping = true;
    this.interruptPause?.();
    for (const run of this.running.values()) run.wake.raise();
    await this.harness.close();
    await Promise.allSettled([...this.running.values()].map((run) => run.done));
  }

  private async claimLoop(): Promise<void> {
    while (this.claiming) {
      const lease = this.claimed < this.concurrency
        ? await this.work.claim().catch(() => undefined)
        : undefined;
      if (lease !== undefined) {
        this.claimed += 1;
        void this.run(lease).finally(() => { this.claimed -= 1; });
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.interruptPause = undefined; resolve(); }, this.claimIntervalMs);
        timer.unref?.();
        this.interruptPause = () => { clearTimeout(timer); this.interruptPause = undefined; resolve(); };
      });
    }
  }

  /**
   * Nudge: make sure this session's inbox is being read. Runs it here if nobody holds it;
   * wakes the run if this process does; does nothing if another node does (its next heartbeat
   * carries the wake). Resolves when the run it found or started is over, `false` when it
   * could do nothing — which is not a failure, since the row is woken either way.
   */
  async drain(sessionId: string): Promise<boolean> {
    const running = this.running.get(sessionId);
    if (running !== undefined) {
      running.wake.raise();
      await running.done;
      return true;
    }
    const lease = await this.work.acquire(sessionId);
    if (lease === undefined) return false;
    await this.run(lease);
    return true;
  }

  /** Everything that happens under one lease, from claim to release. Never rejects. */
  private async run(lease: WorkLease): Promise<void> {
    const { sessionId } = lease;
    const wake = new Wakeup();
    // From the first moment, so nothing below — including waiting out a previous run of the
    // same session here, whose lease this one took over — can outlast the TTL.
    const heartbeat = setInterval(() => {
      void lease.renew().then((beat) => { if (beat === "woken") wake.raise(); }, () => undefined);
    }, this.renewIntervalMs);
    heartbeat.unref?.();
    let finish!: () => void;
    const entry: Running = { wake, done: new Promise((resolve) => { finish = resolve; }) };
    try {
      await this.running.get(sessionId)?.done;
      this.running.set(sessionId, entry);
      const metadata = await this.metadata.get(sessionId);
      const handle = metadata === undefined ? undefined : await this.repository.open(sessionId);
      if (metadata === undefined || handle === undefined) return;
      const halted = (): boolean => lease.signal.aborted || this.stopping;
      try {
        // A wake raised after the last inbox read means go around; one raised before it was
        // covered by that read. `take` at the top of each pass draws that line.
        do {
          wake.take();
          await this.drainInbox(sessionId, metadata, handle.store, halted, wake);
        } while (wake.take() && !halted());
      } finally {
        await handle.store.close?.();
      }
    } catch (error) {
      // A failure OUTSIDE any turn: the environment would not resolve, the sandbox would not
      // boot, the store was unreachable. No turn was ever opened, so there is nothing for the
      // runner to close (a failure INSIDE a turn is closed there, with `turn.ended` reason
      // "failed"). Tell live subscribers with an `error` event. The unprocessed input is still
      // in the inbox, so the stream's stranded check would eventually speak up on its own; this
      // says what went wrong, now, instead of only that nobody is working.
      this.broadcaster?.publish(sessionId, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        address: "main",
        sessionId,
        eventId: newAgentEventId(),
      } as AgentEvent);
      this.onError(error, sessionId);
    } finally {
      clearInterval(heartbeat);
      if (this.running.get(sessionId) === entry) this.running.delete(sessionId);
      await lease.release().catch(() => undefined);
      finish();
    }
  }

  private async drainInbox(
    sessionId: string,
    metadata: ManagedSessionMetadata,
    store: SessionStore,
    halted: () => boolean,
    wake: Wakeup,
  ): Promise<void> {
    // A turn the previous holder never finished is closed here, under the lease, before
    // anything else — and its end is broadcast, which opening the session would not do.
    if (await lastTurnIsOpen(store)) {
      for (const event of await closeOrphanedTurns(sessionId, store)) this.broadcaster?.publish(sessionId, event);
    }
    for (;;) {
      if (halted()) return;
      const items = await readInbox(store, await readInboxCursor(store));
      // Cheap check before paying for a session: an empty inbox means nothing to open for.
      if (items.length === 0) return;

      // Cancels with nothing ahead of them to cancel are already in the state they ask for.
      // Step over them without booting a sandbox to do it.
      if (items.every((item) => item.kind === "control" && item.command.kind === "cancel")) {
        await store.putState(INBOX_CURSOR_KEY, items[items.length - 1]!.sequence);
        continue;
      }

      const session = await this.openSession(sessionId, metadata);
      let cancelled: boolean;
      try {
        cancelled = await this.processInbox(session, store, halted, wake);
      } finally {
        await session.close();
      }
      // After a cancel the object is thrown away: it may still hold, in its in-memory steer
      // queues, inputs the cancel discarded, and a fresh object has none of them.
      if (!cancelled) return;
    }
  }

  private async openSession(sessionId: string, metadata: ManagedSessionMetadata): Promise<HarnessSession<TContext>> {
    const [agentResolution, environmentResolution] = await Promise.all([
      this.agents.resolve(metadata.agent),
      this.environments.resolve(metadata.environment),
    ]);
    const session = await this.harness.resumeSession(sessionId, {
      ...agentResolution.resumeOptions,
      ...(environmentResolution.machine !== undefined ? { machine: environmentResolution.machine } : {}),
      ...(agentResolution.agent !== undefined ? { agent: agentResolution.agent } : {}),
      eventPublication: "committed",
    });
    if (this.broadcaster !== undefined) {
      // Not unsubscribed: the subscription dies with the session it is attached to.
      session.onEvent((event: AgentEvent) => { this.broadcaster?.publish(sessionId, event); });
    }
    return session;
  }

  /**
   * Hand inbox items to the session in log order, advancing the cursor as soon as each one is
   * in the conversation.
   *
   * "In the conversation" is the `message.appended` that names the item's delivery — for a
   * steer, that is some step boundary of the running turn, which is why the cursor cannot
   * simply move on dispatch. For an input that STARTED a turn, the turn settling counts too:
   * a guardrail can refuse the input without ever journaling a message, and the input is no
   * less dealt with for it.
   *
   * While a turn runs, the inbox is re-read on every wake — a nudge from this process, or a
   * heartbeat that came back `woken` — so a message steers the turn and a cancel stops it,
   * rather than waiting for it to finish. Nothing is re-read on a timer.
   *
   * Returns true when a cancel was processed, which ends this pass (see `drainInbox`).
   */
  private async processInbox(
    session: HarnessSession<TContext>,
    store: SessionStore,
    halted: () => boolean,
    wake: Wakeup,
  ): Promise<boolean> {
    const consumed = new Set<string>();
    const unsubscribe = session.onEvent((event: AgentEvent) => {
      if (event.type !== "message.appended") return;
      const origin = event.origin;
      // A delivery is in the conversation when a message carries its id — on whichever origin
      // the delivery was filed under. A locally steered `user` message has no deliveryId.
      const deliveryId = origin?.kind === "external" || origin?.kind === "user" || origin?.kind === "user_follow_up"
        ? origin.deliveryId
        : undefined;
      if (deliveryId === undefined) return;
      consumed.add(deliveryId);
      // Persist the cursor now, not when the turn ends: a holder that dies in between must not
      // leave an input that IS in the conversation looking like one that is not.
      wake.raise();
    });

    try {
      let cursor = await readInboxCursor(store);
      // Dispatched, not yet in the conversation, in log order. The cursor advances across the
      // contiguous consumed prefix, so an item can never be skipped by a later one landing first.
      const outstanding: InboxItem[] = [];
      let completion: Promise<unknown> | undefined;

      const advance = async (): Promise<void> => {
        let moved = false;
        while (outstanding.length > 0 && consumed.has(inboxItemId(outstanding[0]!))) {
          cursor = outstanding.shift()!.sequence;
          moved = true;
        }
        if (moved) await store.putState(INBOX_CURSOR_KEY, cursor);
      };

      for (;;) {
        if (halted()) break;
        wake.take();
        const items = [...await readInbox(store, cursor, new Set(outstanding.map((item) => item.sequence)))];

        // A cancel discards everything that precedes it: the turn in flight, inputs dispatched
        // to it but not yet taken, and inputs in this batch that never got dispatched. "Stop"
        // means stop, not "stop, then carry on with what was queued".
        const lastCancel = findLastIndex(items, (item) => item.kind === "control" && item.command.kind === "cancel");
        if (lastCancel !== -1) {
          for (const item of outstanding) consumed.add(inboxItemId(item));
          for (const item of items.slice(0, lastCancel + 1)) {
            outstanding.push(item);
            consumed.add(inboxItemId(item));
          }
          if (completion !== undefined) {
            session.cancel();
            await completion;
          }
          await advance();
          return true;
        }

        // Paused for an answer: inputs ahead of the resume that answers it are the ones the
        // paused turn already took (the service accepts no new input while interrupted), so
        // they are done, not dispatchable. Without a resume there is nothing to do but wait.
        if (session.status.state === "interrupted" && completion === undefined) {
          const resumeAt = items.findIndex((item) => item.kind === "control" && item.command.kind === "resume");
          if (resumeAt === -1) break;
          for (const item of items.slice(0, resumeAt)) {
            outstanding.push(item);
            consumed.add(inboxItemId(item));
          }
          items.splice(0, resumeAt);
        }

        for (const item of items) {
          if (halted()) break;
          outstanding.push(item);
          const id = inboxItemId(item);
          if (item.kind === "input") {
            const receipt = session.dispatchAccepted(item.input, item.origin.kind === "external"
              ? {
                  kind: "external",
                  source: item.origin.source,
                  deliveryId: item.origin.deliveryId,
                  channel: item.mode === "follow_up" ? "follow_up" : "steering",
                  ...(item.origin.actor !== undefined ? { actor: item.origin.actor } : {}),
                  ...(item.origin.metadata !== undefined ? { metadata: item.origin.metadata } : {}),
                }
              : { kind: item.mode === "follow_up" ? "user_follow_up" : "user", deliveryId: item.origin.deliveryId });
            if (receipt.completion !== undefined) {
              // Resolved: the turn ran to some end (answered, refused by a guardrail, paused)
              // and the input is dealt with even if no message ever named it. Rejected: the
              // turn failed; if the message got in, `message.appended` already said so, and if
              // it did not, the input is still after the cursor for the next drain.
              completion = receipt.completion.then(() => { consumed.add(id); }, () => undefined);
            }
          } else if (item.command.kind === "resume") {
            completion = session.resume({ ...item.command.answers }).then(() => { consumed.add(id); }, () => { consumed.add(id); });
          }
        }

        if (completion !== undefined) {
          // A turn is running. Sleep until it ends or something new arrives, whichever first.
          const settled = await Promise.race([
            completion.then(() => "done" as const),
            wake.wait().then(() => "woken" as const),
          ]);
          if (settled === "done") completion = undefined;
        }
        await advance();
        // Nothing running and nothing new: done. Anything still outstanding was dispatched to a
        // turn that ended without taking it; it is still after the cursor, and the next run —
        // the next append, or the next claim — dispatches it again on a fresh object.
        if (completion === undefined && items.length === 0) break;
      }
    } finally {
      unsubscribe();
    }
    return false;
  }
}

/**
 * A latch that remembers. `raise` sets it; `take` reads and clears it; `wait` resolves at the
 * next raise, or at once if one is pending. Raises are never lost between a `take` and a
 * `wait`, which is what lets the feed loop sleep on it without a timer as a backstop.
 */
class Wakeup {
  private pending = false;
  private waiters: Array<() => void> = [];

  raise(): void {
    this.pending = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  take(): boolean {
    const was = this.pending;
    this.pending = false;
    return was;
  }

  wait(): Promise<void> {
    if (this.pending) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }
}

/**
 * Is the main frame still inside a turn? Decided by the LAST turn lifecycle record, read
 * backwards — a finished turn ends on its `turn.ended`, so this stops within a page for any
 * session that is fine, and only walks a whole turn for one that was cut off inside it.
 */
async function lastTurnIsOpen(store: SessionStore): Promise<boolean> {
  let cursor: string | undefined;
  for (;;) {
    const page = await store.readRecordPage({
      limit: 64,
      order: "desc",
      address: "main",
      ...(cursor !== undefined ? { after: cursor } : {}),
    });
    for (const stored of page.data) {
      const record = stored.record as AgentRecord;
      if (record.type !== "event.lifecycle") continue;
      const type = record.event.type;
      if (type === "turn.started") return true;
      if (type === "turn.ended" || type === "turn.paused") return false;
    }
    if (page.next === undefined) return false;
    cursor = page.next;
  }
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
