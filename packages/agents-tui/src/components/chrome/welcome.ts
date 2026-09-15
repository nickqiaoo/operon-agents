/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box with the logo, session, model, and version.
 */

import type { Component } from 'operon-pi-tui';
import { truncateToWidth, visibleWidth } from 'operon-pi-tui';
import chalk from 'chalk';

import type { AppState } from '../../types.ts';
import { modelDisplayName } from '../../utils/model-catalog.ts';
import { currentTheme } from '../../theme/index.ts';

/**
 * The Operon mark — the ring with the yin-yang stroke and the `>` `_` prompt —
 * rasterised into braille cells, which pack 2x4 sub-pixels per character. That
 * density is what the S curve needs: quadrant blocks only manage 2x2, and at a
 * size the panel can afford the curve comes out as visible stair-stepping.
 */
const LOGO_LARGE = [
  '      ⣀⣤⣶⣶⣶⣶⣶⣶⣤⣀',
  '   ⢠⣴⣿⣿⣿⣿⣿⣿⣟⠛⠿⢿⣿⣿⣦⡀',
  '  ⣴⣿⣿⠟⠉⠉⠉⠙⢿⣿⣷⡀ ⠈⠻⣿⣿⣦',
  ' ⣼⣿⡿⠁ ⠻⣷⣦⣀⠈⣿⣿⡇   ⠈⢿⣿⣧',
  '⢸⣿⣿⠃  ⣠⣴⡿⠟⢡⣿⣿⡇    ⠘⣿⣿⡇',
  '⢸⣿⣿   ⠛⠉ ⣴⣿⣿⠟      ⣿⣿⡇',
  '⢸⣿⣿⡄    ⢸⣿⣿⠃      ⢠⣿⣿⡇',
  ' ⢻⣿⣷⡀   ⢸⣿⣿⡀⠘⠿⠿⠿⠗⢀⣾⣿⡟',
  '  ⠻⣿⣿⣦⡀ ⠈⢿⣿⣷⣄⣀⣀⣀⣴⣿⣿⠟',
  '   ⠈⠻⣿⣿⣷⣶⣤⣽⣿⣿⣿⣿⣿⣿⠟⠃',
  '      ⠉⠛⠿⠿⠿⠿⠿⠿⠛⠉',
] as const;

/** Same mark at a smaller cell budget, for narrower terminals. */
const LOGO_SMALL = [
  '   ⢀⣤⣴⣶⣾⣷⣶⣦⣤⡀',
  ' ⢀⣴⣿⠿⠛⠿⣿⣿⡍⠙⠻⣿⣦⡀',
  '⢀⣿⡿⠁⠺⢶⣄⡈⣿⣿  ⠈⢿⣿⡀',
  '⣸⣿⠇ ⢴⠾⠛⣱⣿⡟   ⠸⣿⣇',
  '⢹⣿⡆   ⣼⣿⠏    ⢰⣿⡏',
  '⠈⣿⣷⡀  ⣿⣿⡀⠛⠛⠛⢀⣾⣿⠁',
  ' ⠈⠻⣿⣦⣄⣘⣿⣿⣶⣤⣶⣿⠟⠁',
  '   ⠈⠛⠻⠿⢿⡿⠿⠟⠛⠁',
] as const;

/**
 * The brand gradient, lifted from the logo's own `helixGrad` stop list: it runs
 * top-left to bottom-right across the mark. Fixed rather than themed — a brand
 * mark that changes colour with the theme stops being the brand mark. The light
 * variant is the same ramp shifted a stop darker, so the mark keeps >= 3:1
 * against white the way the rest of the light palette does.
 */
const BRAND_GRADIENT_DARK = ['#9D92F5', '#7B72E4', '#5249C7'] as const;
const BRAND_GRADIENT_LIGHT = ['#7B72E4', '#6358DC', '#4038A8'] as const;

/** Brand ink for the panel chrome, picked from the same ramp as the mark. */
const BRAND_INK_DARK = { title: '#9D92F5', border: '#7B72E4' } as const;
const BRAND_INK_LIGHT = { title: '#4038A8', border: '#5249C7' } as const;

/**
 * The palette carries no light/dark flag, but body text gives it away: dark
 * themes set a light `text`, light themes a dark one.
 */
function isDarkTheme(): boolean {
  const hex = currentTheme.palette.text;
  const luma =
    parseInt(hex.slice(1, 3), 16) * 0.299 +
    parseInt(hex.slice(3, 5), 16) * 0.587 +
    parseInt(hex.slice(5, 7), 16) * 0.114;
  return luma > 128;
}

/** Samples the gradient at `t` in [0, 1], interpolating between the stops. */
function brandColor(t: number): string {
  const stops = isDarkTheme() ? BRAND_GRADIENT_DARK : BRAND_GRADIENT_LIGHT;
  const clamped = Math.min(1, Math.max(0, t));
  const span = 1 / (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(clamped / span));
  const local = (clamped - index * span) / span;
  const from = stops[index] ?? stops[0];
  const to = stops[index + 1] ?? stops[stops.length - 1]!;
  const channel = (offset: number): number => {
    const a = parseInt(from.slice(offset, offset + 2), 16);
    const b = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * local);
  };
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(channel(1))}${hex(channel(3))}${hex(channel(5))}`;
}

/** Paints one mark row, shading each cell by its position along the diagonal. */
function paintMark(row: string, rowIndex: number, rows: number, width: number): string {
  const lastCol = Math.max(1, width - 1);
  const lastRow = Math.max(1, rows - 1);
  let out = '';
  for (let col = 0; col < row.length; col++) {
    const cell = row[col];
    if (cell === ' ') {
      out += cell;
      continue;
    }
    out += chalk.hex(brandColor((col / lastCol + rowIndex / lastRow) / 2))(cell);
  }
  return out;
}

const LOGO_LARGE_WIDTH = 22;
const LOGO_SMALL_WIDTH = 16;

export class WelcomeComponent implements Component {
  private state: AppState;

  constructor(state: AppState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const ink = isDarkTheme() ? BRAND_INK_DARK : BRAND_INK_LIGHT;
    const frame = (s: string): string => chalk.hex(ink.border)(s);
    const title = (s: string): string => chalk.bold.hex(ink.title)(s);
    const isLoggedOut = !this.state.model;
    const activeModelLabel = modelDisplayName(this.state.model, this.state.availableModels[this.state.model]);

    if (safeWidth < 24) {
      const heading = title('Welcome to Operon!');
      const prompt = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)('No model set — pick one with /model.')
        : chalk.hex(currentTheme.palette.textDim)('Send /help for help information.');
      const model = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)('not set')
        : activeModelLabel;
      return ['', heading, prompt, `Model: ${model}`].map((line) =>
        truncateToWidth(line, safeWidth, '…'),
      );
    }

    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';
    const gap = '  ';

    // Pick the largest mark that still leaves room for the text column.
    const [logo, logoWidth] =
      innerWidth >= LOGO_LARGE_WIDTH + gap.length + 34
        ? [LOGO_LARGE, LOGO_LARGE_WIDTH]
        : innerWidth >= LOGO_SMALL_WIDTH + gap.length + 24
          ? [LOGO_SMALL, LOGO_SMALL_WIDTH]
          : [[] as readonly string[], 0];

    const hasLogo = logo.length > 0;
    const textWidth = hasLogo ? Math.max(4, innerWidth - logoWidth - gap.length) : innerWidth;

    const dim = chalk.hex(currentTheme.palette.textDim);
    const labelStyle = chalk.bold.hex(currentTheme.palette.textDim);
    const modelValue = isLoggedOut
      ? chalk.hex(currentTheme.palette.warning)('not set — pick one with /model')
      : activeModelLabel;

    const textLines = [
      title('Welcome to Operon!'),
      dim(isLoggedOut ? 'No model set — pick one with /model.' : 'Send /help for help information.'),
      '',
      labelStyle('Directory: ') + this.state.workDir,
      labelStyle('HarnessSession:   ') + this.state.sessionId,
      labelStyle('Model:     ') + modelValue,
      labelStyle('Version:   ') + this.state.version,
    ];

    if (this.state.mcpServersSummary) {
      textLines.push(labelStyle('MCP:       ') + this.state.mcpServersSummary);
    }

    // Lay the mark and the text side by side; whichever column is shorter just
    // runs out, so the panel is as tall as the taller of the two.
    const contentLines: string[] = [];
    const rowCount = hasLogo ? Math.max(logo.length, textLines.length) : textLines.length;
    for (let i = 0; i < rowCount; i++) {
      const text = truncateToWidth(textLines[i] ?? '', textWidth, '…');
      if (!hasLogo) {
        contentLines.push(text);
        continue;
      }
      const markRow = logo[i] ?? '';
      const markPad = ' '.repeat(Math.max(0, logoWidth - visibleWidth(markRow)));
      contentLines.push(paintMark(markRow, i, logo.length, logoWidth) + markPad + gap + text);
    }

    const lines: string[] = [
      '',
      frame('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      frame('│') + ' '.repeat(safeWidth - 2) + frame('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(frame('│') + pad + truncated + ' '.repeat(rightPad) + frame('│'));
    }

    lines.push(frame('│') + ' '.repeat(safeWidth - 2) + frame('│'));
    lines.push(frame('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
