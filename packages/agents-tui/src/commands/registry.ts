import type { AutocompleteItem } from 'operon-pi-tui';

import { completeLeadingArg, type ArgCompletionSpec } from './complete-args.ts';
import type { TuiSlashCommand, SlashCommandAvailability } from './types.ts';

/** Subcommands offered when autocompleting `/goal <…>`. */
const GOAL_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'status', description: 'Show the current goal' },
  { value: 'pause', description: 'Pause the active goal' },
  { value: 'resume', description: 'Resume a paused goal' },
  { value: 'cancel', description: 'Cancel and remove the current goal' },
  { value: 'replace', description: 'Replace the current goal with a new objective' },
];

/** Argument autocompletion for the `/goal` command (subcommands). */
export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(GOAL_ARG_COMPLETIONS, argumentPrefix);
}

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: "permission",
    aliases: [],
    description: "Choose how tool actions are approved",
    priority: 100,
    availability: "always",
  },
  {
    name: "settings",
    aliases: ["config"],
    description: "Open TUI settings",
    priority: 100,
    availability: "always",
  },
  {
    name: "plan",
    aliases: [],
    description: "Toggle plan mode",
    priority: 100,
    argumentHint: "[on|off|clear]",
    availability: (args) => (args.trim().toLowerCase() === "clear" ? "idle-only" : "always"),
  },
  {
    name: "model",
    aliases: [],
    description: "Switch the active model",
    priority: 100,
    argumentHint: "[provider/model]",
    availability: "always",
  },
  {
    name: "thinking",
    aliases: ["effort"],
    description: "Set how much the model thinks before answering",
    priority: 95,
    argumentHint: "[minimal|low|medium|high|xhigh|max]",
    availability: "always",
  },
  {
    name: "help",
    aliases: ["h", "?"],
    description: "Show available commands and shortcuts",
    priority: 80,
    availability: "always",
  },
  {
    name: "new",
    aliases: ["clear"],
    description: "Start a fresh session in the current workspace",
    priority: 80,
  },
  {
    name: "sessions",
    aliases: ["resume"],
    description: "Browse and resume sessions",
    priority: 80,
  },
  {
    name: "continue",
    aliases: [],
    description: "Answer a durable interruption and resume the run",
    priority: 80,
  },
  {
    name: "tasks",
    aliases: ["task"],
    description: "Browse background tasks",
    priority: 80,
    availability: "always",
  },
  {
    name: "compact",
    aliases: [],
    description: "Compact the conversation context",
    priority: 80,
    argumentHint: "[instruction]",
  },
  {
    name: "goal",
    aliases: [],
    description: "Start or manage an autonomous goal",
    priority: 80,
    argumentHint: "[status|pause|resume|cancel|replace] | <objective>",
    completeArgs: goalArgumentCompletions,
    // status / pause / cancel are always available; creating, replacing and resuming start a turn.
    availability: (args) => {
      const trimmed = args.trim();
      return trimmed === "" || trimmed === "status" || trimmed === "pause" || trimmed === "cancel"
        ? "always"
        : "idle-only";
    },
  },
  {
    name: "mcp",
    aliases: [],
    description: "Show MCP server status",
    priority: 60,
    availability: "always",
  },
  {
    name: "plugins",
    aliases: [],
    description: "Manage plugins",
    priority: 60,
    availability: "always",
  },
  {
    name: "init",
    aliases: [],
    description: "Analyze the codebase and generate AGENTS.md",
  },
  {
    name: "fork",
    aliases: [],
    description: "Fork the current session into a copy without switching to it",
    priority: 80,
  },
  {
    name: "title",
    aliases: ["rename"],
    description: "Set or show the session title",
    priority: 60,
    argumentHint: "<title>",
    availability: "always",
  },
  {
    name: "usage",
    aliases: [],
    description: "Show session tokens and the context window",
    priority: 60,
    availability: "always",
  },
  {
    name: "context",
    aliases: [],
    description: "Break down what fills the context window",
    priority: 60,
    availability: "always",
  },
  {
    name: "status",
    aliases: [],
    description: "Show current session and runtime status",
    priority: 60,
    availability: "always",
  },
  {
    name: "editor",
    aliases: [],
    description: "Set the external editor for Ctrl-G",
    priority: 60,
    availability: "always",
  },
  {
    name: "theme",
    aliases: [],
    description: "Set the terminal UI theme",
    priority: 60,
    availability: "always",
  },
  {
    name: "reload-tui",
    aliases: [],
    description: "Reload tui.toml UI preferences",
    priority: 40,
    availability: "always",
  },
  {
    name: "export-md",
    aliases: ["export"],
    description: "Export the current session as a Markdown file",
    priority: 40,
  },
  {
    name: "copy",
    aliases: [],
    description: "Copy the last assistant message to the clipboard",
    priority: 40,
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Exit the application",
    priority: 20,
  },
  {
    name: "version",
    aliases: [],
    description: "Show version information",
    priority: 20,
    availability: "always",
  },
] as const satisfies readonly TuiSlashCommand[];

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly TuiSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

export function resolveSlashCommandAvailability(
  command: TuiSlashCommand,
  args: string,
): SlashCommandAvailability {
  const availability = command.availability ?? 'idle-only';
  return typeof availability === 'function' ? availability(args) : availability;
}

export function sortSlashCommands(commands: readonly TuiSlashCommand[]): TuiSlashCommand[] {
  return [...commands].toSorted(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}
