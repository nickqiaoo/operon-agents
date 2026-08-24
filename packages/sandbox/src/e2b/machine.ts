import { posix } from "node:path";
import type {
  DirEntry,
  Environment,
  Machine,
  ByteRange,
  RunCommandOptions,
  RunCommandResult,
} from "operon-agents-core";
import type { E2BCommandHandle, E2BCommandResult, E2BSandbox, SandboxRef } from "./e2b-api.ts";
import { readWindowViaShell, sliceRange } from "../shared/remote-file-ops.ts";
import { SandboxMachine } from "../shared/sandbox-machine.ts";

const DEFAULT_CWD = "/home/user";

export interface E2BMachineOptions {
  readonly cwd?: string;
  /** Runs commands and file ops as this user (E2B `user` option). */
  readonly runAs?: string;
  readonly shellPath?: string;
  /** Applied when `RunCommandOptions.timeoutMs` is absent. */
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
 * - `files.list()` reports only `file`/`dir` — a symlink arrives as its target's kind or
 *   with `type` absent, so `DirEntry.kind` cannot be true lstat semantics here (see `listDir`).
 * - There is no stat API, so `fileInfo` costs one `stat(1)` command.
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
    // One sandbox, one file namespace — clones must share write locks.
    clone.pathLocks = this.pathLocks;
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

    const started = await sandbox.commands.run(shellJoin(argv), {
      background: true, // resolves immediately with a pid so cancellation has a target
      cwd: options.cwd !== undefined ? this.resolve(options.cwd) : this.cwd,
      ...(options.env !== undefined ? { envs: options.env } : {}),
      ...(this.runAs !== undefined ? { user: this.runAs } : {}),
      ...(options.stdin !== undefined ? { stdin: true } : {}),
      ...(pickTimeout(options.timeoutMs, this.defaultTimeoutMs) !== undefined
        ? { timeoutMs: pickTimeout(options.timeoutMs, this.defaultTimeoutMs) }
        : {}),
      onStdout: collect("stdout"),
      onStderr: collect("stderr"),
    });

    const handle = started as E2BCommandHandle;
    if (options.stdin !== undefined && typeof handle.pid === "number") {
      await sandbox.commands.sendStdin!(handle.pid, options.stdin);
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
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      void stop();
    }, options.timeoutMs);

    try {
      const finished = await handle.wait();
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

  // `fileInfo` comes from SandboxMachine: E2B exposes no stat API, so it costs one
  // `stat(1)` — the same trade Cloudflare makes, and the reason `listDir` below avoids
  // per-entry metadata.

  /**
   * One `files.list()` round trip — the vendor listing already carries `type`, so there is no
   * stat per entry.
   *
   * Caveat worth knowing: E2B's `FileType` has only `file` and `dir`. A symlink comes back as
   * whatever it resolves to, or with `type` absent (mapped to `"other"`). So on this backend
   * `DirEntry.kind` is NOT strict lstat semantics — callers that must distinguish a symlink
   * have to stat explicitly. Reported as-is rather than guessed.
   */
  async listDir(path: string): Promise<readonly DirEntry[]> {
    const entries = await this.sandbox.files.list(this.resolve(path));
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.type === "dir" ? "dir" : entry.type === "file" ? "file" : "other",
    }));
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const target = this.resolve(path);
    if (options?.parents === true) {
      const { exitCode } = await this.run(["mkdir", "-p", "--", target]);
      if (exitCode !== 0) throw codedError(`mkdir -p failed: ${target}`, "EIO");
      return;
    }
    // Plain mkdir must fail on an existing path; `files.makeDir` returns false instead of
    // throwing, so translate that into the EEXIST the contract promises.
    const created = (await this.sandbox.files.makeDir?.(target)) ?? false;
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
    const payload = await this.sandbox.files.read(this.resolve(path), { format: "bytes" });
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

function pickTimeout(explicit: number | undefined, fallback: number | undefined): number | undefined {
  return explicit ?? fallback;
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
