/**
 * Noticing a background command that is stuck on an interactive prompt.
 *
 * Commands get no terminal and an empty stdin, so a `(y/n)` or `Press Enter` can never be
 * answered — the task just sits there until someone stops it, and the model, which is not
 * watching the log, has no reason to look. This watches for exactly that shape: output that
 * stopped growing AND a last line that reads as a prompt. A command that is merely slow (a long
 * build, `git log -S`) goes quiet too, but its last line is not a question, so it stays silent.
 *
 * Mirrors Claude Code's background-shell watchdog (same threshold, same patterns, plus npx's
 * install prompt).
 */
import type { Machine } from "../../tool/machine.ts";

/**
 * How often a watched log is checked for growth.
 *
 * A background task is otherwise notification-driven — nobody reads its output until it ends or
 * is asked for — so this is the one recurring cost it carries, on every running task, for the
 * whole of its life. A check is one `fileInfo`: a metadata call on the backends that have one,
 * but still a `stat(1)` command on those that do not. Sampling at a third of the threshold keeps
 * that rare while still noticing a stuck prompt within {@link STALL_THRESHOLD_MS} of it
 * appearing, at worst one interval later.
 */
export const STALL_CHECK_INTERVAL_MS = 15_000;
/** How long output must stay unchanged before the tail is inspected. */
export const STALL_THRESHOLD_MS = 45_000;
/** How much of the log's end is read to find its last line. */
const STALL_TAIL_BYTES = 1024;

/** Last-line shapes of a prompt waiting for keyboard input. */
const PROMPT_PATTERNS: readonly RegExp[] = [
  /\(y\/n\)/i, // (Y/n), (y/N)
  /\[y\/n\]/i, // [Y/n], [y/N]
  /\(yes\/no\)/i,
  /\? *\([yn]\) *$/i, // npx/npm create: "Ok to proceed? (y)" — not in Claude Code's list
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split("\n").pop() ?? "";
  return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

export interface StallWatchdogTiming {
  readonly checkIntervalMs?: number;
  readonly thresholdMs?: number;
}

/**
 * Watch a task's log file; call `onStall` once, with the log's tail, when it looks stuck on a
 * prompt. Returns the function that stops watching. Every check costs one `fileInfo`; the tail
 * is read only after the threshold passes, and only once per quiet period.
 */
export function startStallWatchdog(
  file: { readonly machine: Machine; readonly path: string },
  onStall: (tail: string) => void,
  timing: StallWatchdogTiming = {},
): () => void {
  const checkIntervalMs = timing.checkIntervalMs ?? STALL_CHECK_INTERVAL_MS;
  const thresholdMs = timing.thresholdMs ?? STALL_THRESHOLD_MS;
  let lastSize = -1;
  let lastGrowth = Date.now();
  let stopped = false;
  let checking = false;

  const check = async (): Promise<void> => {
    const { size } = await file.machine.fileInfo(file.path);
    if (size !== lastSize) {
      lastSize = size;
      lastGrowth = Date.now();
      return;
    }
    if (Date.now() - lastGrowth < thresholdMs || size === 0) return;
    const offset = Math.max(0, size - STALL_TAIL_BYTES);
    const tail = (await file.machine.readBytes(file.path, { offset, length: size - offset })).toString("utf8");
    if (stopped) return;
    if (!looksLikePrompt(tail)) {
      // Quiet but not asking anything: look again after another full threshold, not every tick.
      lastGrowth = Date.now();
      return;
    }
    stop();
    onStall(tail.trimEnd());
  };

  const timer = setInterval(() => {
    // Serialize: a slow remote stat must not let the next tick start a second check.
    if (checking || stopped) return;
    checking = true;
    check()
      .catch(() => {
        /* the log not created yet, or its machine briefly unreachable — try again next tick */
      })
      .finally(() => {
        checking = false;
      });
  }, checkIntervalMs);
  // Never the reason a host process stays alive.
  timer.unref?.();

  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
