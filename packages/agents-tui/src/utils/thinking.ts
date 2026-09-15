import type { ThinkingLevel } from 'operon-agents';

/** Every thinking level the engine accepts, weakest first. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function thinkingLabel(level: ThinkingLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}
