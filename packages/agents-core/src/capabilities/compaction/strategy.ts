import type { Message } from "../../protocol/index.ts";
import { estimateTokensForMessage } from "./tokens.ts";

export interface CompactionConfig {
  /** Room the compaction summary's own LLM call needs for its output. Applied as
   *  `min(model.maxOutputTokens, this)` — a model that cannot emit this much never needs this
   *  much held back. The default covers the summary's p99.99 with headroom. */
  readonly summaryOutputReserve: number;
  /** Head start for auto-compaction: how far ahead of the effective window we begin
   *  summarizing, so the turn still in flight has somewhere to land while the summary runs. */
  readonly compactBufferTokens: number;
  /** Hard floor — past this the next request must not go out uncompacted. Deliberately much
   *  smaller than `compactBufferTokens`: this is the true safety margin, not a head start. */
  readonly blockBufferTokens: number;
  readonly maxRecentMessages: number;
  readonly maxRecentSizeRatio: number;
  readonly minOverflowReductionRatio: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  summaryOutputReserve: 20_000,
  compactBufferTokens: 13_000,
  blockBufferTokens: 3_000,
  maxRecentMessages: 4,
  maxRecentSizeRatio: 0.2,
  minOverflowReductionRatio: 0.05,
};

/**
 * Smallest share of the effective window a threshold may sit at.
 *
 * The buffers above are absolute token counts, which is what keeps a large window usable — but
 * on a small one they go negative: a 16k window minus an 8k output reserve leaves 8k, and
 * 8k − 13k is below zero, which would make `shouldCompact` true at every single step. This
 * floor bounds that worst case instead.
 */
const MIN_THRESHOLD_RATIO = 0.5;

export class CompactionStrategy {
  private readonly maxSizeProvider: () => number;
  private readonly maxOutputProvider: () => number;
  private readonly config: CompactionConfig;

  constructor(
    maxSizeProvider: () => number,
    maxOutputProvider: () => number = () => 0,
    config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  ) {
    this.maxSizeProvider = maxSizeProvider;
    this.maxOutputProvider = maxOutputProvider;
    this.config = config;
  }

  private get maxSize(): number {
    return this.maxSizeProvider();
  }

  /** The window actually available to the conversation: the model's window minus the room the
   *  summary call will need. An unknown output limit (0) reserves the full configured amount
   *  rather than guessing low. */
  get effectiveWindow(): number {
    const maxOutput = this.maxOutputProvider();
    const reserve = maxOutput > 0 ? Math.min(maxOutput, this.config.summaryOutputReserve) : this.config.summaryOutputReserve;
    return this.maxSize - reserve;
  }

  get compactThreshold(): number {
    return this.threshold(this.config.compactBufferTokens);
  }

  get blockThreshold(): number {
    return this.threshold(this.config.blockBufferTokens);
  }

  /** Total tokens withheld from the conversation — summary reserve plus compaction head start.
   *  This is the number the context breakdown reports as the compaction buffer. */
  get reservedTokens(): number {
    if (this.maxSize <= 0) return 0;
    return Math.max(0, this.maxSize - this.compactThreshold);
  }

  private threshold(buffer: number): number {
    const effective = this.effectiveWindow;
    // A window smaller than its own output reserve can't be reasoned about; never fire.
    if (effective <= 0) return this.maxSize;
    return Math.max(effective - buffer, Math.ceil(effective * MIN_THRESHOLD_RATIO));
  }

  /** Whether the compact line sits earlier than the block line. When it does, an afterStep check
   *  can start compaction at the head start instead of waiting for beforeStep to hit the floor. */
  get checkAfterStep(): boolean {
    return this.compactThreshold !== this.blockThreshold;
  }

  shouldCompact(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return usedSize >= this.compactThreshold;
  }

  shouldBlock(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return usedSize >= this.blockThreshold;
  }

  computeCompactCount(messages: readonly Message[]): number {
    let recentMessages = 1;
    let recentSize = 0;
    let bestN: number | undefined;

    for (; recentMessages < messages.length; recentMessages++) {
      const splitIndex = messages.length - recentMessages - 1;
      recentSize += estimateTokensForMessage(messages[messages.length - recentMessages]!);

      if (canSplitAfter(messages, splitIndex)) bestN = splitIndex + 1;

      const reachesMax =
        recentMessages >= this.config.maxRecentMessages || recentSize >= this.maxSize * this.config.maxRecentSizeRatio;
      if (reachesMax && bestN !== undefined) break;
    }
    return bestN ?? 0;
  }

  reduceCompactOnOverflow(messages: readonly Message[]): number {
    const minReduced = Math.max(1, Math.ceil(this.maxSize * this.config.minOverflowReductionRatio));
    let reduced = 0;
    let bestN: number | undefined;
    for (let i = messages.length - 2; i > 0; i--) {
      reduced += estimateTokensForMessage(messages[i + 1]!);
      if (canSplitAfter(messages, i)) {
        bestN = i + 1;
        if (reduced >= minReduced) return i + 1;
      }
    }
    return bestN ?? messages.length;
  }
}

export function canSplitAfter(messages: readonly Message[], index: number): boolean {
  const m = messages[index];
  if (m === undefined) return false;
  if (m.role === "user") return false;
  if (m.role === "assistant" && m.content.some((p) => p.type === "toolCall")) return false;
  if (messages[index + 1]?.role === "toolResult") return false;
  return true;
}
