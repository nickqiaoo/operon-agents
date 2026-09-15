import type { SteerInputItem } from '../types.ts';

/**
 * Flatten steer items into the one string `session.steer` expects. Items are separated by a
 * blank line, the historical joiner. Images do not ride a steer (the engine's steer channel is
 * text); a queued item that carried them steers as its text only.
 */
export function combineSteerInput(items: readonly SteerInputItem[]): string {
  return items.map((item) => item.text).join('\n\n');
}
