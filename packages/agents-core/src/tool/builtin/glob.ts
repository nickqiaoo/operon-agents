import { normalize, posix, win32 } from "node:path";
import { z } from "zod";
import { isAbortError } from "../../loop/errors.ts";
import { ToolAccesses } from "../access.ts";
import { defineTool } from "../define.ts";
import { resolveRgCommand, rgUnavailableMessage } from "../support/rg-locator.ts";
import { runRipgrep, stillRunningNote, type RipgrepRunOutcome, type RipgrepRunResult } from "../support/ripgrep-run.ts";
import { globApproval, resolveToolPath, SEARCH_ACCESS_POLICY } from "../support/tool-path.ts";
import type { Machine } from "../machine.ts";
import type { ToolResult } from "../types.ts";

type PathClass = "posix" | "win32";

const GlobInput = z.object({
  pattern: z.string().describe("Glob pattern to match files."),
  path: z
    .string()
    .optional()
    .describe("Absolute path to the directory to search in. Defaults to the current working directory."),
});

type GlobInput = z.infer<typeof GlobInput>;

export const MAX_MATCHES = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
// rg --files lists files only (it cannot emit directories); VCS metadata dirs are noise.
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;

const GLOB_DESCRIPTION = [
  "Find files by glob pattern, sorted by modification time (most recent first).",
  "",
  "Good patterns:",
  "- `*.ts` — files at any depth matching an extension",
  "- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension",
  "- `**/*.py` — recursive walk from the search root for an extension",
  "- `*.{ts,tsx}` — brace alternation is supported",
  "",
  "This tool returns files only, not directories. This searches by path/name only; to search file contents, use Grep instead.",
  "",
  `Results are capped at the first ${String(MAX_MATCHES)} matching paths after modification-time sorting. Refine the pattern (extension, subdirectory) when ${String(MAX_MATCHES)} is not enough, or call again with a narrower anchor.`,
  "",
  "Large-directory caveat — avoid recursing into dependency / build output even with an anchor:",
  "- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` all match technically but typically produce thousands of results that truncate at the match cap and waste the caller context. Prefer specific subpaths like `node_modules/react/src/**/*.js`.",
].join("\n");

export const globTool = defineTool({
  name: "Glob",
  description: GLOB_DESCRIPTION,
  params: GlobInput,
  async resolve(args, ctx) {
    const root =
      args.path !== undefined
        ? await resolveToolPath(args.path, ctx.machine, "search", SEARCH_ACCESS_POLICY)
        : ctx.machine.getcwd();
    return {
      accesses: ToolAccesses.searchTree(root),
      display: { title: `Searching ${args.pattern}`, detail: `pattern: ${args.pattern}` },
      ...globApproval("Glob", args.pattern),
      run: (runCtx) => execute(args, root, runCtx.machine, runCtx.signal),
    };
  },
});

async function execute(args: GlobInput, root: string, machine: Machine, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return err("Glob aborted");

  let rgCommand: string;
  try {
    rgCommand = await resolveRgCommand(machine, { signal });
  } catch (error) {
    if (isAbortError(error)) return err("Glob aborted");
    return err(rgUnavailableMessage(error));
  }

  // Probe the root so a missing/non-dir root reports clearly. rg would otherwise emit a
  // terse stderr; this single fileInfo gives the same ENOENT/ENOTDIR message Read/Grep do.
  try {
    const info = await machine.fileInfo(root);
    if (info.kind !== "dir") return err(`${root} is not a directory`);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return err(`${root} does not exist`);
    if (code === "ENOTDIR") return err(`${root} is not a directory`);
    // Unknown failure: fall through and let rg run.
  }

  const pattern = relativizePattern(args.pattern, root, machine.pathClass());
  // Search target is "." with the process cwd at `root`, NOT the absolute root — see
  // buildRgArgs. Everything downstream therefore sees paths like `./src/a.ts`.
  const runOptions = { timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES, cwd: root };
  let outcome = await runRipgrep(machine, buildRgArgs(rgCommand, pattern), signal, runOptions);
  const earlyExit = mapNonResult(outcome);
  if (earlyExit) return earlyExit;
  let runResult = (outcome as Extract<RipgrepRunOutcome, { kind: "result" }>).result;

  if (shouldRetryEagain(runResult)) {
    outcome = await runRipgrep(machine, buildRgArgs(rgCommand, pattern, true), signal, runOptions);
    const retryExit = mapNonResult(outcome);
    if (retryExit) return retryExit;
    runResult = (outcome as Extract<RipgrepRunOutcome, { kind: "result" }>).result;
  }

  const { exitCode, stdoutText, stderrText, truncated, timedOut, terminated } = runResult;

  // rg --files: 0 = matches, 1 = no matches, >1 = real error. An `undefined` code is not a
  // failure — it means the run was cut short (timeout kill, or a backend that cannot
  // confirm completion), and whatever rg printed before that is still usable.
  if (exitCode !== undefined && exitCode !== 0 && exitCode !== 1 && !timedOut) {
    return err(formatRgError(exitCode, stderrText, truncated));
  }
  if (signal.aborted) return err("Glob aborted");

  const lines = splitLines(stdoutText);
  // A byte-cap/timeout cut may have severed the last path mid-line; drop it.
  if ((truncated || timedOut) && lines.length > 0) lines.pop();

  if (timedOut && lines.length === 0) {
    return err(
      `Glob timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s${stillRunningNote(terminated)}. ` +
        `Try a more specific path or pattern.`,
    );
  }

  // rg already ordered results newest-first (--sortr modified); we only cap.
  const overCap = lines.length > MAX_MATCHES;
  const capped = overCap ? lines.slice(0, MAX_MATCHES) : lines;

  // Paths arrive relative to `root` (the target was "."). Keep them that way when the search
  // stayed inside the workspace; otherwise re-absolutize, since a bare relative path would be
  // read against the caller's cwd and point somewhere else entirely.
  const pathClass = machine.pathClass();
  const keepRelative = isWithinDirectory(root, machine.getcwd(), pathClass);
  const displayLines = capped.map((p) => {
    const relative = stripLeadingDotSlash(p);
    return keepRelative ? relative : joinPath(pathClass, root, relative);
  });

  if (displayLines.length === 0 && !overCap && !timedOut && !truncated) return ok("No matches found");

  const out: string[] = [];
  if (overCap) {
    out.push(`[Truncated at ${String(MAX_MATCHES)} matches — use a more specific pattern]`);
  }
  out.push(...displayLines);
  if (truncated) out.push(`[output truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`);
  if (timedOut) {
    out.push(
      `Glob timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s${stillRunningNote(terminated)}; ` +
        `partial results returned`,
    );
  }
  return ok(out.join("\n"));
}

function buildRgArgs(rgCommand: string, pattern: string, singleThreaded = false): string[] {
  // List every file (--hidden, --no-ignore), most-recently-modified first (--sortr modified),
  // filtered by the requested glob. rg's globs natively support brace alternation and
  // gitignore-style `**`, so no tool-side brace expansion is needed.
  //
  // The target is "." and the ROOT IS THE PROCESS CWD. It cannot be the absolute root:
  // `--glob` matches against the paths ripgrep prints, and a glob containing a `/` anchors
  // to the start of that path, so `src/**/*.ts` against printed `/abs/root/src/a.ts` matches
  // nothing — including the anchored patterns this tool's own description recommends.
  const cmd = [rgCommand, "--files", "--hidden", "--no-ignore", "--sortr", "modified"];
  if (singleThreaded) cmd.push("-j", "1");
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) cmd.push("--glob", `!${dir}`);
  cmd.push("--glob", pattern);
  cmd.push("--", ".");
  return cmd;
}

/**
 * An absolute pattern under the search root becomes relative to it, since `--glob` is matched
 * against root-relative printed paths and an absolute glob can never match one.
 *
 * A pattern outside the root is left alone: it genuinely matches nothing here, and silently
 * reinterpreting it as relative would answer a different question than the one asked.
 */
function relativizePattern(pattern: string, root: string, pathClass: PathClass): string {
  const isAbsolutePattern = pathClass === "win32" ? /^(?:[A-Za-z]:[\\/]|[\\/])/.test(pattern) : pattern.startsWith("/");
  if (!isAbsolutePattern) return pattern;
  const relative = relativizeIfUnder(pattern, root, pathClass);
  return relative === pattern ? pattern : relative;
}

/** Map an aborted/exec-error outcome to a tool result, or null when ripgrep ran. */
function mapNonResult(outcome: RipgrepRunOutcome): ToolResult | null {
  if (outcome.kind === "aborted") return err("Glob aborted");
  if (outcome.kind === "exec-error") {
    return err(
      outcome.isEnoent
        ? rgUnavailableMessage(outcome.error)
        : outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error),
    );
  }
  return null;
}

function shouldRetryEagain(result: RipgrepRunResult): boolean {
  // No exit code means the run was cut short, not that rg failed to spawn threads — a
  // retry would just hit the same timeout.
  if (result.exitCode === undefined) return false;
  if (result.exitCode === 0 || result.exitCode === 1 || result.timedOut) return false;
  return result.stderrText.includes("os error 11") || result.stderrText.includes("Resource temporarily unavailable");
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function formatRgError(exitCode: number, stderrText: string, truncated: boolean): string {
  const stderr = stderrText.trim();
  if (stderr.length === 0) return `Failed to glob: ripgrep exited with code ${String(exitCode)}`;
  const summary =
    stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1) ?? "ripgrep error";
  const lines = [`Failed to glob: ${summary}`, "", "ripgrep stderr:", stderr];
  if (truncated) lines.push(`[output truncated at ${String(MAX_OUTPUT_BYTES)} bytes]`);
  return lines.join("\n");
}

/** ripgrep prefixes every path with the `.` target it was given. */
function stripLeadingDotSlash(value: string): string {
  if (value.startsWith("./")) return value.slice(2);
  if (value.startsWith(".\\")) return value.slice(2);
  return value;
}

/** Join with the TARGET machine's path flavour — a local process may drive a posix machine. */
function joinPath(pathClass: PathClass, dir: string, name: string): string {
  return (pathClass === "win32" ? win32 : posix).join(dir, name);
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

function isWithinDirectory(candidate: string, base: string, pathClass: PathClass): boolean {
  const c = pathClass === "win32" ? normalize(candidate).toLowerCase() : normalize(candidate);
  const b = pathClass === "win32" ? normalize(base).toLowerCase() : normalize(base);
  if (c === b) return true;
  const prefix = b.endsWith("/") ? b : b + "/";
  return c.startsWith(prefix);
}

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function ok(output: string): ToolResult {
  return { content: [{ type: "text", text: output }] };
}

function err(output: string): ToolResult {
  return { content: [{ type: "text", text: output }], isError: true };
}
