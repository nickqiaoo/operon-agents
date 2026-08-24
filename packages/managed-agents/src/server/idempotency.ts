/**
 * Delivery idempotency.
 *
 * A client that retries a message after a timeout must not have it delivered twice, and it
 * cannot tell from a failed request whether the first attempt landed. Keyed by
 * `(sessionId, key)`: the same key on a different session is a different delivery.
 */
import type { DeliveryReceiptResource } from "../protocol/types.ts";

export interface ManagedDeliveryIdempotencyStore {
  run(
    sessionId: string,
    key: string,
    operation: () => Promise<DeliveryReceiptResource>,
  ): Promise<DeliveryReceiptResource>;
}
export class MemoryManagedDeliveryIdempotencyStore implements ManagedDeliveryIdempotencyStore {
  private readonly entries = new Map<string, {
    readonly result: Promise<DeliveryReceiptResource>;
    settled: boolean;
    expiresAt: number;
  }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { readonly ttlMs?: number; readonly maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("idempotency ttlMs must be positive");
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new Error("idempotency maxEntries must be a positive integer");
  }

  async run(
    sessionId: string,
    key: string,
    operation: () => Promise<DeliveryReceiptResource>,
  ): Promise<DeliveryReceiptResource> {
    const compound = `${sessionId}\0${key}`;
    const now = Date.now();
    this.pruneExpired(now);
    const existing = this.entries.get(compound);
    if (existing !== undefined && (!existing.settled || existing.expiresAt > now)) return existing.result;
    this.makeRoom();
    const result = operation();
    const entry = { result, settled: false, expiresAt: Number.POSITIVE_INFINITY };
    this.entries.set(compound, entry);
    void result.then(
      () => {
        if (this.entries.get(compound) !== entry) return;
        entry.settled = true;
        entry.expiresAt = Date.now() + this.ttlMs;
      },
      () => {
        if (this.entries.get(compound) === entry) this.entries.delete(compound);
      },
    );
    return result;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private makeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldestSettled = [...this.entries].find(([, entry]) => entry.settled)?.[0];
      // Never evict an in-flight key: that would permit the same delivery concurrently.
      // A burst may exceed maxEntries temporarily; completion makes it evictable.
      if (oldestSettled === undefined) break;
      this.entries.delete(oldestSettled);
    }
  }
}
