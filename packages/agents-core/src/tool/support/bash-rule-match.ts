/**
 * Bash permission rule matching.
 *
 * Quote-aware splitting
 * of compound commands plus conservative rejection of shell constructs that can
 * execute hidden subcommands. A risky command is covered by no parameterized
 * rule and falls through to the permission chain's fallback ask.
 */

export interface ShellScanResult {
  readonly subcommands: readonly string[];
  readonly risky: boolean;
}

const RISKY_COMMAND_WORDS = new Set(["eval", "source", "."]);

export function scanShellCommand(command: string): ShellScanResult {
  const subcommands: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let risky = false;

  const pushCurrent = (): void => {
    const trimmed = current.trim();
    if (trimmed !== "") subcommands.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      current += ch;
      continue;
    }

    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (ch === "`" || (ch === "$" && next === "(")) {
      risky = true;
      current += ch;
      continue;
    }

    if (!inDouble) {
      if ((ch === "<" || ch === ">") && next === "(") {
        risky = true;
        current += ch;
        continue;
      }
      if (ch === "&" && next === "&") {
        pushCurrent();
        i++;
        continue;
      }
      if (ch === "|" && next === "|") {
        pushCurrent();
        i++;
        continue;
      }
      if (ch === "|" || ch === "&" || ch === ";" || ch === "\n") {
        pushCurrent();
        continue;
      }
    }

    current += ch;
  }

  if (inSingle || inDouble) risky = true;

  pushCurrent();

  if (!risky) {
    for (const sub of subcommands) {
      const firstWord = sub.split(/\s+/, 1)[0] ?? "";
      if (RISKY_COMMAND_WORDS.has(firstWord)) {
        risky = true;
        break;
      }
    }
  }

  return risky ? { subcommands: [], risky: true } : { subcommands, risky: false };
}

export function permissionRuleExtractPrefix(permissionRule: string): string | null {
  const match = /^(.+):\*$/.exec(permissionRule);
  return match?.[1] ?? null;
}

export function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === "\\") {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) return true;
    }
  }
  return false;
}

const ESCAPED_STAR_PLACEHOLDER = "\0ESCAPED_STAR\0";
const ESCAPED_BACKSLASH_PLACEHOLDER = "\0ESCAPED_BACKSLASH\0";

export function matchWildcardPattern(pattern: string, command: string): boolean {
  const trimmedPattern = pattern.trim();

  let processed = "";
  let i = 0;
  while (i < trimmedPattern.length) {
    const char = trimmedPattern[i];
    if (char === "\\" && i + 1 < trimmedPattern.length) {
      const nextChar = trimmedPattern[i + 1];
      if (nextChar === "*") {
        processed += ESCAPED_STAR_PLACEHOLDER;
        i += 2;
        continue;
      }
      if (nextChar === "\\") {
        processed += ESCAPED_BACKSLASH_PLACEHOLDER;
        i += 2;
        continue;
      }
    }
    processed += char;
    i++;
  }

  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");
  let regexPattern = withWildcards
    .replaceAll(ESCAPED_STAR_PLACEHOLDER, "\\*")
    .replaceAll(ESCAPED_BACKSLASH_PLACEHOLDER, "\\\\");

  const unescapedStarCount = (processed.match(/\*/g) ?? []).length;
  if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
    regexPattern = `${regexPattern.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${regexPattern}$`, "s").test(command);
}

const SAFE_ENV_VARS = new Set([
  "GOEXPERIMENT", "GOOS", "GOARCH", "CGO_ENABLED", "GO111MODULE",
  "RUST_BACKTRACE", "RUST_LOG",
  "NODE_ENV",
  "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD", "PYTEST_DEBUG",
  "ANTHROPIC_API_KEY",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_TIME", "CHARSET",
  "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ",
  "LS_COLORS", "LSCOLORS", "GREP_COLOR", "GREP_COLORS", "GCC_COLORS",
  "TIME_STYLE", "BLOCK_SIZE", "BLOCKSIZE",
]);

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

export function stripSafeEnvPrefix(subcommand: string): string {
  const tokens = subcommand.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const match = ENV_ASSIGNMENT_RE.exec(tokens[i]!);
    if (!match || !SAFE_ENV_VARS.has(match[1]!)) break;
    i++;
  }
  return tokens.slice(i).join(" ");
}

export function singleCommandMatchesRule(pattern: string, subcommand: string): boolean {
  const trimmedPattern = pattern.trim();
  const prefix = permissionRuleExtractPrefix(trimmedPattern);
  if (prefix !== null) return subcommand.startsWith(prefix);
  if (hasWildcards(trimmedPattern)) return matchWildcardPattern(trimmedPattern, subcommand);
  return subcommand === trimmedPattern;
}

export function matchesBashRule(ruleArgs: string, command: string): boolean {
  if (ruleArgs.length === 0) return true;
  const negated = ruleArgs.startsWith("!");
  const pattern = negated ? ruleArgs.slice(1) : ruleArgs;
  const hit = commandCoveredByRule(pattern, command);
  return negated ? !hit : hit;
}

function commandCoveredByRule(pattern: string, command: string): boolean {
  const scan = scanShellCommand(command.trim());
  if (scan.risky || scan.subcommands.length === 0) return false;
  return scan.subcommands.every((sub) => singleCommandMatchesRule(pattern, stripSafeEnvPrefix(sub)));
}
