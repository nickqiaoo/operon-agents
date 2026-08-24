import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolAccesses, type ToolFileAccess } from "../access.ts";
import { ToolResultBuilder } from "../support/result-builder.ts";
import { matchesBashRule } from "../support/bash-rule-match.ts";
import { extractBashPaths } from "../support/bash-paths.ts";
import { destructiveWarning } from "../support/bash-destructive.ts";
import { escapeRuleSubjectLiteral } from "../support/rule-match.ts";
import type { Machine } from "../machine.ts";
import { nonInteractiveShellEnv } from "../shell-env.ts";
import { runCommandInline, type AttachedOutcome, type AttachedRunOptions, type BackgroundSpawner, type CommandStarter } from "../background.ts";
import type { ToolResult, ToolUpdate } from "../types.ts";
import { OPERON_HOME_DIRNAME } from "../../home.ts";
import { isWithinDirectory } from "../policies/path-access.ts";

const MS_PER_SECOND = 1000;
// 60s was short enough that builds and test suites routinely needed an explicit
// `timeout`, and each guess that came in low cost a full re-run.
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 10 * 60;

const BashInput = z.object({
  command: z.string().min(1, "Command cannot be empty.").describe("The command to execute."),
  cwd: z
    .string()
    .optional()
    .describe("The working directory in which to run the command. When omitted, the command runs in the session's working directory."),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_S)
    .optional()
    .describe(`Optional timeout in seconds for the command to execute. Default ${String(DEFAULT_TIMEOUT_S)}s, max ${String(MAX_TIMEOUT_S)}s.`),
  run_in_background: z.boolean().optional().describe("Whether to run the command as a background task."),
});

type BashInput = z.infer<typeof BashInput>;

const BASH_DESCRIPTION = [
  "Execute a shell command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely shell-specific or multi-step.",
  "",
  "**Translate these to a dedicated tool instead:**",
  "- `cat` / `head` / `tail` (known path) -> `Read`",
  "- `sed` / `awk` (in-place edit) -> `Edit`",
  "- `echo > file` / `cat <<EOF` -> `Write`",
  "- `find` / recursive `ls` to locate files by name pattern -> `Glob` (plain `ls <known-directory>` is fine for listing a directory)",
  "- `grep` / `rg` (search file contents) -> `Grep`",
  "- `echo` / `printf` (talk to the user) -> just output text directly",
  "",
  "The dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.",
  "",
  "**Output:**",
  "The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command failed, the output will end with a `Command failed with exit code: N` line stating the non-zero exit code.",
  "",
  "If `run_in_background=true`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. You will be automatically notified when the task completes. Use BackgroundOutput(task_id) for a non-blocking status/output snapshot, and BackgroundStop(task_id) only if the task must be cancelled. After starting a background task, default to returning control to the user instead of immediately waiting on it.",
  "",
  "**Guidelines for safety and security:**",
  "- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls.",
  `- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to ${String(DEFAULT_TIMEOUT_S)}s and allow up to ${String(MAX_TIMEOUT_S)}s.`,
  "- Avoid using `..` to access files or directories outside of the working directory.",
  "- Avoid modifying files outside of the working directory unless explicitly instructed to do so.",
  "- Never run commands that require superuser privileges unless explicitly instructed to do so.",
  "",
  "**Guidelines for efficiency:**",
  "- For multiple related commands, use `&&` to chain them in a single call, e.g. `cd /path && ls -la`",
  "- Use `;` to run commands sequentially regardless of success/failure",
  "- Use `||` for conditional execution (run second command only if first fails)",
  "- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands",
  "- Always quote file paths containing spaces with double quotes (e.g., cd \"/path with spaces/\")",
  "- Compose multi-step logic in a single call with `if` / `case` / `for` / `while` control flows.",
  "- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.",
  "",
  "**Commands available:**",
  "The following common command categories are usually available. Availability still depends on the host, so when in doubt run `which <command>` first to confirm a command exists before relying on it.",
  "- Navigation and inspection: `ls`, `pwd`, `cd`, `stat`, `file`, `du`, `df`, `tree`",
  "- File and directory management: `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`",
  "- Text and data processing: `wc`, `sort`, `uniq`, `cut`, `tr`, `diff`, `xargs`",
  "- Archives and compression: `tar`, `gzip`, `gunzip`, `zip`, `unzip`",
  "- Networking and transfer: `curl`, `wget`, `ping`, `ssh`, `scp`",
  "- Version control: `git`",
  "- Process and system: `ps`, `kill`, `top`, `env`, `date`, `uname`, `whoami`",
  "- Language and package toolchains: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip` (use whichever the project actually relies on)",
].join("\n");

function normalizeTimeoutMs(timeout: number | undefined): number {
  return Math.min(timeout ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * MS_PER_SECOND;
}

export const bashTool = defineTool({
  name: "Bash",
  description: BASH_DESCRIPTION,
  params: BashInput,
  // The command is the only security-relevant field; cwd/timeout/background don't change
  // what the action does — so the projection is just `input.command`.
  toAutoApprovalInput: (args) => args.command,
  resolve(args, ctx) {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      // What the command is read to touch. Best-effort by nature (see bash-paths.ts): this is
      // what lets the sensitive-file / git-control-path / write-outside-cwd policies see a Bash
      // call at all, which they otherwise skip entirely for want of anything to inspect.
      accesses: commandAccesses(args, ctx.machine),
      // `warning` is advisory only — nothing branches on it. It rides on the plan so whatever
      // renders the approval can show the caller why this command deserves a second look.
      display: {
        title: `Running: ${preview}`,
        command: args.command,
        ...(destructiveWarning(args.command) !== undefined ? { warning: destructiveWarning(args.command) } : {}),
      },
      approvalRule: `Bash(${escapeRuleSubjectLiteral(args.command)})`,
      matchesRule: (ruleArgs) => matchesBashRule(ruleArgs, args.command),
      run: (runCtx) => execute(args, runCtx.machine, runCtx.signal, runCtx.background, runCtx.onUpdate, runCtx.detachSignal, runCtx.address, runCtx.toolCallId),
    };
  },
});

/**
 * File accesses the command is read to perform, as absolute paths.
 *
 * Absolute matters: the policies compare against cwd with `isWithinDirectory`, and a bare
 * `notes.txt` would compare false and be reported as an out-of-workspace write. `~` is expanded
 * for the same reason. Anything that cannot be resolved is dropped rather than guessed at —
 * see bash-paths.ts on why silence is the correct failure mode here.
 */
function commandAccesses(args: BashInput, machine: Machine): ToolAccesses {
  const found = extractBashPaths(args.command);
  if (found.length === 0) return ToolAccesses.none();

  const pathClass = machine.pathClass();
  const base = args.cwd ?? machine.getcwd();
  let home: string | undefined;
  try {
    home = machine.gethome();
  } catch {
    home = undefined;
  }

  const accesses: ToolFileAccess[] = [];
  const seen = new Set<string>();
  for (const entry of found) {
    const absolute = toAbsolute(entry.path, base, home, pathClass);
    if (absolute === undefined) continue;
    const key = `${entry.operation}:${absolute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accesses.push({ kind: "file", operation: entry.operation, path: absolute });
  }
  return accesses;
}

function toAbsolute(path: string, base: string, home: string | undefined, pathClass: "posix" | "win32"): string | undefined {
  const p = pathClass === "win32" ? win32 : posix;
  let value = path;
  if (value === "~" || value.startsWith("~/")) {
    if (home === undefined || home.length === 0) return undefined;
    value = value === "~" ? home : p.join(home, value.slice(2));
  }
  // A `~user` form names someone else's home, which we cannot resolve without the passwd db.
  if (value.startsWith("~")) return undefined;
  if (p.isAbsolute(value)) return p.normalize(value);
  if (!p.isAbsolute(base)) return undefined;
  return p.normalize(p.join(base, value));
}

/** The argv + env overrides every bash invocation shares, whichever path ends up running it. */
function shellInvocation(
  machine: Machine,
  effectiveCwd: string,
  command: string,
): { readonly argv: string[]; readonly env: Record<string, string> } {
  const isWindowsBash = machine.osEnv.osKind === "Windows";
  const shellCwd = isWindowsBash ? windowsPathToPosixPath(effectiveCwd) : effectiveCwd;
  return {
    argv: [machine.osEnv.shellPath, "-c", `cd ${shellQuote(shellCwd)} && ${command}`],
    // Non-interactive overrides only; the machine layers these over its ambient env (PATH +
    // proxy vars ride through), so we don't ship the whole process environment downstream.
    env: nonInteractiveShellEnv({ shellPath: machine.osEnv.shellPath }),
  };
}

/** The same invocation, packaged for a spawner that owns the run's lifecycle (background,
 *  or foreground-attached-then-detachable). No timeout: those runs are bounded by the
 *  spawner's own foreground timer, or not at all once detached. */
function commandStarter(machine: Machine, effectiveCwd: string, command: string): CommandStarter {
  const { argv, env } = shellInvocation(machine, effectiveCwd, command);
  return ({ signal, onOutput }) =>
    machine.run(argv, {
      env,
      signal,
      ...(onOutput !== undefined ? { onOutput: (chunk) => onOutput(chunk.data) } : {}),
    });
}

async function execute(
  args: BashInput,
  machine: Machine,
  signal: AbortSignal,
  background?: BackgroundSpawner,
  onUpdate?: (update: ToolUpdate) => void,
  detachSignal?: AbortSignal,
  parentAddress?: string,
  toolCallId?: string,
): Promise<ToolResult> {
  if (signal.aborted) return errorResult("Aborted before command started");
  if (args.command.length === 0) return errorResult("Command cannot be empty.");

  const isWindowsBash = machine.osEnv.osKind === "Windows";
  const command = isWindowsBash ? rewriteWindowsNullRedirect(args.command) : args.command;

  if (args.run_in_background) {
    if (background === undefined) {
      return errorResult("Background execution is not available for this agent (Task tools not enabled).");
    }
    // Redirect output to a Machine log file: the OS captures the stream (survives this
    // process; detached commands keep logging), and the file — not process memory — is
    // the output's home. The ack carries the path so it stays readable across restarts.
    let logPath: string;
    try {
      logPath = await prepareBackgroundLog(machine);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
    const wrapped = `{ ${command}\n} > ${shellQuote(logPath)} 2>&1`;
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    const taskId = background.spawnCommand(commandStarter(machine, args.cwd ?? machine.getcwd(), wrapped), args.command, `bash: ${preview}`, {
      logPath,
      machine,
      ...(parentAddress !== undefined ? { parentAddress } : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    });
    return {
      content: [
        {
          type: "text",
          text:
            `Started background task ${taskId}.\n` +
            `output_log: ${logPath}\n` +
            "Use BackgroundOutput(task_id) to read its output and BackgroundStop(task_id) to stop it." +
            " The output log file stays readable (e.g. with Read) even after this session's process exits.",
        },
      ],
    };
  }

  const timeoutMs = normalizeTimeoutMs(args.timeout);

  // ONE foreground path. Which driver runs it is a detail of what this deployment has: the
  // background capability's, which can hand a still-running command over to a task mid-flight,
  // or the inline default, which cannot. Branching in the TOOL instead — as this used to —
  // means two implementations of "run a command in the foreground", and they drift.
  const attachedDriver = background?.runCommandAttached?.bind(background);
  const usesAttachedDriver = attachedDriver !== undefined;

  // Every command owned by an attached/background driver is file-backed from its first byte,
  // regardless of backend. The standard loop also supplies detachSignal, but storage does not
  // depend on that routing seam: passing BackgroundManager alone is enough to select one
  // canonical durable output path.
  // Local machines can do this cheaply, and sandbox/remote machines redirect inside their own
  // shell then expose the growing file through Machine.readBytes. Detach consequently changes
  // lifecycle ownership only; it never has to migrate an already-running pipe into memory.
  let logPath: string | undefined;
  if (usesAttachedDriver) {
    try {
      logPath = await prepareBackgroundLog(machine);
    } catch {
      // The manager's attached driver refuses pipe-only commands (assertDurableOutput), so a
      // machine that cannot host the log (unwritable home, quota) degrades to the inline pipe
      // driver below: the command still runs, it just cannot be detached into a task.
      logPath = undefined;
    }
  }
  const drive = attachedDriver !== undefined && logPath !== undefined
    ? attachedDriver
    : (start: CommandStarter, _c: string, _d: string, opts: AttachedRunOptions) => runCommandInline(start, opts);
  const fgCommand =
    logPath === undefined
      ? command
      : `{ ${command}\n} > ${shellQuote(logPath)} 2>&1`;

  const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
  const builder = new ToolResultBuilder();
  const start = commandStarter(machine, args.cwd ?? machine.getcwd(), fgCommand);

  let outcome: AttachedOutcome;
  try {
    outcome = await drive(start, args.command, `bash: ${preview}`, {
      foregroundSignal: signal,
      ...(detachSignal !== undefined ? { detachSignal } : {}),
      foregroundTimeoutMs: timeoutMs,
      // Attached mode passes logPath+machine so the driver knows WHERE this command's output
      // lives; with the live tap below it tails that file while we stay attached, and stops
      // the moment we detach. The no-manager inline path omits them and receives the pipe.
      ...(logPath !== undefined ? { logPath, machine } : {}),
      ...(parentAddress !== undefined ? { parentAddress } : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      onLive: (chunk) => {
        builder.write(chunk);
        onUpdate?.({ kind: "stdout", text: chunk });
      },
      // Fired by the driver once the run has lasted long enough to be worth offering — not at
      // start, so a command that returns in milliseconds never flashes the offer.
      onDetachable: () => onUpdate?.({ kind: "custom", customKind: "detachable" }),
    });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  if (outcome.kind === "detached") {
    // Correlation link: the UI re-subscribes this card from tool.progress to BackgroundOutput.
    onUpdate?.({ kind: "custom", customKind: "detached", customData: { taskId: outcome.taskId } });
    return {
      content: [
        {
          type: "text",
          text:
            `Moved to background task ${outcome.taskId}.\n` +
            (logPath !== undefined ? `output_log: ${logPath}\n` : "") +
            "Use BackgroundOutput(task_id) to read its output and BackgroundStop(task_id) to stop it." +
            (logPath !== undefined ? " The output log file stays readable (e.g. with Read) even after this session's process exits." : ""),
        },
      ],
      details: { movedToBackground: true, backgroundTaskId: outcome.taskId },
    };
  }

  const label = timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
  // In file mode the whole output was ALSO written to a log file. When the result had to drop
  // some of it, say where the rest is — the bytes exist and are readable, and a bare "output is
  // truncated" would strand the model one step from the answer. Only on truncation: naming the
  // file every time would push the model to Read what it was already handed in full.
  // The path must not be the last thing in the sentence: `ok()` appends a full stop to a
  // message that lacks one, and it would land on the filename.
  const overflow =
    logPath !== undefined && builder.truncated
      ? `\nThe untruncated output was also written to ${logPath} — Read that file to see what was dropped.`
      : "";
  switch (outcome.status) {
    case "completed":
      return builder.ok(`Command executed successfully.${overflow}`);
    case "timed_out":
      return builder.error(`Command killed by timeout (${label})${overflow}`, { brief: `Killed by timeout (${label})` });
    case "killed":
      return builder.error(`Interrupted by user${overflow}`, { brief: "Interrupted by user" });
    case "failed": {
      const code = outcome.exitCode === null ? "unknown" : String(outcome.exitCode);
      if (builder.nChars === 0) builder.write(`Process exited with code ${code}`);
      return builder.error(`Command failed with exit code: ${code}.${overflow}`, { brief: `Failed with exit code: ${code}` });
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** `<dir>/bash-<random>.log`; undefined = nowhere safe to put durable background output. */
function backgroundLogPath(machine: Machine): string | undefined {
  const dir = backgroundLogDir(machine);
  // Compose with '/' — both posix hosts and win32 Git-bash shells accept it.
  return dir === undefined ? undefined : `${dir}/bash-${randomBytes(4).toString("hex")}.log`;
}

/** Allocate the canonical command log before the user's process starts. The shell only owns
 * appending command output; directory/file setup failures therefore fail the tool cleanly
 * instead of escaping through an uncaptured outer stderr stream. */
async function prepareBackgroundLog(machine: Machine): Promise<string> {
  const logPath = backgroundLogPath(machine);
  if (logPath === undefined) {
    throw new Error("Background Bash execution requires a durable output log, but this machine has no safe task-log directory.");
  }
  await machine.mkdir(posixDirname(logPath), { parents: true });
  await machine.writeText(logPath, "");
  return logPath;
}

/**
 * Where task logs go: `<home>/.operon/tasks`, unless that would land inside the workspace.
 *
 * The rule being enforced is "framework bookkeeping must not appear in the user's project",
 * and the test for that is containment in the WORK DIRECTORY — not `home !== cwd`, which gets
 * it wrong in both directions. Every sandbox backend returns the same path for both (E2B
 * `/home/user`, Cloudflare `/workspace`), so a home-only rule silently drops task logs into
 * the very tree the agent is editing, where Glob/Grep surface them and git offers to commit
 * them. Conversely `cwd=/workspace/proj` with `home=/workspace` is perfectly fine, and a
 * `home !== cwd` test would needlessly relocate it.
 *
 * The fallback is `/tmp`: still on the machine (so `Read` reaches it, sandbox included),
 * outside the workspace, and alive for as long as the machine is. On win32 there is no
 * equivalent worth guessing at, and a Windows home is never the workspace in practice, so it
 * keeps the home path.
 */
function backgroundLogDir(machine: Machine): string | undefined {
  let home: string;
  try {
    home = machine.gethome();
  } catch {
    return undefined;
  }
  if (home.length === 0) return undefined;
  const candidate = `${home.replaceAll("\\", "/").replace(/\/+$/, "")}/${OPERON_HOME_DIRNAME}/tasks`;
  let cwd: string;
  try {
    cwd = machine.getcwd();
  } catch {
    return candidate;
  }
  const pathClass = machine.pathClass();
  if (cwd.length === 0 || !isWithinDirectory(candidate, cwd.replaceAll("\\", "/"), pathClass)) return candidate;
  return pathClass === "win32" ? candidate : `/tmp/${OPERON_HOME_DIRNAME}/tasks`;
}

function posixDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function windowsPathToPosixPath(path: string): string {
  if (path.startsWith("\\\\")) return path.replaceAll("\\", "/");
  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll("\\", "/");
    return `/${drive}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  return path.replaceAll("\\", "/");
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, "$1/dev/null");
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
