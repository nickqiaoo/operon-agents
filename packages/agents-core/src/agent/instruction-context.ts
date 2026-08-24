import { dirname, join } from "pathe";
import type { Machine } from "../tool/machine.ts";
import { readTextFile } from "../tool/support/machine-ops.ts";

const AGENTS_MD_MAX_CHARS = 32 * 1024;

/** Runtime-only values used to render a profile system prompt. */
export interface SystemPromptContext {
  readonly osKind: string;
  readonly osArch?: string;
  readonly osVersion?: string;
  readonly shell: string;
  /** Stable local calendar date for this live Session (`YYYY-MM-DD`). */
  readonly now?: string | Date;
  readonly cwd: string;
  readonly agentsMd?: string;
  readonly roleAdditional?: string;
}

/** Format a date without adding a timezone conversion that could move it to another day. */
export function formatSystemPromptDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Build the environment portion of a profile prompt from the active runtime machine. */
export async function prepareSystemPromptContext(
  machine: Machine,
  now = formatSystemPromptDate(new Date()),
  cwd = machine.normpath(machine.getcwd()),
): Promise<SystemPromptContext> {
  return {
    osKind: machine.osEnv.osKind,
    osArch: machine.osEnv.osArch,
    osVersion: machine.osEnv.osVersion,
    shell: `${machine.osEnv.shellName} (${machine.osEnv.shellPath})`,
    now,
    cwd,
    agentsMd: await loadAgentsMd(machine, cwd),
  };
}

interface CacheEntry {
  readonly revision: number;
  readonly value: Promise<SystemPromptContext>;
}

/**
 * Live-Session cache for system-prompt environment data.
 *
 * Machine object identity separates independent local/remote/worktree runtimes; normalized cwd
 * separates differently rooted frames backed by the same machine. Promise values also coalesce
 * concurrent root/subagent reads. Nothing here is persisted, timed, or checked every turn.
 */
export class SystemPromptContextCache {
  private readonly sessionDate: string;
  private readonly entries = new Map<Machine, Map<string, CacheEntry>>();

  constructor(createdAt = new Date()) {
    this.sessionDate = formatSystemPromptDate(createdAt);
  }

  resolve(machine: Machine, revision = 0): Promise<SystemPromptContext> {
    const cwd = machine.normpath(machine.getcwd());
    let byCwd = this.entries.get(machine);
    if (byCwd === undefined) {
      byCwd = new Map();
      this.entries.set(machine, byCwd);
    }

    const cached = byCwd.get(cwd);
    if (cached?.revision === revision) return cached.value;

    const value = prepareSystemPromptContext(machine, this.sessionDate, cwd).catch((error: unknown) => {
      if (byCwd?.get(cwd)?.value === value) byCwd.delete(cwd);
      throw error;
    });
    byCwd.set(cwd, { revision, value });
    return value;
  }

  /** Release runtime references when the owning Session closes. */
  clear(): void {
    this.entries.clear();
  }

}

/** Collect AGENTS.md from the user dir then filesystem root→cwd (nearest appended last). */
async function loadAgentsMd(machine: Machine, cwd: string): Promise<string> {
  const paths = agentsMdPaths(machine, cwd);
  // Reads are independent. Keep result order deterministic while avoiding a serial RPC walk on
  // remote machines.
  const files = await Promise.all(paths.map(async (path): Promise<{ path: string; text: string } | undefined> => {
    try {
      const text = (await readTextFile(machine, path)).slice(0, AGENTS_MD_MAX_CHARS).trim();
      return text.length > 0 ? { path, text } : undefined;
    } catch {
      return undefined;
    }
  }));
  return files
    .filter((file): file is { path: string; text: string } => file !== undefined)
    .map((file) => `# ${file.path}\n${file.text}`)
    .join("\n\n");
}

function agentsMdPaths(machine: Machine, cwd: string): string[] {
  const candidates = [join(machine.gethome(), ".agents", "AGENTS.md")];
  const dirs: string[] = [];
  let current = machine.normpath(cwd);
  for (;;) {
    dirs.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of dirs) candidates.push(join(dir, "AGENTS.md"));

  const seen = new Set<string>();
  return candidates.filter((path) => {
    const key = machine.normpath(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
