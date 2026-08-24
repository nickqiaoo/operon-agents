import type { Machine } from "../machine.ts";

/**
 * One ripgrep invocation, run on the given machine (local / ssh / sandbox) through
 * `machine.run`. The Grep and Glob tools share this so their handling of a search that
 * runs too long or prints too much stays identical.
 *
 * Timeout, output capping and cancellation are stated as INTENT and fulfilled by the
 * backend natively — local spawn + signals, a vendor's `timeoutMs` + `kill(pid)`. This
 * used to be assembled here out of a raw process handle's POSIX machinery, which only
 * local backends implement honestly: on a sandbox the SIGTERM→SIGKILL escalation went
 * nowhere and the cap only trimmed output that had already been transferred. Backends
 * that still cannot stop a command now say so via `terminated`, instead of the tool
 * assuming it worked.
 *
 * EAGAIN retry policy is left to the caller (each tool decides whether to re-run
 * single-threaded), so this stays a single-shot primitive.
 */
export interface RipgrepRunResult {
  /**
   * `undefined` when the run has no meaningful exit status — it was killed on timeout, or
   * the backend could not confirm completion. Callers must not read that as success.
   */
  readonly exitCode: number | undefined;
  readonly stdoutText: string;
  readonly stderrText: string;
  /** Output hit the cap and was cut — the last record may be severed. */
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /**
   * Whether ripgrep was actually stopped when the timeout demanded it. `false` means the
   * backend could only walk away and the search may still be burning sandbox CPU — worth
   * saying out loud rather than hiding.
   */
  readonly terminated: boolean;
}

export type RipgrepRunOutcome =
  | { readonly kind: "result"; readonly result: RipgrepRunResult }
  | { readonly kind: "aborted" }
  | { readonly kind: "exec-error"; readonly error: unknown; readonly isEnoent: boolean };

export interface RipgrepRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /**
   * Working directory for the ripgrep process. Callers that pass a relative search target
   * need this, and Glob needs the relative target: `--glob` is matched against the paths
   * ripgrep PRINTS, so an absolute target makes every glob containing a `/` (`src/**\/*.ts`)
   * anchor against `/abs/root/src/...` and match nothing.
   */
  readonly cwd?: string;
}

/**
 * Wording for a timeout, honest about whether the backend could actually stop ripgrep.
 * A backend that can only walk away leaves the search running on the remote machine —
 * the model should hear that instead of being told the search "timed out" as if it were
 * cleanly cancelled. Phrasing only: no caller branches on it.
 */
export function stillRunningNote(terminated: boolean): string {
  return terminated ? "" : " (the search could not be stopped and may still be running)";
}

export async function runRipgrep(
  machine: Machine,
  rgArgs: readonly string[],
  signal: AbortSignal,
  options: RipgrepRunOptions,
): Promise<RipgrepRunOutcome> {
  if (signal.aborted) return { kind: "aborted" };

  let result;
  try {
    result = await machine.run(rgArgs, {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      signal,
    });
  } catch (error) {
    const isEnoent =
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    return { kind: "exec-error", error, isEnoent };
  }

  if (signal.aborted) return { kind: "aborted" };

  return {
    kind: "result",
    result: {
      exitCode: result.exitCode,
      stdoutText: result.stdout,
      stderrText: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
      terminated: result.terminated,
    },
  };
}
