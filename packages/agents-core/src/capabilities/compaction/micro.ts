import type { Message } from "../../protocol/index.ts";

export interface MicroCompactionConfig {
  readonly keepRecentMessages: number;
  readonly minContentTokens: number;
  readonly cacheMissedThresholdMs: number;
  readonly truncatedMarker: string;
  readonly minContextUsageRatio: number;
}

export const DEFAULT_MICRO_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: "[Old tool result content cleared]",
  minContextUsageRatio: 0.5,
};

function contentTokens(message: Message): number {
  let chars = 0;
  for (const part of message.content) {
    if (typeof part === "string") chars += part.length;
    else if (part.type === "text") chars += part.text.length;
  }
  return Math.ceil(chars / 4);
}

function isMarkerOnly(message: Message, marker: string): boolean {
  if (message.content.length !== 1) return false;
  const part = message.content[0];
  if (typeof part === "string") return part === marker;
  return part?.type === "text" && part.text === marker;
}

export class MicroCompaction {
  private cutoff = 0;
  readonly config: MicroCompactionConfig;

  constructor(config: Partial<MicroCompactionConfig> = {}) {
    this.config = { ...DEFAULT_MICRO_CONFIG, ...config };
  }

  detectAndApply(messages: Message[], lastAssistantAtMs: number, maxContextTokens: number): number {
    const cacheAgeMs = Date.now() - lastAssistantAtMs;
    if (cacheAgeMs < this.config.cacheMissedThresholdMs) return 0; // cache still hot → never touch

    const used = messages.reduce((sum, m) => sum + contentTokens(m), 0);
    const ratio = maxContextTokens > 0 ? used / maxContextTokens : 1;
    if (ratio < this.config.minContextUsageRatio) return 0;

    this.cutoff = Math.max(this.cutoff, Math.max(0, messages.length - this.config.keepRecentMessages));
    return this.clearOld(messages);
  }

  private clearOld(messages: Message[]): number {
    let cleared = 0;
    for (let i = 0; i < this.cutoff && i < messages.length; i++) {
      const m = messages[i]!;
      if (
        m.role === "toolResult" &&
        contentTokens(m) >= this.config.minContentTokens &&
        !isMarkerOnly(m, this.config.truncatedMarker)
      ) {
        messages[i] = { ...m, content: [{ type: "text", text: this.config.truncatedMarker }] };
        cleared += 1;
      }
    }
    return cleared;
  }
}
