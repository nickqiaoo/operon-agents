/**
 * `/status` — session identity plus the runtime knobs that decide how a turn runs. Framed like
 * `/usage` so the two panels read as one family.
 */

import type { Component } from 'operon-pi-tui';

import { BoxPanelComponent } from './box-panel.ts';

import { PRODUCT_NAME } from '../../app/constant/app.ts';
import { currentTheme } from '../../theme/index.ts';

export interface StatusReportOptions {
  readonly version: string;
  readonly model: string;
  readonly thinking: string;
  readonly permission: string;
  readonly planMode: boolean;
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly mcpServers: number;
  readonly skills: number;
  readonly plugins: number;
}

interface FieldRow {
  readonly label: string;
  readonly value: string;
}

function rows(options: StatusReportOptions): readonly FieldRow[] {
  return [
    { label: 'Version', value: `${PRODUCT_NAME} TUI ${options.version}` },
    { label: 'Session', value: options.sessionId.length > 0 ? options.sessionId : '(not created yet)' },
    ...(options.sessionTitle !== null && options.sessionTitle.length > 0 ? [{ label: 'Title', value: options.sessionTitle }] : []),
    { label: 'Workspace', value: options.workDir },
    { label: 'Model', value: options.model.length > 0 ? options.model : '(none)' },
    { label: 'Thinking', value: options.thinking },
    { label: 'Permission', value: options.permission },
    { label: 'Plan mode', value: options.planMode ? 'on' : 'off' },
    { label: 'MCP servers', value: String(options.mcpServers) },
    { label: 'Skills', value: String(options.skills) },
    { label: 'Plugins', value: String(options.plugins) },
  ];
}

export function buildStatusReportLines(options: StatusReportOptions): string[] {
  const fields = rows(options);
  const labelWidth = Math.max(...fields.map((field) => field.label.length));
  return [     ...fields.map(
      (field) => `  ${currentTheme.fg('textMuted', field.label.padEnd(labelWidth))}  ${currentTheme.fg('text', field.value)}`,
    ),
  ];
}

export class StatusPanelComponent implements Component {
  private readonly panel: BoxPanelComponent;

  constructor(options: StatusReportOptions) {
    this.panel = new BoxPanelComponent(() => buildStatusReportLines(options), 'primary', ' Status ');
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return ['', ...this.panel.render(width)];
  }
}
