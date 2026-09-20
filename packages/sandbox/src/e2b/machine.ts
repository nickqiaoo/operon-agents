import { posix } from "node:path";
import type {
  DirEntry,
  Environment,
  FileInfo,
  FileVersion,
  Machine,
  ByteRange,
  RunCommandOptions,
  RunCommandResult,
} from "operon-agents-core";
import type { E2BCommandHandle, E2BCommandResult, E2BEntryInfo, E2BSandbox, SandboxRef } from "./e2b-api.ts";
import { readWindowViaShell, sliceRange } from "../shared/remote-file-ops.ts";
import { SandboxMachine } from "../shared/sandbox-machine.ts";

const DEFAULT_CWD = "/home/user";

export interface E2BMachineOptions {
  readonly cwd?: string;
  /** Runs commands and file ops as this user (E2B `user` option). */
  readonly runAs?: string;
  readonly shellPath?: string;
  /** Applied when `RunCommandOptions.timeoutMs` is absent. Unset = no deadline. */
  readonly defaultTimeoutMs?: number;
}

/**
 * A `Machine` backed directly by the E2B SDK.
 *
 * Direct on purpose: E2B natively provides exactly what tool execution needs — `timeoutMs`,
 * incremental `onStdout`/`onStderr`, and a real `commands.kill(pid)`. Routing through a
 * general-purpose sandbox abstraction loses all three (its non-PTY path passes no callbacks
 * and exposes no kill), which is what forces other adapters to fabricate a fake process
 * whose timeout and output cap silently do nothing.
 *
 * Known backend limits, surfaced rather than papered over:
 * - `files.list()` drops entries that are neither a file nor a directory (see `listDir`).
 * - `files.getInfo` does not say whether a symlink's size/mtime are its own or its target's, so
 *   symlinks still cost one `stat(1)` command (see `fileInfo`); everything else is one RPC.
 */
export class E2BMachine extends SandboxMachine {
  readonly name = "e2b";
  readonly osEnv: Environment;

  private readonly sandboxRef: SandboxRef;
  private readonly cwd: string;
  private readonly runAs: string | undefined;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(sandbox: SandboxRef | E2BSandbox, options: E2BMachineOptions = {}) {
    super();
    this.sandboxRef = typeof sandbox === "function" ? sandbox : () => sandbox;
    this.cwd = normalizeAbs(options.cwd ?? DEFAULT_CWD);
    this.runAs = options.runAs;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    const shellPath = options.shellPath ?? "/bin/bash";
    this.osEnv = {
      osKind: "Linux",
      osArch: "unknown",
      osVersion: "unknown",
      shellName: posix.basename(shellPath),
      shellPath,
    };
  }

  private get sandbox(): E2BSandbox {
    return this.sandboxRef();
  }

  // ---- identity & paths ----

  pathClass(): "posix" {
    return "posix";
  }
  normpath(path: string): string {
    return posix.normalize(path);
  }
  gethome(): string {
    return DEFAULT_CWD;
  }
  getcwd(): string {
    return this.cwd;
  }
  withCwd(cwd: string): Machine {
    const clone = new E2BMachine(this.sandboxRef, {
      cwd: this.resolve(cwd),
      ...(this.runAs !== undefined ? { runAs: this.runAs } : {}),
      shellPath: this.osEnv.shellPath,
      ...(this.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: this.defaultTimeoutMs } : {}),
    });
    return clone;
  }

  // ---- commands ----

  /**
   * The whole reason this adapter exists: every intent maps to a native E2B feature.
   * `background: true` is what yields a pid, and a pid is what makes cancellation real.
   */
  override async run(argv: readonly string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
    if (options.signal?.aborted) {
      return { stdout: "", stderr: "", exitCode: undefined, timedOut: false, truncated: false, terminated: true };
    }
    const sandbox = this.sandbox;
    const cap = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    let out = "";
    let err = "";
    let bytes = 0;
    let truncated = false;

    const collect = (stream: "stdout" | "stderr") => (data: string): void => {
      options.onOutput?.({ stream, data });
      if (truncated) return;
      const room = cap - bytes;
      if (data.length >= room) {
        const kept = data.slice(0, Math.max(0, room));
        if (stream === "stdout") out += kept;
        else err += kept;
        bytes = cap;
        truncated = true;
        return;
      }
      bytes += data.length;
      if (stream === "stdout") out += data;
      else err += data;
    };

    // Refuse stdin we cannot deliver instead of dropping it: a hook or a filter fed no input
    // would silently see EOF and "succeed" on empty data.
    if (options.stdin !== undefined && sandbox.commands.sendStdin === undefined) {
      throw new Error("E2BMachine: this SDK build exposes no commands.sendStdin, so run({ stdin }) cannot be honored.");
    }

    // Our own deadline, not the SDK's. Left unset, the SDK applies a 60-second deadline to every
    // command — a build, a test run, a background dev server all cut off at one minute — and
    // when it fires the stream just errors, with no kill and no `timedOut`. `0` disables it, and
    // the timer below enforces the caller's timeout with a real kill instead.
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const started = await sandbox.commands.run(shellJoin(argv), {
      background: true, // resolves immediately with a pid so cancellation has a target
      cwd: options.cwd !== undefined ? this.resolve(options.cwd) : this.cwd,
      ...(options.env !== undefined ? { envs: options.env } : {}),
      ...(this.runAs !== undefined ? { user: this.runAs } : {}),
      ...(options.stdin !== undefined ? { stdin: true } : {}),
      timeoutMs: 0,
      onStdout: collect("stdout"),
      onStderr: collect("stderr"),
    });

    const handle = started as E2BCommandHandle;
    if (options.stdin !== undefined && typeof handle.pid === "number") {
      await sandbox.commands.sendStdin!(handle.pid, options.stdin);
      // EOF. Without it a stdin reader — a hook piping its JSON through `jq`, a plain `cat` —
      // waits for more input until the command is killed.
      await sandbox.commands.closeStdin?.(handle.pid);
    }
    // No pid means the SDK ran it to completion synchronously — nothing to cancel.
    if (typeof handle.pid !== "number" || handle.wait === undefined) {
      const done = started as E2BCommandResult;
      return {
        stdout: out || done.stdout || "",
        stderr: err || done.stderr || "",
        exitCode: done.exitCode ?? undefined,
        timedOut: false,
        truncated,
        terminated: false,
      };
    }

    let timedOut = false;
    let terminated = false;
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
      (stopping ??= this.killPid(sandbox, handle).then((ok) => void (terminated = ok)));

    const onAbort = (): void => void stop();
    options.signal?.addEventListener("abort", onAbort);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      void stop();
    }, timeoutMs);

    try {
      const finished = await settledResult(handle, () => stopping !== undefined);
      // Cap reached but the command outlived it — stop it rather than let it keep producing.
      if (truncated && !terminated) await stop();
      // A kill makes wait() settle immediately, so without joining the in-flight stop here we
      // would read `terminated` before killPid resolved and under-report every termination.
      await stopping;
      return {
        stdout: out || finished.stdout || "",
        stderr: err || finished.stderr || "",
        // A killed command's exit status is not a real completion code.
        exitCode: timedOut || terminated ? undefined : finished.exitCode ?? undefined,
        timedOut,
        truncated,
        terminated,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Real termination, reported honestly: `false` means the command may still be running. */
  private async killPid(sandbox: E2BSandbox, handle: E2BCommandHandle): Promise<boolean> {
    try {
      if (handle.kill !== undefined) return await handle.kill();
      if (sandbox.commands.kill !== undefined) return await sandbox.commands.kill(handle.pid);
    } catch {
      /* fall through — treat as not terminated */
    }
    return false;
  }

  // No `spawn`: this transport hands back no OS process, so the base class's process SPI stays
  // unimplemented and `run` above — which every caller uses — is native instead. The adapter
  // this replaced faked a process handle whose `kill()` did nothing, and the Bash tool trusted
  // it, so a user's interrupt left the command running inside the sandbox.

  // ---- files & metadata ----

  /**
   * One `files.getInfo` RPC — no command, no shell. A symlink is the exception: the SDK marks one
   * with `symlinkTarget` but does not say whether the size and mtime it reports are the link's or
   * the target's, so the follow/no-follow distinction goes to `stat(1)` (SandboxMachine), which
   * states it exactly. An SDK build without `getInfo` takes that path for everything.
   */
  override async fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo> {
    const getInfo = this.sandbox.files.getInfo;
    if (getInfo === undefined) return await super.fileInfo(path, options);
    const target = this.resolve(path);
    let entry: E2BEntryInfo;
    try {
      entry = await getInfo.call(this.sandbox.files, target);
    } catch (error) {
      throw asErrnoError(error, target);
    }
    if (entry.symlinkTarget !== undefined) return await super.fileInfo(path, options);
    return {
      kind: entry.type === "dir" ? "dir" : entry.type === "file" ? "file" : "other",
      size: entry.size ?? 0,
      ...mtimeOf(entry),
    };
  }

  /**
   * The version a write produced, from one `getInfo` — the same source `fileInfo` reads, so the
   * two compare equal. Without it every E2B write left the read-state record versionless, and
   * the next Write had to download the file to compare contents. Symlinked targets report
   * nothing: their `fileInfo` comes from `stat(1)`, a different source.
   */
  protected override async versionAfterWrite(path: string): Promise<FileVersion | undefined> {
    const getInfo = this.sandbox.files.getInfo;
    if (getInfo === undefined) return undefined;
    try {
      const entry = await getInfo.call(this.sandbox.files, this.resolve(path));
      return entry.symlinkTarget === undefined ? mtimeOf(entry) : undefined;
    } catch {
      return undefined; // the write succeeded; this only costs the fast path
    }
  }

  /**
   * One `files.list()` round trip — the vendor listing already carries each entry's kind, so there
   * is no stat per entry. A symlink is reported as `"symlink"` (lstat semantics, per `DirEntry`)
   * from its `symlinkTarget`.
   *
   * Caveat worth knowing: the SDK drops entries that are neither a file nor a directory (a socket,
   * a FIFO, possibly a dangling symlink), so those are absent from the listing rather than
   * reported as `"other"`.
   */
  async listDir(path: string): Promise<readonly DirEntry[]> {
    const entries = await this.sandbox.files.list(this.resolve(path));
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.symlinkTarget !== undefined ? "symlink" : entry.type === "dir" ? "dir" : entry.type === "file" ? "file" : "other",
    }));
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const target = this.resolve(path);
    const makeDir = this.sandbox.files.makeDir;
    if (options?.parents === true) {
      if (makeDir === undefined) {
        const { exitCode } = await this.run(["mkdir", "-p", "--", target]);
        if (exitCode !== 0) throw codedError(`mkdir -p failed: ${target}`, "EIO");
        return;
      }
      // `makeDir` already creates the parents — one RPC instead of a `mkdir -p` command. When the
      // path existed, it must be a directory: `mkdir -p` over a file fails, and so does this.
      if (await makeDir.call(this.sandbox.files, target)) return;
      if ((await this.fileInfo(target).catch(() => undefined))?.kind === "dir") return;
      throw codedError(`EEXIST: path exists and is not a directory: ${target}`, "EEXIST");
    }
    // Plain mkdir must fail on an existing path; `files.makeDir` returns false instead of
    // throwing, so translate that into the EEXIST the contract promises.
    const created = (await makeDir?.call(this.sandbox.files, target)) ?? false;
    if (created) return;
    if (options?.existOk === true && (await this.fileInfo(target).catch(() => undefined))?.kind === "dir") return;
    throw codedError(`EEXIST: path already exists: ${target}`, "EEXIST");
  }

  async readBytes(path: string, range?: ByteRange): Promise<Buffer> {
    if (range !== undefined) {
      const window = await readWindowViaShell(this, this.resolve(path), range);
      if (window !== undefined) return window;
      // Fall through: no `tail`/`head`/`base64` in this image. Correct, just expensive — and
      // the caller is told nothing, because the contract only promises the bytes.
    }
    let payload: string | Uint8Array;
    try {
      payload = await this.sandbox.files.read(this.resolve(path), { format: "bytes" });
    } catch (error) {
      // Callers branch on ENOENT (an append to a file that does not exist yet); the SDK's
      // FileNotFoundError carries no code.
      throw asErrnoError(error, this.resolve(path));
    }
    const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
    return sliceRange(bytes, range);
  }

  protected async writeBytesRaw(path: string, data: Buffer): Promise<void> {
    await this.sandbox.files.write(this.resolve(path), toArrayBuffer(data));
  }

  /** Public URL for a port listening inside the sandbox (dev servers, previews). */
  async exposedPortUrl(port: number, scheme: "http" | "https" = "https"): Promise<string | undefined> {
    if (this.sandbox.getHost === undefined) return undefined;
    return `${scheme}://${await this.sandbox.getHost(port)}`;
  }

  protected resolve(path: string): string {
    return normalizeAbs(path.startsWith("/") ? path : posix.join(this.cwd, path));
  }
}

/**
 * How the command ended, as a RESULT. The SDK's `wait()` rejects for every nonzero exit with a
 * `CommandExitError` carrying the result — for `run`, whose callers branch on `exitCode` (a
 * `stat` that found nothing, a `grep` with no match), that is an ordinary outcome, not a failure.
 * A rejection without a result is a failure unless we were stopping the command: a kill ends the
 * event stream too, and that is the ending we asked for.
 */
async function settledResult(handle: E2BCommandHandle, stopRequested: () => boolean): Promise<E2BCommandResult> {
  try {
    return await handle.wait!();
  } catch (error) {
    const result = (error as { result?: E2BCommandResult } | null)?.result;
    if (result !== undefined && typeof result.exitCode === "number") return result;
    if (stopRequested()) return { exitCode: null };
    throw error;
  }
}

/**
 * Copy a Buffer's bytes into a standalone ArrayBuffer, which is what the E2B SDK accepts.
 *
 * The slice is not optional. Node pools small Buffers, so `data.buffer` is usually an 8 KiB
 * slab shared with unrelated allocations — handing it over whole would write that slab's
 * contents to the file instead of the caller's bytes.
 */
function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** `modifiedTime` as the contract's optional `mtimeMs` — absent, not 0, when there is none. */
function mtimeOf(entry: E2BEntryInfo): { mtimeMs?: number } {
  const ms = entry.modifiedTime?.getTime();
  return ms === undefined || !Number.isFinite(ms) || ms === 0 ? {} : { mtimeMs: ms };
}

/** The SDK's not-found error, given the ENOENT code every Machine caller branches on. */
function asErrnoError(error: unknown, path: string): unknown {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "FileNotFoundError" || name === "NotFoundError") {
    return codedError(`No such file or directory: ${path}`, "ENOENT");
  }
  return error;
}

function normalizeAbs(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/** E2B takes a command STRING; quote every argv element so no arg is re-split by the shell. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
