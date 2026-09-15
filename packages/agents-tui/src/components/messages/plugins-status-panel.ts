/** `/plugins` status card: one installed plugin in detail, or the whole set in brief. */

import type { Component } from 'operon-pi-tui';
import type { PluginInfo, PluginSummary } from 'operon-agents';

import { FAILURE_MARK, STATUS_BULLET, SUCCESS_MARK } from '../../constant/symbols.ts';
import { currentTheme } from '../../theme/index.ts';
import { formatPluginSourceLabel } from '../../utils/plugin-source-label.ts';
import { BoxPanelComponent } from './box-panel.ts';

function stateMark(plugin: PluginSummary): string {
  if (plugin.hasErrors) return currentTheme.fg('error', FAILURE_MARK);
  if (!plugin.enabled) return currentTheme.fg('textMuted', STATUS_BULLET.trimEnd());
  return currentTheme.fg('success', SUCCESS_MARK);
}

export function buildPluginsSummaryLines(plugins: readonly PluginSummary[]): string[] {
  if (plugins.length === 0) return [currentTheme.fg('textMuted', 'No plugins installed.')];
  const nameWidth = Math.max(...plugins.map((plugin) => plugin.displayName.length));
  return plugins.map((plugin) => {
    const name = plugin.displayName.padEnd(nameWidth);
    const version = plugin.version === undefined ? '' : ` v${plugin.version}`;
    const counts = `${String(plugin.skillCount)} skill${plugin.skillCount === 1 ? '' : 's'} · ${String(plugin.enabledMcpServerCount)}/${String(plugin.mcpServerCount)} MCP`;
    return `${stateMark(plugin)} ${currentTheme.fg('text', name)}${currentTheme.fg('textMuted', version)}  ${currentTheme.fg('textMuted', counts)}  ${currentTheme.fg('textDim', formatPluginSourceLabel(plugin))}`;
  });
}

export function buildPluginDetailLines(info: PluginInfo): string[] {
  const label = (text: string): string => currentTheme.fg('textMuted', text.padEnd(14));
  const value = (text: string): string => currentTheme.fg('text', text);
  const lines: string[] = [
    `${label('Id')}${value(info.id)}`,
    `${label('Name')}${value(info.displayName)}`,
    ...(info.version === undefined ? [] : [`${label('Version')}${value(info.version)}`]),
    `${label('State')}${value(`${info.state}${info.enabled ? '' : ' (disabled)'}`)}`,
    `${label('Source')}${value(formatPluginSourceLabel(info))}`,
    `${label('Root')}${value(info.root)}`,
    `${label('Installed')}${value(info.installedAt)}`,
    ...(info.updatedAt === undefined ? [] : [`${label('Updated')}${value(info.updatedAt)}`]),
    `${label('Skills')}${value(String(info.skillCount))}`,
  ];
  if (info.mcpServers.length > 0) {
    lines.push('', currentTheme.fg('textMuted', 'MCP servers'));
    for (const server of info.mcpServers) {
      lines.push(`  ${server.enabled ? currentTheme.fg('success', SUCCESS_MARK) : currentTheme.fg('textMuted', STATUS_BULLET.trimEnd())} ${currentTheme.fg('text', server.name)}`);
    }
  }
  if (info.diagnostics.length > 0) {
    lines.push('', currentTheme.fg('error', 'Diagnostics'));
    for (const diagnostic of info.diagnostics) {
      lines.push(`  ${currentTheme.fg('error', diagnostic.message)}`);
    }
  }
  return lines;
}

export class PluginsStatusPanelComponent implements Component {
  private readonly panel: BoxPanelComponent;

  constructor(plugins: readonly PluginSummary[]) {
    this.panel = new BoxPanelComponent(() => buildPluginsSummaryLines(plugins), 'primary', ' Plugins ');
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return ['', ...this.panel.render(width)];
  }
}

export class PluginDetailPanelComponent implements Component {
  private readonly panel: BoxPanelComponent;

  constructor(info: PluginInfo) {
    this.panel = new BoxPanelComponent(() => buildPluginDetailLines(info), 'primary', ` ${info.displayName} `);
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return ['', ...this.panel.render(width)];
  }
}
