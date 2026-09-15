import { loadTuiConfig, TuiConfigParseError, type TuiConfig } from '../config.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import type { SlashCommandHost } from './dispatch.ts';

/**
 * `/reload-tui` — re-read `tui.toml` and apply what it changed. Model, permissions and skills
 * come from the harness, not from a client config file, so nothing else needs reloading.
 */
export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  let config: TuiConfig;
  try {
    config = await loadTuiConfig();
  } catch (error) {
    if (error instanceof TuiConfigParseError) {
      host.showError(error.message);
      return;
    }
    host.showError(`Failed to reload tui.toml: ${formatErrorMessage(error)}`);
    return;
  }
  host.setAppState({
    theme: config.theme,
    renderLatex: config.renderLatex,
    disablePasteBurst: config.disablePasteBurst,
    editorCommand: config.editorCommand,
    notifications: config.notifications,
    statusLine: config.statusLine,
  });
  await host.applyTheme(config.theme);
  host.refreshTerminalThemeTracking();
  host.refreshSlashCommandAutocomplete();
  host.showStatus('Reloaded tui.toml.', 'success');
}
