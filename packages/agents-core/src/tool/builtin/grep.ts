import { normalize } from "node:path";
import { z } from "zod";
import { isAbortError } from "../../loop/errors.ts";
import { defineTool } from "../define.ts";
import { isSensitiveFile, SENSITIVE_DOT_VARIANT_SUFFIXES } from "../policies/sensitive.ts";
import { resolveRgCommand, rgUnavailableMessage } from "../support/rg-locator.ts";
import { runRipgrep, stillRunningNote, type RipgrepRunOutcome, type RipgrepRunResult } from "../support/ripgrep-run.ts";
import { ToolResultBuilder } from "../support/result-builder.ts";
import { globApproval, resolveToolPath, SEARCH_ACCESS_POLICY } from "../support/tool-path.ts";
import type { Machine } from "../machine.ts";
import type { ToolResult } from "../types.ts";

type PathClass = "posix" | "win32";
const NUL = "\u0000";

const GrepInput = z.object({
  pattern: z.string().describe("Regular expression to search for."),
  path: z
    .string()
    .optional()
    .describe(
      "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.",
    ),
  glob: z.string().optional().describe("Optional glob filter passed to ripgrep."),
  type: z
    .string()
    .optional()
    .describe(
      "Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.",
    ),
  output_mode: z
    .enum(["content", "files_with_matches", "count_matches"])
    .optional()
    .describe(
      "Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match (honors `head_limit`); `count_matches` shows the total number of matches. Defaults to `files_with_matches`.",
    ),
  "-i": z.boolean().optional().describe("Perform a case-insensitive search. Defaults to false."),
  "-n": z
    .boolean()
    .optional()
    .describe("Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true."),
  "-A": z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Number of lines to show after each match. Applies only when `output_mode` is `content`."),
  "-B": z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Number of lines to show before each match. Applies only when `output_mode` is `content`."),
  "-C": z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.",
    ),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.",
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      "Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.",
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      "Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. Defaults to false.",
    ),
});

type GrepInput = z.infer<typeof GrepInput>;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const RG_MAX_COLUMNS = 500;
const DEFAULT_HEAD_LIMIT = 250;
const MTIME_STAT_CONCURRENCY = 32;
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;
const SENSITIVE_KEY_BASENAMES = ["id_rsa", "id_ed25519", "id_ecdsa"] as const;
const SENSITIVE_KEY_GLOBS_TO_EXCLUDE = SENSITIVE_KEY_BASENAMES.flatMap((name) => [
  `**/${name}`,
  `**/${name}[-_]*`,
  ...SENSITIVE_DOT_VARIANT_SUFFIXES.map((suffix) => `**/${name}${suffix}`),
]);
const SENSITIVE_GLOBS_TO_EXCLUDE = [
  "**/.env",
  ...SENSITIVE_KEY_GLOBS_TO_EXCLUDE,
  "**/.aws/credentials",
  "**/.aws/credentials/**",
  "**/.gcp/credentials",
  "**/.gcp/credentials/**",
] as const;

const CONTENT_LINE_RE = /^(.*?)([:-])(\d+)\2/;

const GREP_DESCRIPTION = [
  "Search file contents using regular expressions (powered by ripgrep).",
  "",
  "Use Grep when the task is to find unknown content or unknown file locations. Do not use shell `grep` or `rg` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.",
  "ALWAYS use Grep tool instead of running `grep` or `rg` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.",
  "If you already know a concrete file path and need to inspect its contents, use Read directly instead.",
  "",
  "Write patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\\{` to match a literal `{`.",
  "",
  "Hidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default. To also search files excluded by `.gitignore` (such as `node_modules` or build outputs), set `include_ignored` to `true`. Sensitive files (such as `.env`) are always skipped for safety, even when `include_ignored` is `true`.",
].join("\n");

export const grepTool = defineTool({
  name: "Grep",
  description: GREP_DESCRIPTION,
  params: GrepInput,
  async resolve(args, ctx) {
    const searchPath =
      args.path !== undefined
        ? await resolveToolPath(args.path, ctx.machine, "search", SEARCH_ACCESS_POLICY)
        : ctx.machine.getcwd();
    return {
      display: { title: `Searching for '${args.pattern}' in ${args.path ?? "."}` },
      ...globApproval("Grep", args.pattern),
      run: (runCtx) => execution(args, runCtx.signal, [searchPath], runCtx.machine),
    };
  },
});

type GrepMode = "content" | "files_with_matches" | "count_matches";

type ParsedGrepLine =
  | { readonly kind: "record"; readonly filePath: string; readonly payload: string }
  | { readonly kind: "separator" }
  | { readonly kind: "legacy"; readonly text: string };

class GrepAbortedError extends Error {
  constructor() {
    super("Grep aborted");
    this.name = "GrepAbortedError";
  }
}

function errResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function execution(
  args: GrepInput,
  signal: AbortSignal,
  searchPaths: string[],
  machine: Machine,
): Promise<ToolResult> {
  if (signal.aborted) return errResult("Aborted before search started");

  const pathClass = machine.pathClass();
  const workspaceDir = machine.getcwd();
  let rgPath: string;
  try {
    rgPath = await resolveRgCommand(machine, { signal });
  } catch (error) {
    if (isAbortError(error)) return errResult("Grep aborted");
    return errResult(rgUnavailableMessage(error));
  }

  const runOptions = { timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES };
  let outcome = await runRipgrep(machine, buildRgArgs(rgPath, args, searchPaths), signal, runOptions);
  const earlyExit = mapNonResult(outcome);
  if (earlyExit) return earlyExit;
  let runResult = (outcome as Extract<RipgrepRunOutcome, { kind: "result" }>).result;
  if (shouldRetryRipgrepEagain(runResult)) {
    outcome = await runRipgrep(machine, buildRgArgs(rgPath, args, searchPaths, true), signal, runOptions);
    const retryExit = mapNonResult(outcome);
    if (retryExit) return retryExit;
    runResult = (outcome as Extract<RipgrepRunOutcome, { kind: "result" }>).result;
  }

  const { exitCode, stderrText, truncated, timedOut, terminated } = runResult;
  let { stdoutText } = runResult;

  // An `undefined` code is not a failure — it means the run was cut short (timeout kill, or
  // a backend that cannot confirm completion), and the partial output is still usable.
  if (exitCode !== undefined && exitCode !== 0 && exitCode !== 1 && !timedOut) {
    return errResult(formatRipgrepError(exitCode, stderrText, truncated));
  }

  const mode = args.output_mode ?? "files_with_matches";
  if (truncated || timedOut) stdoutText = omitIncompleteTrailingRecord(stdoutText, mode);
  if (timedOut && stdoutText.trim() === "") {
    return errResult(
      `Grep timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s${stillRunningNote(terminated)}. ` +
        `Try a more specific path or pattern.`,
    );
  }
  if (signal.aborted) return errResult("Grep aborted");

  const rawLines = parseRipgrepOutput(stdoutText, mode);
  const filteredSensitive = new Set<string>();
  const keptLines = filterSensitiveLines(rawLines, mode, filteredSensitive, pathClass);
  let orderedLines: ParsedGrepLine[];
  try {
    orderedLines =
      mode === "files_with_matches" && !timedOut
        ? await sortFilesWithMatchesByMtime(keptLines, machine, signal)
        : keptLines;
  } catch (error) {
    if (error instanceof GrepAbortedError) return errResult("Grep aborted");
    throw error;
  }

  const offset = args.offset ?? 0;
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const afterOffset = offset > 0 ? orderedLines.slice(offset) : orderedLines;
  const limitActive = headLimit > 0;
  const limited = limitActive ? afterOffset.slice(0, headLimit) : afterOffset;
  const paginationTruncated = limitActive && afterOffset.length > headLimit;

  const messages: string[] = [];
  const sideChannelMessages: string[] = [];
  if (filteredSensitive.size > 0) {
    const displayedFilteredPaths = [...filteredSensitive].map((p) => relativizeIfUnder(p, workspaceDir, pathClass));
    messages.push(`Filtered ${String(filteredSensitive.size)} sensitive file(s): ${displayedFilteredPaths.join(", ")}`);
  }
  if (mode === "count_matches" && orderedLines.length > 0) {
    sideChannelMessages.push(formatCountSummary(orderedLines, filteredSensitive.size > 0));
  }
  if (paginationTruncated) {
    const total = afterOffset.length + offset;
    const nextOffset = offset + headLimit;
    const paginationNotice = `Results truncated to ${String(headLimit)} lines (total: ${String(total)}). Use offset=${String(nextOffset)} to see more.`;
    if (mode === "count_matches") sideChannelMessages.push(paginationNotice);
    else messages.push(paginationNotice);
  }
  if (truncated) {
    messages.push(`[output truncated at ${String(MAX_OUTPUT_BYTES)} bytes; incomplete trailing line omitted]`);
  }
  if (timedOut) {
    messages.push(
      `Grep timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s${stillRunningNote(terminated)}; ` +
        `partial results returned`,
    );
  }

  const contentIncludesLineNumbers = mode === "content" && args["-n"] !== false;
  const displayedLines = limited.map((line) =>
    formatDisplayLine(line, mode, workspaceDir, pathClass, contentIncludesLineNumbers),
  );
  const contentBody = displayedLines.join("\n");
  const visibleBody =
    orderedLines.length === 0 && filteredSensitive.size > 0 ? "No non-sensitive matches found" : contentBody;
  const emptyResultMessage = "No non-sensitive matches found";
  const combined =
    visibleBody === "" && messages.length === 0
      ? emptyResultMessage
      : messages.length > 0
        ? visibleBody === ""
          ? messages.join("\n")
          : `${visibleBody}\n${messages.join("\n")}`
        : visibleBody;

  const builder = new ToolResultBuilder();
  builder.write(combined);
  return builder.ok(sideChannelMessages.join("\n"));
}

/** Map an aborted/exec-error outcome to a tool result, or null when ripgrep ran. */
function mapNonResult(outcome: RipgrepRunOutcome): ToolResult | null {
  if (outcome.kind === "aborted") return errResult("Grep aborted");
  if (outcome.kind === "exec-error") {
    return errResult(
      outcome.isEnoent
        ? rgUnavailableMessage(outcome.error)
        : outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error),
    );
  }
  return null;
}

function shouldRetryRipgrepEagain(result: RipgrepRunResult): boolean {
  // No exit code means the run was cut short, not that rg failed to spawn threads — a
  // retry would just hit the same timeout.
  if (result.exitCode === undefined) return false;
  return result.exitCode !== 0 && result.exitCode !== 1 && !result.timedOut && isEagainRipgrepError(result.stderrText);
}

function isEagainRipgrepError(stderr: string): boolean {
  return stderr.includes("os error 11") || stderr.includes("Resource temporarily unavailable");
}

async function sortFilesWithMatchesByMtime(
  lines: readonly ParsedGrepLine[],
  machine: Machine,
  signal: AbortSignal,
): Promise<ParsedGrepLine[]> {
  const entries = await mapWithConcurrency(lines, MTIME_STAT_CONCURRENCY, signal, async (line, index) => {
    const path = line.kind === "record" ? line.filePath : line.kind === "legacy" ? line.text : undefined;
    let mtime = 0;
    if (path !== undefined) {
      try {
        mtime = (await machine.fileInfo(path)).mtimeMs ?? 0;
      } catch {
        /* mtime=0 → sort after known files */
      }
    }
    return { line, mtime, index };
  });
  entries.sort((a, b) => b.mtime - a.mtime || a.index - b.index);
  return entries.map((entry) => entry.line);
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (signal.aborted) throw new GrepAbortedError();
  if (items.length === 0) return [];

  const results: U[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (signal.aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );
  if (signal.aborted) throw new GrepAbortedError();
  return results;
}

function buildRgArgs(rgPath: string, args: GrepInput, searchPaths: readonly string[], singleThreaded = false): string[] {
  const cmd: string[] = [rgPath];
  if (singleThreaded) cmd.push("-j", "1");
  cmd.push("--hidden");
  const mode = args.output_mode ?? "files_with_matches";
  // Only `content` prints file lines, so only it can print a 200 KB minified one. Capping at
  // the ripgrep end matters most on remote backends: the cap decides how many bytes cross the
  // wire, whereas the result builder's per-line limit only trims them after they arrive.
  if (mode === "content") cmd.push("--max-columns", String(RG_MAX_COLUMNS), "--max-columns-preview");
  cmd.push("--null");
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) cmd.push("--glob", `!${dir}`);

  if (mode === "files_with_matches") cmd.push("-l");
  else if (mode === "count_matches") cmd.push("--count-matches", "--with-filename");

  if (args["-i"]) cmd.push("-i");
  if (mode === "content") {
    cmd.push("--with-filename");
    if (args["-n"] !== false) cmd.push("-n");
    else cmd.push("--field-context-separator", ":");
    if (args["-C"] !== undefined) {
      cmd.push("-C", String(args["-C"]));
    } else {
      if (args["-A"] !== undefined) cmd.push("-A", String(args["-A"]));
      if (args["-B"] !== undefined) cmd.push("-B", String(args["-B"]));
    }
  }
  if (args.glob !== undefined) cmd.push("--glob", args.glob);
  if (args.type !== undefined) cmd.push("--type", args.type);
  if (args.multiline) cmd.push("-U", "--multiline-dotall");
  if (args.include_ignored) cmd.push("--no-ignore");
  for (const glob of SENSITIVE_GLOBS_TO_EXCLUDE) cmd.push("--glob", `!${glob}`);

  cmd.push("--", args.pattern, ...searchPaths);
  return cmd;
}

function splitRgLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.map((line) => stripTrailingCarriageReturn(line));
}

function parseRipgrepOutput(text: string, mode: GrepMode): ParsedGrepLine[] {
  if (text === "") return [];
  if (!text.includes(NUL)) {
    return splitRgLines(text).map((line) =>
      mode === "content" && line === "--" ? { kind: "separator" } : { kind: "legacy", text: line },
    );
  }

  if (mode === "files_with_matches") {
    return text
      .split(NUL)
      .map((filePath) => stripTrailingCarriageReturn(filePath))
      .filter((filePath) => filePath !== "")
      .map((filePath) => ({ kind: "record", filePath, payload: "" }));
  }

  const records: ParsedGrepLine[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === "\n") {
      cursor += 1;
      continue;
    }
    if (text.startsWith("--\r\n", cursor)) {
      records.push({ kind: "separator" });
      cursor += 4;
      continue;
    }
    if (text.startsWith("--\n", cursor)) {
      records.push({ kind: "separator" });
      cursor += 3;
      continue;
    }

    const nulIndex = text.indexOf(NUL, cursor);
    if (nulIndex < 0) {
      const tail = stripTrailingCarriageReturn(text.slice(cursor));
      if (tail !== "") records.push({ kind: "legacy", text: tail });
      break;
    }

    const lineEnd = text.indexOf("\n", nulIndex + 1);
    const payloadEnd = lineEnd >= 0 ? lineEnd : text.length;
    const filePath = text.slice(cursor, nulIndex);
    const payload = stripTrailingCarriageReturn(text.slice(nulIndex + 1, payloadEnd));
    records.push({ kind: "record", filePath, payload });
    cursor = lineEnd >= 0 ? lineEnd + 1 : text.length;
  }
  return records;
}

function formatDisplayLine(
  line: ParsedGrepLine,
  mode: GrepMode,
  workspaceDir: string,
  pathClass: PathClass,
  contentIncludesLineNumbers: boolean,
): string {
  if (line.kind === "separator") return "--";
  if (line.kind === "record") {
    const displayPath = relativizeIfUnder(line.filePath, workspaceDir, pathClass);
    if (mode === "files_with_matches") return displayPath;
    if (mode === "count_matches") return `${displayPath}:${line.payload}`;
    const separator = contentIncludesLineNumbers ? contentPayloadPathSeparator(line.payload) : ":";
    return `${displayPath}${separator}${line.payload}`;
  }

  const text = line.text;
  if (mode === "files_with_matches") return relativizeIfUnder(text, workspaceDir, pathClass);
  if (mode === "count_matches") {
    const idx = text.lastIndexOf(":");
    if (idx <= 0) return text;
    return relativizeIfUnder(text.slice(0, idx), workspaceDir, pathClass) + text.slice(idx);
  }

  const filePath = extractContentFilePath(text, pathClass);
  if (filePath !== undefined) return relativizeIfUnder(filePath, workspaceDir, pathClass) + text.slice(filePath.length);
  return text;
}

function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const normCandidate = normalize(candidate);
  const normBase = normalize(base);
  const comparableCandidate = pathClass === "win32" ? normCandidate.toLowerCase() : normCandidate;
  const comparableBase = pathClass === "win32" ? normBase.toLowerCase() : normBase;
  if (comparableCandidate === comparableBase) return ".";
  const prefix = comparableBase.endsWith("/") ? comparableBase : comparableBase + "/";
  if (comparableCandidate.startsWith(prefix)) return normCandidate.slice(prefix.length);
  return normCandidate;
}

function omitIncompleteTrailingRecord(text: string, mode: GrepMode): string {
  if (!text.includes(NUL)) return omitIncompleteTrailingLine(text);
  if (mode === "files_with_matches") {
    const lastNul = text.lastIndexOf(NUL);
    return lastNul >= 0 ? text.slice(0, lastNul + 1) : "";
  }

  let cursor = 0;
  let lastCompleteEnd = 0;
  while (cursor < text.length) {
    if (text[cursor] === "\n") {
      cursor += 1;
      lastCompleteEnd = cursor;
      continue;
    }
    if (text.startsWith("--\r\n", cursor)) {
      cursor += 4;
      lastCompleteEnd = cursor;
      continue;
    }
    if (text.startsWith("--\n", cursor)) {
      cursor += 3;
      lastCompleteEnd = cursor;
      continue;
    }

    const nulIndex = text.indexOf(NUL, cursor);
    if (nulIndex < 0) break;
    const lineEnd = text.indexOf("\n", nulIndex + 1);
    if (lineEnd < 0) break;
    cursor = lineEnd + 1;
    lastCompleteEnd = cursor;
  }
  return text.slice(0, lastCompleteEnd);
}

function omitIncompleteTrailingLine(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline >= 0 ? text.slice(0, lastNewline) : "";
}

function formatRipgrepError(exitCode: number, stderrText: string, truncated: boolean): string {
  const stderr = stderrText.trim();
  if (stderr.length === 0) return `Failed to grep: ripgrep exited with code ${String(exitCode)}`;
  const summary = summarizeRipgrepStderr(stderr);
  const lines = [`Failed to grep: ${summary}`, "", "ripgrep stderr:", stderr];
  if (truncated) lines.push(`[output truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`);
  return lines.join("\n");
}

function summarizeRipgrepStderr(stderr: string): string {
  const lines = splitRgLines(stderr)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = lines.findLast((line) => line.toLowerCase().startsWith("error:"));
  return errorLine ?? lines.at(-1) ?? "ripgrep error";
}

function filterSensitiveLines(
  lines: readonly ParsedGrepLine[],
  mode: GrepMode,
  filteredPaths: Set<string>,
  pathClass: PathClass,
): ParsedGrepLine[] {
  const kept: ParsedGrepLine[] = [];
  for (const line of lines) {
    if (line.kind === "separator") {
      kept.push(line);
      continue;
    }
    const filePath = parsedFilePath(line, mode, pathClass);
    if (filePath !== undefined && isSensitiveFile(filePath)) {
      filteredPaths.add(filePath);
      continue;
    }
    kept.push(line);
  }
  return mode === "content" ? normalizeContextSeparators(kept) : kept;
}

function normalizeContextSeparators(lines: readonly ParsedGrepLine[]): ParsedGrepLine[] {
  const normalized: ParsedGrepLine[] = [];
  for (const line of lines) {
    if (line.kind === "separator" && (normalized.length === 0 || normalized.at(-1)?.kind === "separator")) continue;
    normalized.push(line);
  }
  while (normalized.length > 0 && normalized.at(-1)?.kind === "separator") normalized.pop();
  return normalized;
}

function parsedFilePath(line: ParsedGrepLine, mode: GrepMode, pathClass: PathClass): string | undefined {
  if (line.kind === "record") return normalize(line.filePath);
  if (line.kind === "separator") return undefined;
  const text = line.text;
  if (mode === "files_with_matches") return normalize(text);
  if (mode === "count_matches") {
    const idx = text.lastIndexOf(":");
    return idx > 0 ? normalize(text.slice(0, idx)) : normalize(text);
  }
  return extractContentFilePath(text, pathClass);
}

function extractContentFilePath(line: string, pathClass: PathClass): string | undefined {
  const m = CONTENT_LINE_RE.exec(line);
  if (m?.[1] !== undefined) return normalize(m[1]);
  const separatorIndex = noLineNumberContentSeparatorIndex(line, pathClass);
  return separatorIndex > 0 ? normalize(line.slice(0, separatorIndex)) : undefined;
}

function noLineNumberContentSeparatorIndex(line: string, pathClass: PathClass): number {
  const searchFrom = pathClass === "win32" && /^[A-Za-z]:/.test(line) ? 2 : 0;
  return line.indexOf(":", searchFrom);
}

function contentPayloadPathSeparator(payload: string): ":" | "-" {
  const m = /^(\d+)([:-])/.exec(payload);
  return m?.[2] === "-" ? "-" : ":";
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function formatCountSummary(lines: readonly ParsedGrepLine[], redactedSensitive: boolean): string {
  let totalMatches = 0;
  let totalFiles = 0;
  for (const line of lines) {
    const rawCount =
      line.kind === "record" ? line.payload : line.kind === "legacy" ? countPayloadFromLegacyLine(line.text) : undefined;
    if (rawCount === undefined) continue;
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 0) continue;
    totalMatches += count;
    totalFiles++;
  }
  const occurrenceWord = totalMatches === 1 ? "occurrence" : "occurrences";
  const fileWord = totalFiles === 1 ? "file" : "files";
  const scope = redactedSensitive ? "total non-sensitive" : "total";
  return `Found ${String(totalMatches)} ${scope} ${occurrenceWord} across ${String(totalFiles)} ${fileWord}.`;
}

function countPayloadFromLegacyLine(line: string): string | undefined {
  const idx = line.lastIndexOf(":");
  return idx > 0 ? line.slice(idx + 1) : undefined;
}
