/**
 * Recognizes shell commands that cannot change anything, so the permission chain can approve
 * them without paying for a model judge.
 *
 * `git status`, `ls`, `cat`, `which` are most of what an agent runs while orienting itself. In
 * `auto` mode each of those otherwise reaches the LLM auto-approver — a round trip and tokens
 * spent re-deciding a question with one answer. This is the small deterministic table that
 * covers the common cases; anything it does not recognize falls through to the judge exactly as
 * before, so the table's coverage is a cost question, never a safety one.
 *
 * Deliberately kept small rather than growing into exhaustive per-tool subcommand tables and
 * flag validators. Every entry is a maintenance burden and a chance to
 * be wrong, and being wrong here means silently approving a write. The cheap 90% is worth
 * having; the long tail belongs to the judge, which does not need updating when a tool adds a
 * subcommand.
 */
import { scanShellCommand } from "./bash-rule-match.ts";

/** Commands that only ever read, whatever their arguments. */
const ALWAYS_READ_ONLY = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "tree", "basename",
  "dirname", "realpath", "readlink", "which", "type", "whoami", "id", "hostname", "uname",
  "date", "echo", "printf", "env", "printenv", "uptime", "ps", "grep", "egrep", "fgrep", "rg",
  "find", "diff", "cmp", "sort", "uniq", "cut", "tr", "nl", "od", "xxd", "strings", "base64",
  "md5sum", "sha1sum", "sha256sum", "shasum", "jq", "yq", "column", "less", "more", "man",
  "true", "false", "sleep", "seq", "expr", "test",
]);

/**
 * Subcommand allow-lists for tools whose read/write split is the subcommand, not the binary.
 * Anything not listed is treated as a write — `git gc` and `gh repo delete` must not reach
 * this table's approval by being unrecognized.
 */
const SUBCOMMAND_READ_ONLY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git", new Set(["status", "log", "diff", "show", "branch", "tag", "remote", "config", "blame",
    "describe", "rev-parse", "ls-files", "ls-remote", "ls-tree", "shortlog", "reflog", "cat-file",
    "symbolic-ref", "whatchanged", "grep", "count-objects", "check-ignore", "var", "help"])],
  ["gh", new Set(["pr", "issue", "repo", "run", "release", "api", "auth", "browse", "search", "status"])],
  ["docker", new Set(["ps", "images", "logs", "inspect", "version", "info", "port", "top", "stats", "diff", "history"])],
  ["kubectl", new Set(["get", "describe", "logs", "explain", "version", "api-resources", "top", "config"])],
  ["npm", new Set(["ls", "list", "view", "info", "outdated", "why", "ping", "whoami", "root", "prefix", "bin"])],
  ["pnpm", new Set(["ls", "list", "why", "outdated", "root", "bin", "licenses"])],
  ["yarn", new Set(["list", "info", "why", "versions"])],
  ["cargo", new Set(["tree", "metadata", "search", "version"])],
  ["go", new Set(["version", "env", "list", "doc", "vet"])],
]);

/**
 * Interpreters, which are only ever read-only when asked for their version. `node -e` and
 * `python -c` take arbitrary code, so nothing else about them can be cleared here.
 */
const INTERPRETERS = new Set(["node", "python", "python3", "ruby", "perl", "php", "deno", "bun", "java"]);
const VERSION_FLAGS = new Set(["--version", "-v", "-V"]);

/**
 * Subcommands above that become writes under a flag. `gh pr list` reads; `gh pr create` does
 * not, and `git config --global x y` writes despite `config` being on the list.
 */
const WRITE_SUBCOMMAND_WORDS = new Set([
  "create", "delete", "edit", "close", "merge", "reopen", "comment", "review", "rename",
  "add", "set", "unset", "remove", "rm", "install", "uninstall", "publish", "push", "apply",
  "clone", "fork", "sync", "update", "upgrade", "prune", "gc", "checkout", "restore", "reset",
]);

/** Anything that changes the shell's own state or hands execution to another program. */
const NEVER_READ_ONLY = new Set(["cd", "export", "unset", "alias", "eval", "source", ".", "exec", "sudo", "xargs", "sh", "bash", "zsh"]);

/**
 * Flags that turn a reading command into a writing one. Being on a read-only list is about the
 * binary; these are about what it was ASKED to do, and skipping them was a hole big enough to
 * drive `find . -name '*.ts' -delete` through.
 *
 * Kept per-command on purpose. The same spelling means opposite things elsewhere — `-o` writes
 * a file for `sort` but selects long format for `ls`, `-i` edits in place for `yq` but means
 * ignore-case for `grep`. A single global list would either miss the dangerous ones or reject
 * half the harmless reads.
 */
const WRITE_CAPABLE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // -exec/-ok run arbitrary commands; -delete and the -f* family write directly.
  ["find", new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"])],
  ["sort", new Set(["-o", "--output"])],
  ["yq", new Set(["-i", "--inplace", "--in-place"])],
  ["jq", new Set(["-i", "--in-place"])],
  ["git", new Set(["--output", "-o"])], // `git log/diff/show --output=FILE`
  ["docker", new Set(["--output", "-o"])],
  ["kubectl", new Set(["--output-file"])],
  ["gh", new Set(["--output"])],
]);

/** Long flags that name an output file in essentially every tool that accepts them. */
const UNIVERSAL_WRITE_FLAGS = new Set(["--output", "--output-file", "--out-file", "--write-out"]);

/** True when any argument is a flag that would make this command write. */
function hasWriteCapableFlag(name: string, args: readonly string[]): boolean {
  const perCommand = WRITE_CAPABLE_FLAGS.get(name);
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    // `--output=FILE` and `--output FILE` are the same flag.
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (UNIVERSAL_WRITE_FLAGS.has(flag)) return true;
    if (perCommand?.has(flag) === true) return true;
  }
  return false;
}

function subcommandIsReadOnly(name: string, args: readonly string[], allowed: ReadonlySet<string>): boolean {
  const words = args.filter((word) => !word.startsWith("-"));
  // A bare `git` or `docker` just prints usage. (Interpreters never reach here — they are
  // handled separately, since a bare one waits on stdin.)
  const subcommand = words[0];
  if (subcommand === undefined) return true;
  if (!allowed.has(subcommand)) return false;
  // `git config --global user.name x` writes: a value operand past the setting name.
  if (name === "git" && subcommand === "config" && words.length > 2) return false;
  return !words.some((word) => WRITE_SUBCOMMAND_WORDS.has(word));
}

/**
 * True only when every part of the command is recognized as read-only.
 *
 * Everything unrecognized answers false, which costs a judge call. That asymmetry is the whole
 * design: a false negative is a round trip, a false positive is an unreviewed write.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  // Substitutions, eval and unbalanced quotes can run anything; the scan reports them and
  // hands back no subcommands to inspect.
  const scan = scanShellCommand(command);
  if (scan.risky || scan.subcommands.length === 0) return false;

  // Any redirection can create or truncate a file, whatever the command in front of it is.
  // `<` alone would be safe, but `<<` heredocs and `>` share too much syntax to split hairs.
  if (/(^|[^<>\d&])>|>>/.test(command)) return false;

  for (const subcommand of scan.subcommands) {
    const words = subcommand.split(/\s+/).filter((word) => word.length > 0);
    let index = 0;
    // Inline `VAR=value` prefixes do not change what the command does to the filesystem.
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
    const verb = words[index];
    if (verb === undefined) return false;
    const name = verb.replace(/^.*\//, "");
    if (NEVER_READ_ONLY.has(name)) return false;

    const args = words.slice(index + 1);
    // Checked before the name lookups: a write-capable flag disqualifies the command no matter
    // how read-only the binary is on its own.
    if (hasWriteCapableFlag(name, args)) return false;

    if (INTERPRETERS.has(name)) {
      // Only `node --version` and friends; a bare interpreter waits on stdin and any other
      // argument is a script.
      if (args.length === 0 || !args.every((word) => VERSION_FLAGS.has(word))) return false;
      continue;
    }

    const allowed = SUBCOMMAND_READ_ONLY.get(name);
    if (allowed !== undefined) {
      if (!subcommandIsReadOnly(name, args, allowed)) return false;
      continue;
    }
    if (!ALWAYS_READ_ONLY.has(name)) return false;
  }
  return true;
}
