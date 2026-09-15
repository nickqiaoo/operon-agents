/**
 * Placeholder ↔ content-part translation for pasted images.
 *
 * A paste puts `[image #<id> (<w>×<h>)]` into the editor and the bytes into the
 * {@link ImageAttachmentStore}. On submit the text is split on those placeholders and each one
 * becomes an `image` content part, so what the model receives is the text the user typed with the
 * images inline at the positions they pasted them.
 */

import type { PromptPart } from '../types.ts';
import type { ImageAttachmentStore } from './image-attachment-store.ts';

const PLACEHOLDER_REGEX = /\[image #(\d+)(?: \((\d+)×(\d+)\))?\]/g;

export interface ExtractionResult {
  readonly parts: readonly PromptPart[];
  readonly imageAttachmentIds: readonly number[];
  readonly hasMedia: boolean;
}

export function imagePlaceholder(id: number, width?: number, height?: number): string {
  const dimensions = width !== undefined && height !== undefined ? ` (${String(width)}×${String(height)})` : '';
  return `[image #${String(id)}${dimensions}]`;
}

/**
 * Split `text` on image placeholders, resolving each against the store. A placeholder whose
 * attachment is gone (its message left the transcript window) stays as literal text.
 */
export function extractMediaAttachments(text: string, store: ImageAttachmentStore): ExtractionResult {
  const parts: PromptPart[] = [];
  const imageAttachmentIds: number[] = [];
  let cursor = 0;

  const pushText = (value: string): void => {
    if (value.length === 0) return;
    const last = parts.at(-1);
    if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + value };
    else parts.push({ type: 'text', text: value });
  };

  for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
    const id = Number(match[1]);
    const attachment = store.get(id);
    if (attachment === undefined) continue;
    pushText(text.slice(cursor, match.index));
    parts.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
    imageAttachmentIds.push(id);
    cursor = match.index + match[0].length;
  }
  pushText(text.slice(cursor));

  if (imageAttachmentIds.length === 0) {
    return { parts: [{ type: 'text', text }], imageAttachmentIds: [], hasMedia: false };
  }
  return { parts, imageAttachmentIds, hasMedia: true };
}

/** The ids a piece of text still refers to — what a queued message has to keep alive. */
export function referencedAttachmentIds(text: string): readonly number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(PLACEHOLDER_REGEX)) ids.push(Number(match[1]));
  return ids;
}
