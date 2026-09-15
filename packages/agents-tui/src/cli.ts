import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { PermissionMode, ThinkingLevel } from 'operon-agents';

import { isPermissionMode, PERMISSION_MODES } from './utils/permission-mode.ts';
import { isThinkingLevel, THINKING_LEVELS } from './utils/thinking.ts';

export interface CliOptions {
  readonly model: string | undefined;
  readonly workDir: string;
  readonly homeDir: string;
  readonly permission: PermissionMode | undefined;
  readonly thinking: ThinkingLevel | undefined;
  readonly plan: boolean;
  /** `--session <id>`; an empty string means "open the picker". */
  readonly sessionId: string | undefined;
  readonly continueLast: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let model = env['OPERON_MODEL'];
  let workDir = process.cwd();
  let homeDir = env['OPERON_AGENT_HOME'] ?? resolve(homedir(), '.operon');
  let permission: PermissionMode | undefined;
  let thinking: ThinkingLevel | undefined;
  let plan = false;
  let sessionId: string | undefined;
  let continueLast = false;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value after ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === '--') continue;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--version' || arg === '-V') version = true;
    else if (arg === '--model' || arg === '-m') model = next();
    else if (arg === '--work-dir' || arg === '-C') workDir = next();
    else if (arg === '--home-dir') homeDir = next();
    else if (arg === '--plan') plan = true;
    else if (arg === '--continue' || arg === '-c') continueLast = true;
    else if (arg === '--yolo') permission = 'yolo';
    else if (arg === '--session' || arg === '-s' || arg === '--resume' || arg === '-r') {
      // `--session` with no value (or followed by another flag) opens the picker.
      const peek = argv[index + 1];
      if (peek === undefined || peek.startsWith('-')) sessionId = '';
      else sessionId = next();
    } else if (arg === '--permission') {
      const value = next();
      if (!isPermissionMode(value)) throw new Error(`Permission mode must be one of ${PERMISSION_MODES.join(', ')}.`);
      permission = value;
    } else if (arg === '--thinking') {
      const value = next();
      if (!isThinkingLevel(value)) throw new Error(`Thinking level must be one of ${THINKING_LEVELS.join(', ')}.`);
      thinking = value;
    } else {
      throw new Error(`Unknown option ${JSON.stringify(arg)}.`);
    }
  }

  return {
    model,
    workDir: resolve(workDir),
    homeDir: resolve(homeDir),
    permission,
    thinking,
    plan,
    sessionId,
    continueLast,
    help,
    version,
  };
}

export function helpText(): string {
  return `operon-tui — a terminal client for operon-agents

Usage:
  operon-tui [options]

Options:
  -m, --model <provider/model>  Model to start on (default: OPERON_MODEL, or tui.toml's default_model)
  -C, --work-dir <path>         The agent's workspace (default: the current directory)
      --home-dir <path>         Where sessions are stored (default: OPERON_AGENT_HOME or ~/.operon)
  -s, --session [id]            Resume a session by id; with no id, pick one from a list
  -c, --continue                Resume the most recent session in this workspace
      --permission <mode>       ${PERMISSION_MODES.join(' | ')} (default: manual)
      --thinking <level>        ${THINKING_LEVELS.join(' | ')}
      --plan                    Start in plan mode
      --yolo                    Shorthand for --permission yolo
  -V, --version                 Print the version
  -h, --help                    Show this help

Inside the TUI, /help lists every command and shortcut. Client preferences (theme, editor,
notifications, the status line) live in ~/.operon/tui.toml.

Model credentials come from the provider's own environment variables, for example
ANTHROPIC_API_KEY or OPENAI_API_KEY. An endpoint the engine does not ship with -- a local
server, a gateway, a proxy -- is declared in ~/.operon/providers.toml, and /model then offers
whatever that endpoint reports it serves.`;
}
