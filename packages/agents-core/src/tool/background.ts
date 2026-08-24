import type { Machine, RunCommandResult } from "./machine.ts";
import type { ToolResult } from "./types.ts";

/**
 * Starts ONE command and resolves with how it ended.
 *
 * This — not a process handle — is what a background task actually needs: stop it
 * (`signal`), watch it (`onOutput`), learn how it ended (the resolved result). All three are
 * `run`'s intent fields, so every backend delivers them with its own native means. Demanding
 * a live handle instead would require a capability sandbox transports cannot provide
 * honestly, which is what used to force a fake handle whose `kill()` did nothing.
 */
export type CommandStarter = (opts: {
  readonly signal: AbortSignal;
  /** Live pipe tap for an inline foreground run. File-backed background/attached commands omit
   * it because their canonical output is already on the Machine. */
  readonly onOutput?: (chunk: string) => void;
}) => Promise<RunCommandResult>;

export interface QuestionSpawnOptions {
  readonly questionCount: number;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
}

export interface ProcessSpawnOptions {
  /** The Machine file the process's output is redirected to (its durable work product);
   *  set together with `machine` so the task can read it back on demand. */
  readonly logPath?: string;
  readonly machine?: Machine;
  /** Parent conversation line. Namespaces `toolCallId`, which is not globally unique. */
  readonly parentAddress?: string;
  /** The tool call that started this command. Carried onto the settle notification so a UI can
   *  reattach the completion to the card that spawned it — the two are otherwise unrelated
   *  events separated by however long the command ran. */
  readonly toolCallId?: string;
}

/** Terminal status of an attached run that finished in the foreground (never detached). */
export type AttachedSettleStatus = "completed" | "failed" | "timed_out" | "killed";

/** Options for {@link BackgroundSpawner.runCommandAttached}. Extends the command spawn
 *  options (log file / machine) with the foreground-attachment seams. */
export interface AttachedRunOptions extends ProcessSpawnOptions {
  /** The tool call's abort signal. While attached, aborting it KILLS the process
   *  (foreground semantics). Dropped the instant the run detaches. */
  readonly foregroundSignal: AbortSignal;
  /** The tool call's detach trigger (`ctx.detachSignal`). Aborting it moves the still-running
   *  process into a background task and resolves with `{ kind: "detached" }`. */
  readonly detachSignal?: AbortSignal;
  /** Foreground-only timeout (ms). Applies while attached; dropped on detach. */
  readonly foregroundTimeoutMs?: number;
  /** Live output tap while attached — feed the tool's result builder + `ctx.onUpdate`.
   *  Stops being called the instant the run detaches (output then flows to the task tail). */
  readonly onLive?: (chunk: string) => void;
  /**
   * Fired once, when the run has lasted long enough to be worth offering to the user as
   * "move this to the background". Deliberately NOT at start: a command that finishes in
   * milliseconds should never make the UI flash an offer the user cannot act on.
   *
   * A driver that cannot detach never fires it.
   */
  readonly onDetachable?: () => void;
}

/**
 * The default {@link BackgroundSpawner.runCommandAttached} for a host with no task system:
 * run the command, honour the foreground timeout and abort, and report how it ended. It can
 * never return `detached` — there is nowhere for a task to live once the tool call returns.
 *
 * This exists so the CALLER has one code path. The alternative — a tool that branches on
 * whether the capability is present — is two implementations of "run a command in the
 * foreground" that drift apart, which is exactly what happened before it existed.
 */
export async function runCommandInline(start: CommandStarter, options: AttachedRunOptions): Promise<AttachedOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const stop = (why: "timeout" | "aborted"): void => {
    if (why === "timeout") timedOut = true;
    controller.abort();
  };
  const onAbort = (): void => stop("aborted");
  if (options.foregroundSignal.aborted) stop("aborted");
  else options.foregroundSignal.addEventListener("abort", onAbort);
  const timer =
    options.foregroundTimeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), options.foregroundTimeoutMs);

  try {
    const result = await start({
      signal: controller.signal,
      onOutput: (chunk) => options.onLive?.(chunk),
    });
    // `run` reports its OWN timeout too; either route means the same thing to the caller.
    const status: AttachedSettleStatus =
      timedOut || result.timedOut ? "timed_out" : options.foregroundSignal.aborted ? "killed" : result.exitCode === 0 ? "completed" : "failed";
    return { kind: "settled", status, exitCode: result.exitCode ?? null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.foregroundSignal.removeEventListener("abort", onAbort);
  }
}

/** Result of an attached run: it either settled in the foreground or was detached. */
export type AttachedOutcome =
  | { readonly kind: "settled"; readonly status: AttachedSettleStatus; readonly exitCode: number | null }
  | { readonly kind: "detached"; readonly taskId: string };

export interface BackgroundSpawner {
  spawnCommand(start: CommandStarter, command: string, description: string, options?: ProcessSpawnOptions): string;
  /**
   * Run an interactive question as a background task (AskUserQuestion `background: true`).
   * The spawner owns task construction and lifecycle; the tool only supplies the run
   * closure. Optional: a BackgroundSpawner without task management omits it.
   */
  spawnQuestion?(
    run: (signal: AbortSignal) => Promise<ToolResult>,
    description: string,
    options: QuestionSpawnOptions,
  ): { readonly taskId: string; readonly status: string };
  /**
   * Run a command ATTACHED to the foreground, with the option to detach it into a background
   * task mid-flight. The spawner owns task construction, the swappable settlement sink, and the
   * abort re-ownership on detach; the tool supplies the starter + the foreground seams and
   * frames the result from the returned {@link AttachedOutcome}. Optional: a spawner without
   * detach support omits it, and the tool falls back to a plain foreground `run`.
   */
  runCommandAttached?(
    start: CommandStarter,
    command: string,
    description: string,
    options: AttachedRunOptions,
  ): Promise<AttachedOutcome>;
  /**
   * Register a per-call detach trigger and return the signal to pass as `ctx.detachSignal`.
   * The loop calls this before running a tool and {@link unregisterDetachable} after. Firing
   * the trigger is {@link detach}. Optional: a spawner without detach routing omits all three.
   */
  registerDetachable?(toolCallId: string): AbortSignal;
  unregisterDetachable?(toolCallId: string): void;
  /** Fire the detach trigger for a running tool call (foreground → background). Returns false
   *  if no such call is currently registered. */
  detach?(toolCallId: string): boolean;
}
