import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PermissionMode, ThinkingLevel } from "operon-agents";

export interface CliOptions {
  readonly model: string;
  readonly workDir: string;
  readonly homeDir: string;
  readonly permission: PermissionMode;
  readonly thinking?: ThinkingLevel;
  readonly sessionId?: string;
  readonly continueLast: boolean;
  readonly help: boolean;
}

const PERMISSIONS = new Set<PermissionMode>(["manual", "workspace", "auto", "yolo"]);
const THINKING = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let model = env.OPERON_MODEL ?? env.MODEL ?? "anthropic/claude-opus-4-8";
  let workDir = process.cwd();
  let homeDir = env.OPERON_HOME ?? resolve(homedir(), ".operon");
  let permission: PermissionMode = "manual";
  let thinking: ThinkingLevel | undefined;
  let sessionId: string | undefined;
  let continueLast = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value after ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--model" || arg === "-m") model = next();
    else if (arg === "--work-dir" || arg === "-C") workDir = next();
    else if (arg === "--home-dir") homeDir = next();
    else if (arg === "--session" || arg === "-s") sessionId = next();
    else if (arg === "--continue" || arg === "-c") continueLast = true;
    else if (arg === "--yolo") permission = "yolo";
    else if (arg === "--permission") {
      const value = next() as PermissionMode;
      if (!PERMISSIONS.has(value)) throw new Error(`Invalid permission mode ${JSON.stringify(value)}.`);
      permission = value;
    } else if (arg === "--thinking") {
      const value = next() as ThinkingLevel;
      if (!THINKING.has(value)) throw new Error(`Invalid thinking level ${JSON.stringify(value)}.`);
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
    sessionId,
    continueLast,
    help,
  };
}

export function helpText(): string {
  return `operon-tui — terminal UI for operon-agents

Usage:
  operon-tui [options]

Options:
  -m, --model <provider/model>   Model (default: OPERON_MODEL or anthropic/claude-opus-4-8)
  -C, --work-dir <path>         Agent workspace (default: current directory)
      --home-dir <path>         Session/config home (default: OPERON_HOME or ~/.operon)
  -s, --session <id>            Resume a session by id
  -c, --continue                Resume the latest session in this workspace
      --permission <mode>       manual | workspace | auto | yolo (default: manual)
      --thinking <level>        minimal | low | medium | high | xhigh | max
      --yolo                    Alias for --permission yolo
  -h, --help                    Show this help

Credentials use the same provider environment variables as operon-agents
(for example ANTHROPIC_API_KEY or OPENAI_API_KEY).`;
}
