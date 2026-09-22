import type { HarnessSession, PluginSummary } from 'operon-agents';
import { ServiceUnavailableError } from 'operon-agents';

import { PluginsSelectorComponent } from '../components/dialogs/plugins-selector.ts';
import { formatErrorMessage } from '../utils/event-payload.ts';
import { formatPluginSourceLabel } from '../utils/plugin-source-label.ts';
import type { SlashCommandHost } from './dispatch.ts';

/**
 * `/plugins` — the installed set, and the actions over it. With no argument it opens the picker;
 * `install <source>`, `remove <id>`, `enable <id>`, `disable <id>` and `reload` act directly so a
 * script or a muscle-memory user never has to go through the panel.
 */
const NO_PLUGINS_MESSAGE = 'Plugins are not enabled for this session.';

export async function handlePluginsCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session ?? (await host.ensureSession());
  if (session === undefined) return;
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter((part) => part.length > 0);
  const subject = rest.join(' ');

  switch (verb) {
    case '':
      await showPluginsPicker(host, session);
      return;
    case 'install':
      await runPluginAction(host, session, subject, 'Usage: /plugins install <github-repo | path | zip-url>', async (source) => {
        const plugin = await session.plugins.installSummary(source);
        return `Installed ${plugin.displayName} (${plugin.id}).`;
      });
      return;
    case 'remove':
    case 'uninstall':
      await runPluginAction(host, session, subject, 'Usage: /plugins remove <plugin-id>', async (id) => {
        await session.plugins.remove(id);
        return `Removed ${id}.`;
      });
      return;
    case 'enable':
      await runPluginAction(host, session, subject, 'Usage: /plugins enable <plugin-id>', async (id) => {
        await session.plugins.setEnabled(id, true);
        return `Enabled ${id}.`;
      });
      return;
    case 'disable':
      await runPluginAction(host, session, subject, 'Usage: /plugins disable <plugin-id>', async (id) => {
        await session.plugins.setEnabled(id, false);
        return `Disabled ${id}.`;
      });
      return;
    case 'reload':
      try {
        const summary = await session.plugins.reload();
        const parts = [`+${String(summary.added.length)}`, `-${String(summary.removed.length)}`];
        if (summary.errors.length > 0) parts.push(`${String(summary.errors.length)} failed`);
        host.showStatus(`Reloaded plugins (${parts.join(' ')}).`, summary.errors.length > 0 ? 'warning' : 'success');
        for (const failure of summary.errors) host.showStatus(`${failure.id}: ${failure.message}`, 'error');
        await host.refreshSkillCommands(session);
        await host.refreshSessionCommands(session);
      } catch (error) {
        host.showError(error instanceof ServiceUnavailableError ? NO_PLUGINS_MESSAGE : `Failed to reload plugins: ${formatErrorMessage(error)}`);
      }
      return;
    default:
      host.showError('Usage: /plugins [install <source> | remove <id> | enable <id> | disable <id> | reload]');
      return;
  }
}

async function runPluginAction(
  host: SlashCommandHost,
  session: HarnessSession,
  subject: string,
  usage: string,
  run: (subject: string) => Promise<string>,
): Promise<void> {
  if (subject.length === 0) {
    host.showError(usage);
    return;
  }
  const spinner = host.showProgressSpinner(`${usage.split(' ')[1] ?? 'Working'}…`);
  try {
    const message = await run(subject);
    spinner.stop({ ok: true, label: message });
    await host.refreshSkillCommands(session);
    await host.refreshSessionCommands(session);
  } catch (error) {
    spinner.stop({ ok: false, label: error instanceof ServiceUnavailableError ? NO_PLUGINS_MESSAGE : formatErrorMessage(error) });
  }
}

async function showPluginsPicker(host: SlashCommandHost, session: HarnessSession): Promise<void> {
  let plugins: readonly PluginSummary[];
  try {
    plugins = await session.plugins.summaries();
  } catch (error) {
    host.showError(error instanceof ServiceUnavailableError ? NO_PLUGINS_MESSAGE : `Failed to list plugins: ${formatErrorMessage(error)}`);
    return;
  }
  if (plugins.length === 0) {
    host.showStatus('No plugins installed. Add one with /plugins install <source>.', 'textMuted');
    return;
  }
  const panel = new PluginsSelectorComponent({
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      version: plugin.version,
      enabled: plugin.enabled,
      state: plugin.state,
      hasErrors: plugin.hasErrors,
      source: formatPluginSourceLabel(plugin),
      detail: [
        `${String(plugin.skillCount)} skill${plugin.skillCount === 1 ? '' : 's'}`,
        `${String(plugin.enabledMcpServerCount)}/${String(plugin.mcpServerCount)} MCP`,
      ].join(' · '),
    })),
    onToggle: (id, enabled) => {
      void (async () => {
        try {
          await session.plugins.setEnabled(id, enabled);
          await host.refreshSkillCommands(session);
          await host.refreshSessionCommands(session);
        } catch (error) {
          host.showError(`Failed to ${enabled ? 'enable' : 'disable'} ${id}: ${formatErrorMessage(error)}`);
        }
      })();
    },
    onRemove: (id) => {
      host.restoreEditor();
      void runPluginAction(host, session, id, 'Usage: /plugins remove <plugin-id>', async (target) => {
        await session.plugins.remove(target);
        return `Removed ${target}.`;
      });
    },
    onClose: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(panel);
}
