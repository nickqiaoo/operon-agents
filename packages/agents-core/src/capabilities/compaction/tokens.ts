import type { Message } from "../../protocol/index.ts";

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTokensForMessage(message: Message): number {
  let chars = 0;
  for (const part of message.content) {
    if (typeof part === "string") chars += part.length;
    else if (part.type === "text") chars += part.text.length;
    else if (part.type === "toolCall") chars += JSON.stringify(part.arguments ?? {}).length + part.name.length;
    else chars += 16; // images/other parts: a flat nominal cost
  }
  return PER_MESSAGE_OVERHEAD + Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokensForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokensForMessage(message);
  return total;
}
