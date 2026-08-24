/**
 * srt's wrap API takes a SHELL COMMAND STRING (plus the shell to run it with),
 * while Machine.run hands us an argv. This module converts losslessly between
 * the two shapes so the sandbox always sees the exact command that would have
 * run without it.
 */

/** Single-quote for a POSIX shell (same contract as BaseMachine's internal helper). */
export function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SHELL_BASENAMES = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

function isShellPath(candidate: string): boolean {
  const base = candidate.slice(candidate.lastIndexOf("/") + 1);
  return SHELL_BASENAMES.has(base);
}

export interface SrtInvocation {
  /** The command string to hand srt. */
  readonly command: string;
  /** The shell srt should run it with. */
  readonly binShell: string;
}

/**
 * Two argv shapes reach a machine:
 *
 * - `[shell, "-c", script]` — the bash tool, user hooks, and BaseMachine's own
 *   cwd fallback all build this. Pass `script` through VERBATIM with its own
 *   shell, so quoting inside the script survives untouched.
 * - anything else (a search binary and its args) — quote each argument into a
 *   command string and run it under `fallbackShell`.
 */
export function toSrtInvocation(argv: readonly string[], fallbackShell: string): SrtInvocation {
  const [first, second, third] = argv;
  if (argv.length === 3 && first !== undefined && second === "-c" && third !== undefined && isShellPath(first)) {
    return { command: third, binShell: first };
  }
  return { command: argv.map(shellQuoteArg).join(" "), binShell: fallbackShell };
}
