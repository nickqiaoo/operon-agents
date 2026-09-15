/**
 * Transcript-side rendering of a pasted image.
 *
 * On terminals that speak the Kitty graphics protocol or iTerm2 inline
 * image protocol (detected by pi-tui's `getCapabilities()`), we show
 * the actual image. Everywhere else we fall back to a one-line text
 * marker matching the placeholder the user sees in the input box —
 * this keeps the transcript readable on Terminal.app / Linux default
 * terminals / `script` recordings without extra chrome.
 *
 * Height is capped at ~12 rows so a single screenshot can't monopolize
 * the viewport; pi-tui handles proportional scaling internally.
 */

import { Container, Image, Text, type ImageTheme, getCapabilities } from 'operon-pi-tui';

import { currentTheme } from '../../theme/index.ts';
import type { ImageAttachment } from '../../utils/image-attachment-store.ts';
import { imagePlaceholder } from '../../utils/image-placeholder.ts';

const MAX_IMAGE_ROWS = 12;
const MAX_IMAGE_WIDTH = 40;

export class ImageThumbnail extends Container {
  private readonly attachment: ImageAttachment;
  /** The same marker the editor shows, used as the non-graphical fallback and the image label. */
  private readonly placeholder: string;
  private lastRenderWidth = 80;
  private lastBuiltWidth: number | undefined;
  private lastBuiltInline: boolean | undefined;

  constructor(attachment: ImageAttachment) {
    super();
    this.attachment = attachment;
    this.placeholder = imagePlaceholder(attachment.id, attachment.width, attachment.height);
    this.buildChildren(this.lastRenderWidth);
  }

  private buildChildren(width: number): void {
    this.clear();
    const caps = getCapabilities();
    const supportsInline = caps.images === 'kitty' || caps.images === 'iterm2';

    if (!supportsInline) {
      this.addChild(new Text(currentTheme.fg('accent', this.placeholder), 0, 0));
      this.lastBuiltWidth = width;
      this.lastBuiltInline = false;
      return;
    }

    const theme: ImageTheme = {
      fallbackColor: (s: string) => currentTheme.fg('textDim', s),
    };
    const image = new Image(
      this.attachment.data,
      this.attachment.mimeType,
      theme,
      {
        maxHeightCells: MAX_IMAGE_ROWS,
        maxWidthCells: Math.max(1, Math.min(MAX_IMAGE_WIDTH, width - 2)),
        filename: this.placeholder,
      },
      this.attachment.width !== undefined && this.attachment.height !== undefined
        ? { widthPx: this.attachment.width, heightPx: this.attachment.height }
        : undefined,
    );
    this.addChild(image);
    this.lastBuiltWidth = width;
    this.lastBuiltInline = true;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    this.lastRenderWidth = safeWidth;

    if (safeWidth < MAX_IMAGE_WIDTH + 2) {
      return new Text(currentTheme.fg('accent', this.placeholder), 0, 0).render(
        safeWidth,
      );
    }

    const caps = getCapabilities();
    const supportsInline = caps.images === 'kitty' || caps.images === 'iterm2';
    if (this.lastBuiltWidth !== safeWidth || this.lastBuiltInline !== supportsInline) {
      this.buildChildren(safeWidth);
    }
    return super.render(safeWidth);
  }

  override invalidate(): void {
    this.buildChildren(this.lastRenderWidth);
    super.invalidate();
  }
}
