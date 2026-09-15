/** `/mcp` — one row per configured MCP server: state, transport and tool count. */

import type { Component } from 'operon-pi-tui';

import { BoxPanelComponent } from './box-panel.ts';

import { currentTheme } from '../../theme/index.ts';
import type { ColorToken } from '../../theme/index.ts';
import { FAILURE_MARK, STATUS_BULLET, SUCCESS_MARK } from '../../constant/symbols.ts';
import type { McpServerStatusSnapshot } from '../../utils/mcp-server-status.ts';

function statusMark(status: McpServerStatusSnapshot['status']): { mark: string; token: ColorToken; label: string } {
  switch (status) {
    case 'connected':
      return { mark: SUCCESS_MARK, token: 'success', label: 'connected' };
    case 'failed':
      return { mark: FAILURE_MARK, token: 'error', label: 'failed' };
    case 'needs-auth':
      return { mark: STATUS_BULLET.trimEnd(), token: 'warning', label: 'needs auth' };
    case 'disabled':
      return { mark: STATUS_BULLET.trimEnd(), token: 'textMuted', label: 'disabled' };
    case 'pending':
      return { mark: STATUS_BULLET.trimEnd(), token: 'textDim', label: 'connecting' };
  }
}

export function buildMcpStatusLines(servers: readonly McpServerStatusSnapshot[]): string[] {
  const nameWidth = Math.max(4, ...servers.map((server) => server.name.length));
  const lines: string[] = [];
  for (const server of servers) {
    const { mark, token, label } = statusMark(server.status);
    const tools = server.status === 'connected' ? ` · ${String(server.toolCount)} tool${server.toolCount === 1 ? '' : 's'}` : '';
    let line = `  ${currentTheme.fg(token, mark)} ${currentTheme.fg('text', server.name.padEnd(nameWidth))}`;
    line += `  ${currentTheme.fg(token, label)}${currentTheme.fg('textMuted', ` (${server.transport})${tools}`)}`;
    lines.push(line);
    if (server.error !== undefined && server.error.length > 0) {
      lines.push(`    ${currentTheme.fg('textDim', server.error)}`);
    }
  }
  return lines;
}

export class McpStatusPanelComponent implements Component {
  private readonly panel: BoxPanelComponent;

  constructor(servers: readonly McpServerStatusSnapshot[]) {
    this.panel = new BoxPanelComponent(() => buildMcpStatusLines(servers), 'primary', ' MCP servers ');
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return ['', ...this.panel.render(width)];
  }
}
