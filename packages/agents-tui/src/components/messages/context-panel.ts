/**
 * `/context` — what actually fills the window: system prompt, tool schemas, messages, and each
 * turn-boundary injection, largest first. Read from the engine's own measurement so the figures
 * match what the model was sent.
 */

import type { Component } from 'operon-pi-tui';

import { BoxPanelComponent } from './box-panel.ts';
import type { ContextBreakdown } from 'operon-agents';

import { currentTheme } from '../../theme/index.ts';
import { formatTokenCount, ratioSeverity, renderProgressBar, usagePercent } from '../../app/utils/usage/usage-format.ts';

interface Slice {
  readonly label: string;
  readonly tokens: number;
  readonly percent: number;
}

function slices(breakdown: ContextBreakdown): readonly Slice[] {
  const out: Slice[] = [
    { label: 'System prompt', tokens: breakdown.systemPrompt.tokens, percent: breakdown.systemPrompt.percent },
    { label: 'Tools (built-in)', tokens: breakdown.toolsBuiltin.tokens, percent: breakdown.toolsBuiltin.percent },
    { label: 'Tools (MCP)', tokens: breakdown.toolsMcp.tokens, percent: breakdown.toolsMcp.percent },
    { label: 'Messages', tokens: breakdown.messages.tokens, percent: breakdown.messages.percent },
  ];
  for (const injection of breakdown.injections) {
    out.push({ label: `Injection: ${injection.id}`, tokens: injection.tokens, percent: injection.percent });
  }
  out.push(
    { label: 'Compaction reserve', tokens: breakdown.compactBuffer.tokens, percent: breakdown.compactBuffer.percent },
    { label: 'Free', tokens: breakdown.free.tokens, percent: breakdown.free.percent },
  );
  return out.filter((slice) => slice.tokens > 0);
}

export function buildContextReportLines(breakdown: ContextBreakdown, width: number): string[] {
  const rows = slices(breakdown);
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const ratio = breakdown.contextWindow > 0 ? breakdown.used / breakdown.contextWindow : 0;
  const barWidth = Math.max(10, Math.min(32, width - labelWidth - 26));
  const lines = [     `  ${currentTheme.fg('textMuted', 'Model'.padEnd(labelWidth))}  ${currentTheme.fg('text', breakdown.model)}`,
    `  ${currentTheme.fg('textMuted', 'Used'.padEnd(labelWidth))}  ${currentTheme.fg('text', `${formatTokenCount(breakdown.used)} / ${formatTokenCount(breakdown.contextWindow)}`)} ${currentTheme.fg(ratioSeverity(ratio), usagePercent(ratio))}`,
    '',
  ];
  for (const row of rows) {
    const bar = renderProgressBar(row.percent / 100, barWidth, 'primary');
    lines.push(
      `  ${currentTheme.fg('textMuted', row.label.padEnd(labelWidth))}  ${currentTheme.fg('text', formatTokenCount(row.tokens).padStart(8))}  ${bar} ${currentTheme.fg('textDim', `${row.percent.toFixed(1)}%`)}`,
    );
  }
  return lines;
}

export class ContextPanelComponent implements Component {
  private readonly panel: BoxPanelComponent;

  constructor(breakdown: ContextBreakdown) {
    this.panel = new BoxPanelComponent(() => buildContextReportLines(breakdown, 70), 'primary', ' Context ');
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return ['', ...this.panel.render(width)];
  }
}
