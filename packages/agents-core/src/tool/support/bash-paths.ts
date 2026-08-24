/**
 * Best-effort extraction of the file paths a shell command touches, so Bash can declare
 * `ToolPlan.accesses` like every other tool and the existing permission policies
 * (sensitive-file / git-control-path / write-outside-cwd) apply to it too. Without this,
 * Bash declares nothing and all three silently skip it.
 *
 * EXPLICITLY INCOMPLETE, and safe because of how it fails. `eval "$CMD"`, `bash -c "$(curl …)"`
 * and variable-built paths cannot be resolved from source text, and no amount of parsing fixes
 * that. Every unresolvable case yields NO access entry, which lands exactly on today's
 * behaviour — the policies skip what they cannot see, and the permission chain's fallback ask
 * still stands behind them. So this raises the cost of an accidental out-of-workspace write; it
 * is not a boundary. The boundary is the Machine (sandbox / SSH), which bounds what the command
 * can reach no matter how the path was spelled.
 *
 * Over-declaring is the failure mode worth avoiding: a bogus path means a permission prompt for
 * a command that never touched it, and needless serialization against sibling calls. Hence only
 * literal words of well-understood commands are reported, and anything ambiguous is dropped.
 */
import { scanShellCommand } from "./bash-rule-match.ts";

export interface BashPathAccess {
  readonly operation: "read" | "write";
  /** Path exactly as written in the command — the caller resolves it against cwd. */
  readonly path: string;
}

interface Word {
  readonly text: string;
  /** False when the word contains an expansion or glob, so its value is not knowable here. */
  readonly literal: boolean;
}

/** Wrappers that run the REST of the words as a command; the real verb is what follows. */
const COMMAND_PREFIXES = new Set(["sudo", "env", "nohup", "time", "command", "builtin", "exec", "nice", "ionice"]);

/** Every non-option argument is a write target. */
const WRITES_ALL_ARGS = new Set(["rm", "rmdir", "touch", "mkdir", "unlink", "shred", "truncate", "tee"]);
/** Last non-option argument is the destination; the earlier ones are sources. */
const WRITES_LAST_ARG = new Set(["cp", "mv", "ln", "install", "rsync"]);
/** First non-option argument is a mode/owner, the rest are targets. */
const WRITES_ARGS_AFTER_FIRST = new Set(["chmod", "chown", "chgrp"]);
/** Take a script operand before their filenames, and write in place with `-i`. */
const SCRIPT_COMMANDS = new Set(["sed", "gsed", "perl", "awk", "gawk"]);
/** Every non-option argument is read. */
const READS_ALL_ARGS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "file", "stat", "nl", "od", "xxd", "strings",
  "base64", "md5sum", "sha1sum", "sha256sum", "shasum", "cmp", "diff", "sort", "readlink",
]);

/**
 * Split one simple command into words, tracking whether each is a knowable literal.
 *
 * A double-quoted word containing `$` or a backtick is NOT literal — its value depends on the
 * environment. An unquoted word with a glob character is not literal either: it names a set,
 * and reporting the pattern as if it were a path would be a fabricated access.
 */
function splitWords(text: string): Word[] {
  const words: Word[] = [];
  let current = "";
  let started = false;
  let literal = true;
  let inSingle = false;
  let inDouble = false;

  const push = (): void => {
    if (started) words.push({ text: current, literal });
    current = "";
    started = false;
    literal = true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1]!;
      started = true;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      started = true;
      continue;
    }
    if (!inDouble && /\s/.test(ch)) {
      push();
      continue;
    }
    if (inDouble && (ch === "$" || ch === "`")) literal = false;
    // Unquoted expansions and globs: the word is a pattern or a variable, not a path.
    if (!inDouble && (ch === "$" || ch === "*" || ch === "?" || ch === "[")) literal = false;
    current += ch;
    started = true;
  }
  push();
  return words;
}

/** `>`, `>>`, `2>`, `&>`, `>|` … — everything that names a file to be written. */
const WRITE_REDIRECT = /^(?:\d*&?>{1,2}\|?|&>{1,2})$/;
const READ_REDIRECT = /^\d*<$/;

/**
 * Pull redirection targets out and return the remaining words.
 *
 * `2>&1` and friends duplicate a descriptor rather than name a file, so a target starting with
 * `&` is dropped. A redirect written without a space (`>out.log`) is handled by splitting the
 * operator off the front of the word.
 */
function takeRedirects(words: readonly Word[], out: BashPathAccess[]): Word[] {
  const rest: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;

    // A word that is ENTIRELY an operator takes the next word as its target. This must be
    // tested before the glued form below: `>>` also matches that pattern, with the regex
    // backtracking so the second `>` reads as a one-character filename.
    const isWrite = WRITE_REDIRECT.test(word.text);
    if (isWrite || READ_REDIRECT.test(word.text)) {
      const target = words[i + 1];
      i++; // the target belongs to the redirect either way, never to the command
      if (target !== undefined && target.literal && !target.text.startsWith("&")) {
        out.push({ operation: isWrite ? "write" : "read", path: target.text });
      }
      continue;
    }

    // Operator and target written together: `>out.log`.
    const glued = /^(\d*&?>{1,2}\|?|&>{1,2}|\d*<)(.+)$/.exec(word.text);
    if (glued !== null && (WRITE_REDIRECT.test(glued[1]!) || READ_REDIRECT.test(glued[1]!))) {
      const target = glued[2]!;
      if (word.literal && !target.startsWith("&")) {
        out.push({ operation: WRITE_REDIRECT.test(glued[1]!) ? "write" : "read", path: target });
      }
      continue;
    }
    rest.push(word);
  }
  return rest;
}

/**
 * `sed`/`perl` edit files in place, so their operands are writes — but only with `-i`, and
 * only after the SCRIPT operand is told apart from the filenames. Two details make a plain
 * operand scan wrong here:
 *
 * - Without `-e`/`-f`, the first operand is the script (`sed 's/a/b/' notes.txt`). Treating it
 *   as a path would declare a write to a file named `s/a/b/`.
 * - BSD `sed` requires a backup suffix for `-i`, usually written as an empty word
 *   (`sed -i '' 's/a/b/' notes.txt`), which shifts every operand one place along.
 *
 * Without `-i` the same command only reads, which is still worth declaring — `sed 's/x/y/' .env`
 * should meet the sensitive-file policy just like `cat .env` does.
 */
function scriptCommandFiles(name: string, rawArgs: readonly Word[]): { inPlace: boolean; files: Word[] } {
  let inPlace = false;
  let scriptIsAnOption = false;
  const operandWords: Word[] = [];
  let optionsEnded = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const word = rawArgs[i]!;
    if (!optionsEnded && word.text === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.text.startsWith("-") && word.text.length > 1) {
      // `--silent` contains an "i", so sed's in-place flag has to be matched at the front;
      // perl's comes bundled into short clusters like `-pi`.
      if (name === "sed" || name === "gsed") {
        if (/^-i/.test(word.text) || word.text === "--in-place" || word.text.startsWith("--in-place=")) inPlace = true;
      } else if (/^-[^-]*i/.test(word.text)) {
        inPlace = true;
      }
      if (word.text === "-e" || word.text === "-f" || word.text === "--expression" || word.text === "--file") {
        scriptIsAnOption = true;
        i++; // the script/scriptfile is this option's argument, never a path
        continue;
      }
      if (/^--(expression|file)=/.test(word.text)) scriptIsAnOption = true;
      continue;
    }
    operandWords.push(word);
  }

  const nonEmpty = operandWords.filter((word) => word.text.length > 0);
  return { inPlace, files: scriptIsAnOption ? nonEmpty : nonEmpty.slice(1) };
}

/** Drop option flags, and stop treating anything as an option after a bare `--`. */
function operands(words: readonly Word[]): Word[] {
  const result: Word[] = [];
  let optionsEnded = false;
  for (const word of words) {
    if (!optionsEnded && word.text === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.text.startsWith("-") && word.text.length > 1) continue;
    result.push(word);
  }
  return result;
}

function pushLiteral(words: readonly Word[], operation: "read" | "write", out: BashPathAccess[]): void {
  for (const word of words) {
    if (word.literal && word.text.length > 0) out.push({ operation, path: word.text });
  }
}

export function extractBashPaths(command: string): BashPathAccess[] {
  // A command with an eval, a substitution or an unbalanced quote can execute anything; the
  // scan reports it as risky and hands back no subcommands, and we claim nothing about it.
  const scan = scanShellCommand(command);
  if (scan.risky) return [];

  const out: BashPathAccess[] = [];
  for (const subcommand of scan.subcommands) {
    const afterRedirects = takeRedirects(splitWords(subcommand), out);
    let words = afterRedirects;
    // Skip wrappers (`sudo rm x`) and inline `VAR=value` assignments to find the real verb.
    while (words.length > 0 && (COMMAND_PREFIXES.has(words[0]!.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text))) {
      words = words.slice(1);
    }
    const verb = words[0];
    if (verb === undefined || !verb.literal) continue;

    const rawArgs = words.slice(1);
    const args = operands(rawArgs);
    const name = verb.text.replace(/^.*\//, ""); // /bin/rm → rm
    if (SCRIPT_COMMANDS.has(name)) {
      const { inPlace, files } = scriptCommandFiles(name, rawArgs);
      pushLiteral(files, inPlace ? "write" : "read", out);
    } else if (WRITES_ALL_ARGS.has(name)) {
      pushLiteral(args, "write", out);
    } else if (WRITES_LAST_ARG.has(name)) {
      // Only the destination is a write; a single argument is too ambiguous to classify.
      if (args.length >= 2) {
        pushLiteral(args.slice(0, -1), "read", out);
        pushLiteral(args.slice(-1), "write", out);
      }
    } else if (WRITES_ARGS_AFTER_FIRST.has(name)) {
      pushLiteral(args.slice(1), "write", out);
    } else if (READS_ALL_ARGS.has(name)) {
      pushLiteral(args, "read", out);
    }
  }
  return out;
}
