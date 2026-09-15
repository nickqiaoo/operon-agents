import {
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
  type BuiltinSlashCommand,
  type BuiltinSlashCommandName,
} from './registry.ts';
import { parseSlashInput } from './parse.ts';
import type { TUIState } from '../tui-state.ts';
import type { SlashCommandBusyReason, SlashCommandInvalidReason } from './types.ts';

export type SlashCommandIntent =
  | { readonly kind: 'not-command' }
  | {
      readonly kind: 'builtin';
      readonly command: BuiltinSlashCommand;
      readonly name: BuiltinSlashCommandName;
      readonly args: string;
    }
  | {
      readonly kind: 'skill';
      readonly commandName: string;
      readonly skillName: string;
      readonly args: string;
    }
  | {
      /** A command the engine itself answers, run through `session.runCommand`. */
      readonly kind: 'session-command';
      readonly commandName: string;
      readonly args: string;
    }
  | { readonly kind: 'message'; readonly input: string }
  | {
      readonly kind: 'blocked';
      readonly commandName: string;
      readonly reason: SlashCommandBusyReason;
    }
  | {
      readonly kind: 'invalid';
      readonly commandName: string;
      readonly reason: SlashCommandInvalidReason;
    };

export interface ResolveSlashCommandInput {
  readonly input: string;
  readonly skillCommandMap: ReadonlyMap<string, string>;
  /** Names the session's own command registry answers to (engine + extension commands). */
  readonly sessionCommandNames: ReadonlySet<string>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
}

/**
 * Resolution order: a TUI builtin wins (it is closest to the user), then a skill, then the
 * session's own command registry, and anything else is a plain message.
 */
export function resolveSlashCommandInput(options: ResolveSlashCommandInput): SlashCommandIntent {
  const parsed = parseSlashInput(options.input);
  if (parsed === null) return { kind: 'not-command' };

  const command = findBuiltInSlashCommand(parsed.name);
  if (command !== undefined) {
    const busyReason = slashCommandBusyReason(options);
    if (busyReason !== undefined && resolveSlashCommandAvailability(command, parsed.args) === 'idle-only') {
      return { kind: 'blocked', commandName: parsed.name, reason: busyReason };
    }
    return { kind: 'builtin', command, name: command.name, args: parsed.args };
  }

  const skillName = resolveSkillCommand(options.skillCommandMap, parsed.name);
  if (skillName !== undefined) {
    // Skill activations are never blocked by a busy session: the TUI queues them behind the
    // running turn exactly like normal messages, and Ctrl-S steers them as real activations.
    return { kind: 'skill', commandName: parsed.name, skillName, args: parsed.args.trim() };
  }

  if (options.sessionCommandNames.has(parsed.name)) {
    const busyReason = slashCommandBusyReason(options);
    if (busyReason !== undefined) {
      return { kind: 'blocked', commandName: parsed.name, reason: busyReason };
    }
    return { kind: 'session-command', commandName: parsed.name, args: parsed.args.trim() };
  }

  return { kind: 'message', input: options.input };
}

export function resolveSkillCommand(skillCommandMap: ReadonlyMap<string, string>, commandName: string): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

export function slashCommandBusyReason(
  options: Pick<ResolveSlashCommandInput, 'isStreaming' | 'isCompacting'>,
): SlashCommandBusyReason | undefined {
  if (options.isStreaming) return 'streaming';
  if (options.isCompacting) return 'compacting';
  return undefined;
}

export function slashBusyMessage(commandName: string, reason: SlashCommandBusyReason): string {
  if (reason === 'streaming') return `Cannot /${commandName} while streaming — press Esc or Ctrl-C first.`;
  return `Cannot /${commandName} while compacting — wait for compaction to finish first.`;
}

/**
 * Whether a delayed input restore is still safe: the editor must be empty (no newer draft) and
 * still mounted (no panel opened meanwhile). Restores that run synchronously with submit do not
 * need this.
 */
export function canRestoreSubmittedInput(host: { state: TUIState }): boolean {
  return host.state.editor.getText().length === 0 && !host.state.editorReplacementMounted;
}
