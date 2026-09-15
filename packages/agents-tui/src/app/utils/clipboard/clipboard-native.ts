/**
 * Optional native clipboard binding.
 *
 * `@mariozechner/clipboard` is a native Node binding that can read image bytes from the system
 * clipboard on macOS and Windows. It is an optional dependency: when it fails to load we
 * degrade to the shell fallbacks in `clipboard-image.ts` (wl-paste / xclip / PowerShell).
 */

import { createRequire } from 'node:module';

export interface ClipboardModule {
  availableFormats?(): string[];
  hasText?(): boolean;
  getText?(): Promise<string>;
  setText?(text: string): Promise<void>;
  hasImage(): boolean;
  getImageBinary(): Promise<number[]>;
}

const nodeRequire = createRequire(import.meta.url);

// The native module uses X11/Wayland on Linux; without a display, skip the load attempt so
// headless environments do not pay the binding cost just to fail later.
const hasDisplay = process.platform !== 'linux' || Boolean(process.env['DISPLAY'] ?? process.env['WAYLAND_DISPLAY']);

export const clipboard: ClipboardModule | null = (() => {
  if (process.env['TERMUX_VERSION'] !== undefined || !hasDisplay) return null;
  try {
    return nodeRequire('@mariozechner/clipboard') as ClipboardModule;
  } catch {
    return null;
  }
})();
