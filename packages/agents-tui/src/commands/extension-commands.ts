import type { CommandInfo } from 'operon-agents';

import type { TuiSlashCommand } from './types.ts';

export interface ExtensionSlashCommands {
  readonly commands: readonly TuiSlashCommand[];
  /** Every name (and alias) the session's command registry answers to. */
  readonly commandNames: ReadonlySet<string>;
}

/**
 * The session's own slash commands — the engine's static registry plus the ones extensions
 * registered — become `/name` entries the TUI forwards to `session.runCommand`. A builtin TUI
 * command of the same name wins (the TUI layer is closer to the user); everything else is the
 * engine's to answer.
 */
export function buildExtensionSlashCommands(
  infos: readonly CommandInfo[],
  reservedNames: ReadonlySet<string>,
): ExtensionSlashCommands {
  const commandNames = new Set<string>();
  const commands: TuiSlashCommand[] = [];
  for (const info of infos) {
    if (reservedNames.has(info.name)) continue;
    commandNames.add(info.name);
    for (const alias of info.aliases) commandNames.add(alias);
    commands.push({ name: info.name, aliases: [...info.aliases], description: info.description });
  }
  return { commands, commandNames };
}
