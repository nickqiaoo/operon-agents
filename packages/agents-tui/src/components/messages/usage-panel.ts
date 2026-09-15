/** `/usage` — tokens spent this session against the active model's context window. */

import type { Component } from 'operon-pi-tui';

import { BoxPanelComponent } from './box-panel.ts';

import { currentTheme } from '../../theme/index.ts';
import { formatTokenCount, ratioSeverity, renderProgressBar, safeUsageRatio, usagePercent } from '../../app/utils/usage/usage-format.ts';

export interface UsageReportOptions {
  readonly model: string;
  /** Run-total tokens across every turn of this session. */
  readonly cumulativeTokens: number;
  /** Tokens the model saw on the most recent turn. */
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
}

export function buildUsageReportLines(options: UsageReportOptions, width: number): string[] {
  const ratio = safeUsageRatio(options.contextUsage, options.contextTokens, options.maxContextTokens);
  const severity = ratioSeverity(ratio);
  const barWidth = Math.max(10, Math.min(40, width - 24));
  const lines = [     `  ${currentTheme.fg('textMuted', 'Model      ')}  ${currentTheme.fg('text', options.model)}`,
    `  ${currentTheme.fg('textMuted', 'Session    ')}  ${currentTheme.fg('text', `${formatTokenCount(options.cumulativeTokens)} tokens`)}`,
  ];
  if (options.maxContextTokens > 0) {
    lines.push(
      `  ${currentTheme.fg('textMuted', 'Context    ')}  ${currentTheme.fg('text', `${formatTokenCount(options.contextTokens)} / ${formatTokenCount(options.maxContextTokens)}`)} ${currentTheme.fg(severity, `${usagePercent(ratio)}`)}`,
      `  ${' '.repeat(13)}${renderProgressBar(ratio, barWidth, severity)}`,
    );
  } else {
    lines.push(`  ${currentTheme.fg('textMuted', 'Context    ')}  ${currentTheme.fg('textDim', 'measured at the first turn boundary')}`);
  }
  return lines;
}

export class UsagePanelComponent implements Component {
  private readonly panel: BoxPanelComponent;

  constructor(options: UsageReportOptions) {
    this.panel = new BoxPanelComponent(() => buildUsageReportLines(options, 60), 'primary', ' Usage ');
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return ['', ...this.panel.render(width)];
  }
}
