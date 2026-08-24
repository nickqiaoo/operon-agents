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
  private pendingRequest: PendingCompaction | null = null;
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

  request(options: CompactRequestOptions = {}): PendingCompaction {
    const instruction = options.instruction?.trim();
    const request: PendingCompaction = {
      id: nextRequestId(),
      requestedAt: Date.now(),
      ...(instruction !== undefined && instruction.length > 0 ? { instruction } : {}),
    };
    this.pendingRequest = request;
    return request;
  }

  pending(): PendingCompaction | null {
    return this.pendingRequest;
  }

  cancel(): PendingCompaction | null {
    const pending = this.pendingRequest;
    this.pendingRequest = null;
    return pending;
  }

  consume(): PendingCompaction | null {
    const pending = this.pendingRequest;
    this.pendingRequest = null;
    return pending;
  }
}
