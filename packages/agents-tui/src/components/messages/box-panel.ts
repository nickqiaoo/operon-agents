/**
 * The rounded box every report panel (`/usage`, `/status`, `/context`, `/mcp`, the goal card)
 * renders inside. The body is rebuilt on invalidate because report lines embed palette colors,
 * so a theme switch has to repaint them.
 */

import { truncateToWidth, visibleWidth, type Component } from 'operon-pi-tui';

import { currentTheme } from '../../theme/index.ts';
import type { ColorToken } from '../../theme/index.ts';

/** Left indent, the padding inside each border, and the two border columns they add up to. */
const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const BOX_OVERHEAD = LEFT_MARGIN + 2 * SIDE_PADDING + 2;

export class BoxPanelComponent implements Component {
  private lines: readonly string[];

  constructor(
    private readonly buildLines: () => readonly string[],
    private readonly borderToken: ColorToken = 'primary',
    private readonly title: string = '',
  ) {
    this.lines = buildLines();
  }

  invalidate(): void {
    this.lines = this.buildLines();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const paint = (s: string): string => currentTheme.fg(this.borderToken, s);
    const availableInterior = safeWidth - BOX_OVERHEAD;
    if (availableInterior < 1) {
      return [truncateToWidth(this.title.trim(), safeWidth, '…'), ...this.lines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const indent = ' '.repeat(LEFT_MARGIN);
    const longestLine = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const contentWidth = Math.max(1, Math.min(availableInterior, Math.max(longestLine, visibleWidth(this.title))));
    const horzLen = contentWidth + 2 * SIDE_PADDING;
    const title = truncateToWidth(this.title, horzLen, '…');

    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title));
    const top = indent + paint('╭') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('╮');
    const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

    const out: string[] = [top];
    for (const line of this.lines) {
      const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(indent + paint('│') + ' ' + clipped + ' '.repeat(pad) + ' ' + paint('│'));
    }
    out.push(bottom);
    return out.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
