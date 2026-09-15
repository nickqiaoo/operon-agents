import type { ThinkingLevel } from 'operon-agents';
import { Container, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Focusable } from 'operon-pi-tui';

import { currentTheme } from '../../theme/index.ts';
import { thinkingLabel } from '../../utils/thinking.ts';

export interface ThinkingSelectorOptions {
  readonly title?: string;
  readonly levels: readonly ThinkingLevel[];
  readonly currentValue: ThinkingLevel;
  readonly onSelect: (level: ThinkingLevel) => void;
  readonly onCancel: () => void;
  readonly warning?: string;
}

/**
 * Horizontal segmented picker for `/thinking`. Mirrors the thinking control under `/model`: one
 * row of segments with the active one wrapped in `[ ]`. ←/→ step it, Enter commits.
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ThinkingSelectorOptions;
  private activeIndex: number;

  constructor(opts: ThinkingSelectorOptions) {
    super();
    this.opts = opts;
    this.activeIndex = Math.max(opts.levels.indexOf(opts.currentValue), 0);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.activeIndex = Math.min(this.opts.levels.length - 1, this.activeIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const level = this.opts.levels[this.activeIndex];
      if (level !== undefined) this.opts.onSelect(level);
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.title ?? 'Select thinking level'}`),
      currentTheme.fg('textMuted', ' ←→ switch · Enter select · Esc cancel'),
    ];
    if (this.opts.warning !== undefined) {
      for (const line of wrapTextWithAnsi(this.opts.warning, Math.max(1, width - 1))) {
        lines.push(currentTheme.fg('warning', ` ${line}`));
      }
    }
    lines.push('');
    const segments = this.opts.levels.map((level, index) =>
      index === this.activeIndex
        ? currentTheme.boldFg('primary', `[ ${thinkingLabel(level)} ]`)
        : currentTheme.fg('text', `  ${thinkingLabel(level)}  `),
    );
    lines.push(`  ${segments.join(' ')}`);
    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
