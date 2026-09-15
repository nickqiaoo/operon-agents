import type { AutocompleteItem, SlashCommand } from 'operon-pi-tui';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface TuiSlashCommand<Name extends string = string> extends SlashCommand {
  readonly name: Name;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly priority?: number;
  readonly availability?: SlashCommandAvailability | ((args: string) => SlashCommandAvailability);
  /**
   * Generic argument autocompletion. `argumentPrefix` is the text typed after
   * `/<command> `; return suggestions or `null`. Declared as a plain function
   * property (not a method) so passing it around is `this`-free. Adapted to
   * pi-tui's `getArgumentCompletions` in the autocomplete setup.
   */
  readonly completeArgs?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashCommandBusyReason = 'streaming' | 'compacting';

export type SlashCommandInvalidReason = 'unknown';
