import { DEFAULT_ADDRESS } from "../../store/index.ts";

export interface CompactRequestOptions {
  readonly instruction?: string;
}

export interface PendingCompaction {
  readonly id: string;
  readonly requestedAt: number;
  readonly instruction?: string;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `compact-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export class CompactionService {
  /**
   * One pending request PER FRAME (docs/state-and-lifetime.md). `beforeStep` runs for every
   * agent in the session, so a single slot meant whichever frame stepped next consumed the
   * request — a subagent compacting ITS context because the main agent asked, and the main
   * agent's context left untouched with its request gone.
   */
  private readonly pendingByFrame = new Map<string, PendingCompaction>();
  /**
   * Session-wide on purpose: this only invalidates the system-prompt context cache, so a
   * compaction in one frame merely makes another recompute once. Coarse here costs a little
   * work; wrong here would cost correctness, which is the distinction that decides what gets
   * a key and what does not.
   */
  private completedRevision = 0;

  private readonly reserveProvider: () => number;

  /** Context tokens the strategy holds back before the window fills — surfaced here (the
   *  session-visible service) so the context breakdown can report the real value instead of
   *  guessing the default. Read through a provider, not stored: the reserve depends on the
   *  active model's output limit, which isn't known when the capability is constructed. */
  get reservedContextTokens(): number {
    return this.reserveProvider();
  }

  constructor(reserveProvider: (() => number) | number = 0) {
    this.reserveProvider = typeof reserveProvider === "number" ? () => reserveProvider : reserveProvider;
  }

  /** Monotonic, in-memory signal that a full compaction committed in this live Session. */
  get revision(): number {
    return this.completedRevision;
  }

  /** Capability-internal commit notification; micro-compaction deliberately does not call it. */
  recordCompleted(): void {
    this.completedRevision += 1;
  }

  /** Ask for a compaction of one frame's context. Defaults to the root agent's, which is what
   *  `session.controls().compact()` and the `/compact` command mean. */
  request(options: CompactRequestOptions = {}, address: string = DEFAULT_ADDRESS): PendingCompaction {
    const instruction = options.instruction?.trim();
    const request: PendingCompaction = {
      id: nextRequestId(),
      requestedAt: Date.now(),
      ...(instruction !== undefined && instruction.length > 0 ? { instruction } : {}),
    };
    this.pendingByFrame.set(address, request);
    return request;
  }

  pending(address: string = DEFAULT_ADDRESS): PendingCompaction | null {
    return this.pendingByFrame.get(address) ?? null;
  }

  cancel(address: string = DEFAULT_ADDRESS): PendingCompaction | null {
    const pending = this.pending(address);
    this.pendingByFrame.delete(address);
    return pending;
  }

  /** Taken by the frame that is about to step — never another's request. */
  consume(address: string = DEFAULT_ADDRESS): PendingCompaction | null {
    const pending = this.pending(address);
    this.pendingByFrame.delete(address);
    return pending;
  }
}
