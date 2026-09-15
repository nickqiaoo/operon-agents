import { Container, Key, matchesKey, truncateToWidth, visibleWidth, type Focusable } from 'operon-pi-tui';

import { CURRENT_MARK, SELECT_POINTER } from '../../constant/symbols.ts';
import { currentTheme } from '../../theme/index.ts';
import { printableChar } from '../../utils/printable-key.ts';
import { pageView } from '../../utils/paging.ts';

/** One installed plugin as the panel shows it. */
export interface PluginRow {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly hasErrors: boolean;
  /** Where it came from, already rendered (`github owner/repo@ref`, `via host`, a path…). */
  readonly source: string;
  /** Secondary line: skill and MCP-server counts. */
  readonly detail: string;
}

export interface PluginsSelectorOptions {
  readonly plugins: readonly PluginRow[];
  readonly pageSize?: number;
  /** Space toggles the row in place; the panel stays open. */
  readonly onToggle: (id: string, enabled: boolean) => void;
  /** `D` removes, after a `[y/N]` confirmation. */
  readonly onRemove: (id: string) => void;
  readonly onClose: () => void;
}

/**
 * Installed-plugin manager. One list, no tabs: `Space` enables or disables in place, `D` removes
 * after confirmation, `Esc` closes. There is no marketplace tab — plugins install by source
 * through `/plugins install`.
 */
export class PluginsSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: PluginsSelectorOptions;
  private rows: PluginRow[];
  private index = 0;
  private confirmingRemoval = false;

  constructor(opts: PluginsSelectorOptions) {
    super();
    this.opts = opts;
    this.rows = [...opts.plugins];
  }

  handleInput(data: string): void {
    if (this.confirmingRemoval) {
      const char = printableChar(data)?.toLowerCase();
      if (char === 'y') {
        const row = this.rows[this.index];
        this.confirmingRemoval = false;
        if (row !== undefined) this.opts.onRemove(row.id);
        return;
      }
      if (char === 'n' || matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
        this.confirmingRemoval = false;
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.index = Math.max(0, this.index - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = Math.min(this.rows.length - 1, this.index + 1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      const row = this.rows[this.index];
      if (row === undefined) return;
      const enabled = !row.enabled;
      this.rows = this.rows.map((candidate, i) => (i === this.index ? { ...candidate, enabled } : candidate));
      this.opts.onToggle(row.id, enabled);
      return;
    }
    const char = printableChar(data);
    if (char?.toLowerCase() === 'd' && this.rows.length > 0) {
      this.confirmingRemoval = true;
    }
  }

  override render(width: number): string[] {
    const pageSize = this.opts.pageSize ?? 10;
    const page = pageView(this.rows.length, this.index, pageSize);
    const nameWidth = Math.max(4, ...this.rows.map((row) => visibleWidth(row.displayName)));

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Plugins'),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Space toggle · D delete · Esc cancel'),
      '',
    ];

    for (let i = page.start; i < page.end; i++) {
      const row = this.rows[i];
      if (row === undefined) continue;
      const isSelected = i === this.index;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const name = truncateToWidth(row.displayName, nameWidth, '…');
      const namePad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(name)));
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += (isSelected ? currentTheme.boldFg('primary', name) : currentTheme.fg('text', name)) + namePad;
      line += row.enabled ? currentTheme.fg('success', '  enabled') : currentTheme.fg('textDim', '  disabled');
      if (row.version !== undefined) line += currentTheme.fg('textMuted', `  v${row.version}`);
      if (row.hasErrors) line += currentTheme.fg('error', `  ${CURRENT_MARK.trim()} errors`);
      lines.push(line);
      lines.push(`      ${currentTheme.fg('textMuted', `${row.id} · ${row.detail} · ${row.source}`)}`);
    }

    if (page.end < this.rows.length) {
      lines.push('');
      lines.push(currentTheme.fg('textMuted', ` ▼ ${String(this.rows.length - page.end)} more`));
    }

    if (this.confirmingRemoval) {
      const row = this.rows[this.index];
      lines.push('');
      lines.push(currentTheme.boldFg('warning', ` Remove ${row?.id ?? ''}? [y/N]`));
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
