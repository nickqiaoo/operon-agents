/**
 * Advisory warnings for shell commands whose effects are hard or impossible to undo.
 *
 * PURELY INFORMATIONAL. Nothing here changes a permission decision — a matched pattern only
 * adds a line to what the approver is shown. The reason to keep it out of the decision path is
 * that these patterns are heuristics: `rm -rf ./build` matches the same rule as `rm -rf /`, and
 * a heuristic that blocked would be wrong often enough to train people to click through.
 *
 * What it buys is the difference between reading `git push --force-with-lease origin main` and
 * reading it with "may overwrite remote history" underneath. The command is right there either
 * way; the warning is for the reader who is moving fast.
 *
 * Patterns stop at `;`, `&`, `|` and newlines where a following argument would matter, so a
 * later command in the same line cannot supply the flag that triggers an earlier one's warning.
 */

interface DestructivePattern {
  readonly pattern: RegExp;
  readonly warning: string;
}

/** Ordered: the first match wins, so more specific patterns come before broader ones. */
const DESTRUCTIVE_PATTERNS: readonly DestructivePattern[] = [
  // ── git: history and working-tree loss ──
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: "may discard uncommitted changes" },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force\b|--force-with-lease\b|-f\b)/,
    warning: "may overwrite remote history",
  },
  { pattern: /\bgit\s+clean\b[^;&|\n]*[ \t]-[a-zA-Z]*[dfx]/, warning: "may permanently delete untracked files" },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: "may discard all working tree changes" },
  { pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: "may discard all working tree changes" },
  { pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/, warning: "may permanently remove stashed changes" },
  { pattern: /\bgit\s+branch\b[^;&|\n]*[ \t]-[a-zA-Z]*D\b/, warning: "may force-delete a branch" },
  { pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/, warning: "may skip safety hooks" },
  { pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/, warning: "may rewrite the last commit" },
  { pattern: /\bgit\s+(rebase|filter-branch)\b/, warning: "may rewrite commit history" },

  // ── filesystem ──
  { pattern: /(^|[;&|\n]\s*)rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]/, warning: "may recursively force-remove files" },
  { pattern: /(^|[;&|\n]\s*)rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]/, warning: "may recursively remove files" },
  { pattern: /(^|[;&|\n]\s*)rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f/, warning: "may force-remove files" },
  { pattern: /(^|[;&|\n]\s*)(chmod|chown)\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*R/, warning: "may recursively change permissions" },
  { pattern: /\bmkfs(\.\w+)?\b|\bdd\b[^;&|\n]*\bof=\/dev\//, warning: "may overwrite a raw device" },

  // ── data stores ──
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, warning: "may drop or truncate database objects" },
  { pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, warning: "may delete all rows from a database table" },
  { pattern: /\bredis-cli\b[^;&|\n]*\bflush(all|db)\b/i, warning: "may erase the Redis keyspace" },

  // ── infrastructure ──
  { pattern: /\bkubectl\s+delete\b/, warning: "may delete Kubernetes resources" },
  { pattern: /\bterraform\s+destroy\b/, warning: "may destroy Terraform infrastructure" },
  { pattern: /\bdocker\s+(system\s+prune|volume\s+rm)\b/, warning: "may delete Docker data" },

  // ── publishing: not destructive locally, but not retractable either ──
  { pattern: /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/, warning: "may publish a package publicly" },
];

/**
 * A short "may …" clause for the approver, or undefined when nothing matched.
 *
 * Only the first match is reported. A command that trips three patterns is not three times as
 * dangerous, and a wall of notes is read as noise — which is the failure mode this exists to
 * avoid in the first place.
 */
export function destructiveWarning(command: string): string | undefined {
  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(command)) return entry.warning;
  }
  return undefined;
}
