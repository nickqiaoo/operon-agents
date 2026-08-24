import { isAbsolute, resolve } from "node:path";
import { LocalMachine, type Machine, type RunCommandOptions, type RunCommandResult } from "operon-agents-core";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { toSrtInvocation } from "./srt-command.ts";

/**
 * The resolved write/read policy every sandboxed machine of one OsSandbox
 * shares. Immutable — a machine contributes only its own cwd/additionalDirs
 * on top, per call.
 */
export interface SandboxPolicyContext {
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  /** Session-level extra write roots (user config + tmp + task-log dirs). */
  readonly allowWrite: readonly string[];
}

/** The macOS violation monitor tails `log stream`, which reports denials with a
 *  small delay — a failed command gets one re-check after this long. */
const VIOLATION_SETTLE_MS = 250;

let commandCounter = 0;

/**
 * A LocalMachine whose `run` goes through the OS sandbox: the argv is wrapped
 * by @anthropic-ai/sandbox-runtime (Seatbelt on macOS, bubblewrap on Linux)
 * before it is spawned, and sandbox denials observed during the run are
 * annotated onto the result's stderr so callers see WHY a command failed.
 *
 * Only `run` changes. Direct file I/O (readBytes/writeText/…) is the
 * framework's own code path, gated by its path-access policy — the sandbox
 * exists for arbitrary COMMANDS, which have no such gate.
 */
export class SandboxedLocalMachine extends LocalMachine {
  private readonly policy: SandboxPolicyContext;

  constructor(policy: SandboxPolicyContext, cwdOrOptions: string | { cwd?: string; additionalDirs?: readonly string[] } = process.cwd()) {
    super(cwdOrOptions);
    this.policy = policy;
  }

  /** Re-rooted siblings (subagent worktrees) stay sandboxed — same policy, new cwd. */
  override withCwd(cwd: string): Machine {
    const absolute = isAbsolute(cwd) ? cwd : resolve(this.getcwd(), cwd);
    return new SandboxedLocalMachine(this.policy, { cwd: absolute, additionalDirs: this.additionalDirs() });
  }

  override async run(argv: readonly string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
    // The sandbox session died or was never initialized — refuse rather than
    // silently running unsandboxed. Hosts that want no sandbox build a plain
    // LocalMachine (OsSandbox.machine already does this when disabled).
    if (!SandboxManager.isSandboxingEnabled()) {
      throw new Error("os-sandbox: SandboxManager is not initialized; use OsSandbox.start() and build machines through it.");
    }

    // Fold a per-run cwd override into the argv exactly as BaseMachine.run
    // would — the sandbox must wrap the FINAL command, subshell and all.
    const { cwd, ...rest } = options;
    const effective = cwd === undefined ? argv : this.withCwdArgv(argv, cwd);
    const { command, binShell } = toSrtInvocation(effective, this.osEnv.shellPath);

    // A unique id, not the command text: srt compares attribution keys on
    // their first 100 chars, so long commands sharing a prefix would
    // cross-attribute violations.
    const commandId = `operon-os-sandbox-${String(++commandCounter)}`;

    let wrappedArgv: string[];
    try {
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        binShell,
        this.perCallConfig(),
        options.signal,
        this.getcwd(),
        { commandId, commandText: command },
      );
      wrappedArgv = wrapped.argv;
      // wrapped.env is process.env verbatim on macOS/Linux (proxy vars are baked
      // into the wrapped script) and LocalMachine already layers the caller's
      // overrides over the ambient env — so it is deliberately not forwarded.
    } catch (error) {
      throw new Error(`os-sandbox: failed to wrap command for the sandbox: ${error instanceof Error ? error.message : String(error)}`);
    }

    const result = await super.run(wrappedArgv, rest);
    const stderr = await this.annotateViolations(commandId, result);
    SandboxManager.cleanupAfterCommand();
    return stderr === result.stderr ? result : { ...result, stderr };
  }

  /**
   * Every machine states the full filesystem policy per call: srt falls back
   * per-FIELD (`?? config`), and an empty array is not undefined — restating
   * the session lists plus this machine's own roots is the only spelling that
   * cannot accidentally drop either half.
   */
  private perCallConfig(): Partial<SandboxRuntimeConfig> {
    const allowWrite = new Set<string>([...this.policy.allowWrite, this.getcwd(), ...this.additionalDirs()]);
    return {
      filesystem: {
        denyRead: [...this.policy.denyRead],
        denyWrite: [...this.policy.denyWrite],
        allowWrite: [...allowWrite],
      },
    };
  }

  private async annotateViolations(commandId: string, result: RunCommandResult): Promise<string> {
    let stderr = SandboxManager.annotateStderrWithSandboxFailures(commandId, result.stderr);
    // Only a FAILED command earns the settle-and-recheck: a denial the command
    // itself absorbed (fallback logic, `|| true`) is not worth 250ms.
    const failed = result.exitCode !== undefined && result.exitCode !== 0;
    if (stderr === result.stderr && failed) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, VIOLATION_SETTLE_MS));
      stderr = SandboxManager.annotateStderrWithSandboxFailures(commandId, result.stderr);
    }
    return stderr;
  }
}
