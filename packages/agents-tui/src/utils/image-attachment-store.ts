/**
 * Pasted-image store.
 *
 * A pasted image is held here as raw bytes plus a numeric id, and the editor text carries only a
 * placeholder (`[image #1 (640×480)]`). On submit the placeholders expand into `image` content
 * parts alongside the text, so the bytes reach the model inline — there is no upload service in
 * between. Attachments outlive their prompt because the transcript renders historical thumbnails
 * from this store; they are released when their message leaves the transcript window.
 */

export interface ImageAttachment {
  readonly kind: 'image';
  readonly id: number;
  /** Base64 of the bytes actually sent to the model (already downscaled when it was too big). */
  readonly data: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  /** Byte length of `data` once decoded, for the placeholder label and the size cap. */
  readonly bytes: number;
  /** Where the original came from, when it was a file rather than the clipboard. */
  readonly sourcePath?: string;
}

export class ImageAttachmentStore {
  private readonly attachments = new Map<number, ImageAttachment>();
  private nextId = 1;

  add(input: Omit<ImageAttachment, 'id' | 'kind'>): ImageAttachment {
    const attachment: ImageAttachment = { kind: 'image', id: this.nextId, ...input };
    this.nextId += 1;
    this.attachments.set(attachment.id, attachment);
    return attachment;
  }

  get(id: number): ImageAttachment | undefined {
    return this.attachments.get(id);
  }

  /** Total decoded bytes currently held, so a caller can cap what one prompt carries. */
  totalBytes(): number {
    let total = 0;
    for (const attachment of this.attachments.values()) total += attachment.bytes;
    return total;
  }

  remove(id: number): void {
    this.attachments.delete(id);
  }

  removeMany(ids: readonly number[]): void {
    for (const id of ids) this.attachments.delete(id);
  }

  clear(): void {
    this.attachments.clear();
  }
}
