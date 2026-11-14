import { wrapForTaskLog, attachFileOutput } from './environment-output.ts';
import { commandLine } from './environment-commands.ts';
/**
 * Implementer-side base for Environment backends.
 *
 * A backend writes only the dumb primitives (the abstract SPI below, file I/O
 * included); this class derives the high-level operations from them:
 *
 * - `run`: spawn → cap both streams → escalating kill on timeout/abort.
 * - `realpath`: `readlink -f` via `run` on posix, normpath on win32. Hosts with
 *   a native resolver (fs.realpath, SFTP realpath) override for exactness.
 */
import type { Readable, Writable } from "node:stream";
import { ProcessTable, commandArgv, runViaHandle } from './environment-commands.ts';
import { EnvironmentFilesAdapter } from './environment-files.ts';
import { PlainSandbox } from './environment-sandbox.ts';
import type { Command, CommandStartOptions, CommandHandle, EnvironmentCommands, EnvironmentFiles, EnvironmentSandbox, EnvironmentPty } from './environment.ts';
import { posix, win32 } from "node:path";
import {
  type RunCommandResult,
  type DirEntry,
  type OsInfo,
  type ByteRange,
  type Environment,
  type RunCommandOptions,
  type FileInfo,
} from "./environment.ts";

/** Deadline for the `readlink -f` realpath fallback (see BaseEnvironment.realpath). */
const REALPATH_TIMEOUT_MS = 10_000;

/**
 * A live OS process, normalized. IMPLEMENTER-SIDE ONLY — this is what {@link BaseEnvironment.spawn}
 * hands back so ONE copy of `run`'s read/cap/decode/kill-escalate logic can serve backends
 * whose native process objects disagree on the details: node's `ChildProcess` kills by signal
 * name and reports exit on one event, while an ssh2 `ClientChannel` wants the signal without
 * its `SIG` prefix, splits exit across `exit`/`close`, and drops output emitted before a
 * consumer attaches. Each backend absorbs its own quirks here.
 *
 * Native pid is optional; transports without one use a process-table identifier.
 */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** null while running. Read after a kill to tell "it stopped" from "it ignored us". */
  readonly exitCode: number | null;
  wait(): Promise<number>;
  /**
   * Signal the process AND everything it started. A command reaches us as `sh -c '…'`, so the
   * process we hold is usually just the shell — signalling only it leaves the real command
   * running as an orphan while `run` reports it stopped.
   */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Join with the TARGET environment's path flavour, not the host's — a local process may be
 *  driving a posix environment (SSH / sandbox) or vice versa. */
function joinPath(pathClass: "posix" | "win32", dir: string, name: string): string {
  return (pathClass === "win32" ? win32 : posix).join(dir, name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Single-quote for a POSIX shell; only used by the subshell `cwd` fallback. */
function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Shared process-table commands and compatibility primitives for backend implementers. */
export abstract class BaseEnvironment implements Environment {
  abstract readonly name: string;
  abstract readonly osInfo: OsInfo;

  // ---- SPI: identity & path semantics ----
  abstract pathClass(): "posix" | "win32";
  abstract normpath(path: string): string;
  abstract gethome(): string;
  abstract getcwd(): string;
  abstract withCwd(cwd: string): Environment;
  /** Extra workspace roots (see Environment.additionalDirs). Default: cwd only. */
  additionalDirs(): readonly string[] {
    return [];
  }

  // ---- SPI: processes ----
  /**
   * Spawn a live process. IMPLEMENTER-SIDE ONLY — no caller reaches for this; it exists so
   * `run` below can be derived on backends whose transport really does hand one back (local
   * spawn, an SSH channel). `env` is a set of OVERRIDES layered over the ambient environment.
   *
   * Optional on purpose. A backend whose transport has no process handle — a sandbox HTTP
   * API — omits it and overrides `run` natively instead. That is the honest shape: such a
   * backend used to be forced to fabricate a handle whose `kill()` did nothing, which the
   * callers above then trusted.
   */
  protected spawn?(argv: readonly string[], env?: Record<string, string>): Promise<SpawnedProcess>;

  // ---- SPI: directories & files ----
  abstract fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo>;
  abstract listDir(path: string): Promise<readonly DirEntry[]>;
  abstract mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void>;
  abstract readBytes(path: string, range?: ByteRange): Promise<Buffer>;
  abstract writeBytes(path: string, data: Buffer): Promise<void>;

  // ---- Derived high-level operations (override when the backend can do better) ----

  /**
   * `listDir` helper for backends whose native listing hands back bare names: stat each
   * entry, but in PARALLEL — the serial stat-per-entry walk is exactly what putting `kind`
   * in the listing contract exists to prevent. `lstat` semantics (`followSymlinks: false`)
   * to match `DirEntry`, so a symlink stays a symlink as it would in a native readdir.
   *
   * Backends whose readdir already reports kinds (local opendir, SFTP readdir) never call
   * this — they answer in one round trip.
   */
  protected async entriesByStatting(path: string, names: readonly string[]): Promise<readonly DirEntry[]> {
    return Promise.all(
      names.map(async (name) => {
        const info = await this.fileInfo(joinPath(this.pathClass(), path, name), { followSymlinks: false })
          // An entry that vanished between readdir and stat is reported as "other" rather
          // than failing the whole listing — callers filter by kind anyway.
          .catch(() => undefined);
        return { name, kind: info?.kind ?? "other" } satisfies DirEntry;
      }),
    );
  }

  /**
   * `run` derived from the process-spawning SPI: spawn, cap both streams while reading, and
   * on timeout/abort escalate SIGTERM → SIGKILL. This is the logic that used to live in the
   * Grep/Glob and Bash tool layers — it belongs here, where "kill the process" is something
   * the backend actually knows how to do (and where a backend that CANNOT do it reports
   * `terminated: false` instead of the tool pretending it worked).
   *
   * Backends without a process handle override this wholesale; the throw below is the
   * contract's other half made loud rather than silent.
   */
  protected outputFiles = new Map<number, string>();
  protected processTable = new ProcessTable();
  readonly files: EnvironmentFiles = new EnvironmentFilesAdapter(this);
  readonly sandbox: EnvironmentSandbox = new PlainSandbox();
  readonly pty?: EnvironmentPty;
  readonly commands: EnvironmentCommands = {
    run: (command, options) => this.runCommand(command, options),
    start: (command, options) => this.startCommand(command, options ?? {}),
    list: () => this.processTable.list(),
    connect: async (pid, options) => {
      const handle = await this.processTable.connect(pid, options);
      const path = this.outputFiles.get(pid);
      return path ? attachFileOutput(handle, this.files, path, options?.onStdout, options?.retainOutput !== false) : handle;
    },
    kill: pid => this.processTable.kill(pid),
    sendStdin: (pid, data) => this.processTable.sendStdin(pid, data),
    closeStdin: pid => this.processTable.closeStdin(pid),
  };
  protected async startCommand(command: Command, options: CommandStartOptions): Promise<CommandHandle> {
    if (!this.spawn) throw new Error(`${this.name}: backend must implement startCommand`);
    const output = options.outputFile;
    if (output) {
      await this.files.write(output, '');
      await this.files.remove(`${output}.exit`);
      if (options.stderrFile) await this.files.write(options.stderrFile, '');
      command = wrapForTaskLog(commandLine(command), output, options.stderrFile);
    }
    const proc = await this.spawn(this.withCwdArgv(commandArgv(command, this.osInfo), options.cwd), options.env);
    const handle = await this.processTable.start(proc, command, options, () => this.escalatingKill(proc));
    if (output) {
      this.outputFiles.set(handle.pid, output);
      void handle.wait().finally(() => this.outputFiles.delete(handle.pid)).catch(() => {});
      return attachFileOutput(handle, this.files, output, options.onStdout, options.retainOutput !== false);
    }
    return handle;
  }
  protected runCommand(command: Command, options?: RunCommandOptions): Promise<RunCommandResult> {
    return runViaHandle((cmd, opts) => this.startCommand(cmd, opts), command, options);
  }
  async run(argv: readonly string[], options?: RunCommandOptions): Promise<RunCommandResult> {
    return this.commands.run(argv, options);
  }

  /** How long SIGTERM gets before SIGKILL, and SIGKILL before we give up. Overridable so a
   *  backend (or a test) can tighten it; the default matches the shell's own convention. */
  protected sigtermGraceMs = 5_000;

  /**
   * SIGTERM, then SIGKILL. Returns whether the process stopped within its grace.
   *
   * The SIGKILL is UNCONDITIONAL, including on the path where the process exited politely, and
   * that is the whole trick. A command arrives as `sh -c '…'`, so what exits on SIGTERM is
   * usually just the shell; anything it started that trapped the signal keeps running, and a
   * stop that judged by the shell alone would report success over a live orphan.
   *
   * Sending it anyway costs nothing — the signal goes to the process GROUP, and a group with
   * nothing left in it is an ESRCH we ignore. And it costs no TIME, which is the point: a
   * survivor check could tell us whether the second signal is needed, but the answer only ever
   * saves a syscall, while asking it needs a poll loop. Waiting out the grace before killing
   * would cost real time, so we do not do that either: a child still alive after its parent
   * died of SIGTERM has already declined to go quietly, and giving it another five seconds to
   * reconsider is five seconds of a stopped command still holding its port.
   */
  private async escalatingKill(proc: SpawnedProcess, graceMs = this.sigtermGraceMs): Promise<boolean> {
    try {
      await proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const exited = proc.wait().then(() => true, () => true);
    const stopped = await Promise.race([exited, sleep(graceMs).then(() => false)]);

    try {
      await proc.kill("SIGKILL");
    } catch {
      /* nothing left to signal */
    }
    if (stopped) return true;

    // It outlived SIGTERM, so give SIGKILL the same grace to land before giving up on it.
    return await Promise.race([exited, sleep(graceMs).then(() => false)]);
  }

  /** `spawn` has no cwd parameter; a backend without a native one runs through a subshell. */
  protected withCwdArgv(argv: readonly string[], cwd: string | undefined): string[] {
    if (cwd === undefined) return [...argv];
    const quoted = argv.map(shellQuoteArg).join(" ");
    return ["sh", "-c", `cd ${shellQuoteArg(cwd)} && ${quoted}`];
  }

  /** Deadline for the readlink fallback; a test/backend subclass may shorten it. */
  protected realpathTimeoutMs = REALPATH_TIMEOUT_MS;

  /**
   * Exec-derived fallback (`readlink -f`). A readlink that is missing/unsupported or
   * exits nonzero degrades to `normpath` (best effort for backends without a native
   * resolver), but a HANG throws after {@link REALPATH_TIMEOUT_MS}: path-access relies
   * on realpath for its symlink guard, and a timeout silently degrading to string
   * matching would fail open. Hosts with a native resolver override this for exactness.
   */
  async realpath(path: string): Promise<string> {
    if (this.pathClass() === "win32") return this.normpath(path);
    // The deadline is raced OUTSIDE `run` rather than passed in as `timeoutMs`: a timeout
    // inside `run` resolves only after the kill escalation finishes, and this caller cannot
    // wait that long — path-access blocks on it. So we abort the run and reject immediately,
    // leaving the backend to finish stopping on its own.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = this.run(["readlink", "-f", "--", path], { signal: controller.signal });
    running.catch(() => undefined); // a post-deadline rejection must not surface as unhandled
    try {
      const result = await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          // Deliberately NOT unref'd: this timer is what unblocks the awaiting caller when the
          // command hangs — an unref'd timer would let an otherwise-idle process exit mid-await.
          timer = setTimeout(() => {
            controller.abort();
            reject(codedError(`realpath: readlink -f timed out after ${this.realpathTimeoutMs}ms for '${path}'`, "ETIMEDOUT"));
          }, this.realpathTimeoutMs);
        }),
      ]);
      const resolved = result.stdout.trim();
      if (result.exitCode === 0 && resolved.length > 0) return resolved;
    } catch (error) {
      // A HANG is an infrastructure failure, not a resolution failure — surface it. Degrading
      // to string matching here would fail OPEN for path-access's symlink guard.
      if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw error;
      /* anything else (no such command, backend refused) falls through to normpath */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return this.normpath(path);
  }

}
