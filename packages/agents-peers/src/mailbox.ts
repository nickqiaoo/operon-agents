/**
 * Write-ahead ledger for messages in flight.
 *
 * A message is recorded here BEFORE it is handed to the recipient, because delivery goes through
 * an in-memory queue: a crash between enqueue and the recipient consuming it would otherwise lose
 * the message with no trace of it ever existing.
 *
 * The durable anchor on the other side is the recipient's own journal — a delivered peer message
 * is recorded with `origin.deliveryId`, so a restart can tell "already delivered" from "never
 * arrived" by looking there. This ledger therefore never tracks delivery itself; `settle` only
 * reclaims space.
 */
export interface PeerMessage {
  readonly messageId: string;
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly replyTo?: string;
  readonly queuedAt: number;
}

/**
 * CONCURRENCY CONTRACT (holds for every `PeerRepo` facet): each method is atomic in the backend;
 * no caller ever does a cross-call read-modify-write. That is what lets one repo be shared without
 * conflicts — capacity, in particular, is checked INSIDE `enqueue`, in the same atomic step as the
 * insert, so `mailboxCapacity` is a hard limit rather than a check-then-act race.
 */
export interface PeerMailbox {
  /** Record one message in flight. With `capacity` set, a full mailbox refuses atomically —
   *  `accepted: false` and nothing written. */
  enqueue(message: PeerMessage, opts?: { readonly capacity?: number }): Promise<{ readonly accepted: boolean }>;
  pending(agentId: string): Promise<readonly PeerMessage[]>;
  settle(agentId: string, messageId: string): Promise<void>;
  /** Everyone with undelivered entries. What `PeerNetwork.reconcile()` walks on startup. */
  pendingRecipients(): Promise<readonly string[]>;
}

/**
 * Non-durable default: enough to route in one process, NOT enough to survive a restart.
 * A deployment that cares about the crash window supplies a durable `PeerRepo` (file, PG, …).
 */
export class MemoryPeerMailbox implements PeerMailbox {
  private readonly queues = new Map<string, PeerMessage[]>();

  async enqueue(message: PeerMessage, opts?: { readonly capacity?: number }): Promise<{ readonly accepted: boolean }> {
    const queue = this.queues.get(message.to) ?? [];
    if (opts?.capacity !== undefined && queue.length >= opts.capacity) return { accepted: false };
    queue.push(message);
    this.queues.set(message.to, queue);
    return { accepted: true };
  }

  async pending(agentId: string): Promise<readonly PeerMessage[]> {
    return [...(this.queues.get(agentId) ?? [])];
  }

  async settle(agentId: string, messageId: string): Promise<void> {
    const queue = this.queues.get(agentId);
    if (queue === undefined) return;
    const next = queue.filter((message) => message.messageId !== messageId);
    if (next.length === 0) this.queues.delete(agentId);
    else this.queues.set(agentId, next);
  }

  async pendingRecipients(): Promise<readonly string[]> {
    return [...this.queues.keys()];
  }
}

export interface PeerLimits {
  /** Cap on outbound messages within one turn. Guards a runaway send loop inside a single turn;
   *  deliberately orthogonal to conversation length — a long peer discussion is normal
   *  collaboration, and the real cost ceiling is the existing turn budget. */
  readonly maxOutboundPerTurn?: number;
  /** Mailbox depth. Full means REJECT with a failed receipt — never silently drop the oldest,
   *  which would leave the sender believing delivery happened. */
  readonly mailboxCapacity?: number;
}
