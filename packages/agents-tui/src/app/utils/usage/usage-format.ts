/** Shared token/percentage formatting for the footer, `/usage` and `/context`. */

import { currentTheme } from '../../../theme/index.ts';
import type { ColorToken } from '../../../theme/index.ts';

/** `1234` → `1.2k`, `1234567` → `1.2M`. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Clamp a possibly-missing or out-of-range ratio into 0..1. */
export function safeUsageRatio(ratio: number, used = 0, max = 0): number {
  const value = Number.isFinite(ratio) && ratio > 0 ? ratio : max > 0 ? used / max : 0;
  return Math.max(0, Math.min(1, value));
}

export function usagePercent(ratio: number): string {
  return `${Math.round(safeUsageRatio(ratio) * 100)}%`;
}

/** The color a fill ratio should read in: calm under 70%, warning to 90%, error above. */
export function ratioSeverity(ratio: number): ColorToken {
  const value = safeUsageRatio(ratio);
  if (value >= 0.9) return 'error';
  if (value >= 0.7) return 'warning';
  return 'success';
}

export function renderProgressBar(ratio: number, width = 20, token: ColorToken = 'primary'): string {
  const usable = Math.max(1, width);
  const filled = Math.round(safeUsageRatio(ratio) * usable);
  return currentTheme.fg(token, '█'.repeat(filled)) + currentTheme.fg('textDim', '░'.repeat(Math.max(0, usable - filled)));
}
