/**
 * Locate `fd` for the `@` file-mention autocomplete. Detection only: a missing `fd` leaves the
 * provider on its filesystem-walk fallback rather than downloading a binary.
 */

import { resolveCommandPath } from './resolve-command.ts';

let cached: string | null | undefined;

export function detectFdPath(): string | null {
  if (cached !== undefined) return cached;
  cached = resolveCommandPath('fd') ?? resolveCommandPath('fdfind') ?? null;
  return cached;
}
