/**
 * Implementer-side base for Machine backends.
 *
 * A backend writes only the dumb primitives (the abstract SPI below); this
 * class derives the high-level operations from them:
 *
 * - `run`: spawn → cap both streams → escalating kill on timeout/abort.
 * - `realpath`: `readlink -f` via `run` on posix, normpath on win32. Hosts with
 *   a native resolver (fs.realpath, SFTP realpath) override for exactness.
 */
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { posix, win32 } from "node:path";
import {
  type RunCommandResult,
  type DecodeErrors,
  type DirEntry,
  type Environment,
  type ByteRange,
  type Machine,
  type RunCommandOptions,
  type FileInfo,
  type FileVersion,
  type WriteTextOptions,
  type WriteTextResult,
} from "./machine.ts";

/** Deadline for the `readlink -f` realpath fallback (see BaseMachine.realpath). */
const REALPATH_TIMEOUT_MS = 10_000;

/**
 * A live OS process, normalized. IMPLEMENTER-SIDE ONLY — this is what {@link BaseMachine.spawn}
 * hands back so ONE copy of `run`'s read/cap/decode/kill-escalate logic can serve backends
 * whose native process objects disagree on the details: node's `ChildProcess` kills by signal
 * name and reports exit on one event, while an ssh2 `ClientChannel` wants the signal without
 * its `SIG` prefix, splits exit across `exit`/`close`, and drops output emitted before a
 * consumer attaches. Each backend absorbs its own quirks here.
 *
 * No `pid`: nothing consumes one, and SSH could only ever have invented it.
 */
export interface SpawnedProcess {
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

/** Join with the TARGET machine's path flavour, not the host's — a local process may be
 *  driving a posix machine (SSH / sandbox) or vice versa. */
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

/**
 * Read a stream, stopping accumulation at `maxBytes`. Chunks are handed to `onData` as they
 * arrive (that is what makes `RunCommandOptions.onOutput` incremental on streaming backends), and
 * accumulation stops at the cap while the stream is still drained, so the writer never
 * blocks on a full pipe.
 */
async function readCapped(
  stream: Readable,
  maxBytes: number,
  onData?: (data: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  // Incremental delivery decodes through a StringDecoder: a multi-byte character split across
  // two chunks would otherwise reach the caller as mojibake. The accumulated `text` below is
  // immune (it concatenates buffers first), so only this path needs it.
  const decoder = onData === undefined ? undefined : new StringDecoder("utf8");
  try {
    for await (const chunk of stream) {
      const buf: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
      if (onData !== undefined && decoder !== undefined && !truncated) {
        const decoded = decoder.write(buf);
        if (decoded.length > 0) onData(decoded);
      }
      if (truncated) continue;
      if (total + buf.length > maxBytes) {
        const room = maxBytes - total;
        if (room > 0) chunks.push(buf.subarray(0, room));
        total = maxBytes;
        truncated = true;
        continue;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } catch {
    // The stream died mid-read — most often because `run` destroyed it deliberately to stop a
    // process that survived being killed. Whatever arrived before that is still the honest
    // output; the caller learns how the command ended from exitCode/timedOut/terminated.
  }
  if (decoder !== undefined && onData !== undefined && !truncated) {
    // Flush whatever bytes were left mid-character; replacement chars only if truly malformed.
    const tail = decoder.end();
    if (tail.length > 0) onData(tail);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export abstract class BaseMachine implements Machine {
  abstract readonly name: string;
  abstract readonly osEnv: Environment;

  // ---- SPI: identity & path semantics ----
  abstract pathClass(): "posix" | "win32";
  abstract normpath(path: string): string;
  abstract gethome(): string;
  abstract getcwd(): string;
  abstract withCwd(cwd: string): Machine;
  /** Extra workspace roots (see Machine.additionalDirs). Default: cwd only. */
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
  /** Raw unconditional whole-file write — the single write primitive everything else derives from. */
  protected abstract writeBytesRaw(path: string, data: Buffer): Promise<void>;

  /** Decode with the shared contract: strict UTF-8 throws on invalid bytes (binary detection). */
  protected decodeText(data: Buffer, options?: { encoding?: BufferEncoding; errors?: DecodeErrors }): string {
    const encoding = options?.encoding ?? "utf8";
    const errors = options?.errors ?? "strict";
    if ((encoding === "utf8" || encoding === "utf-8") && errors === "strict") {
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    }
    return data.toString(encoding);
  }

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
  async run(argv: readonly string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
    const { timeoutMs, maxOutputBytes = Number.POSITIVE_INFINITY, signal, onOutput } = options;
    if (signal?.aborted) {
      return { stdout: "", stderr: "", exitCode: undefined, timedOut: false, truncated: false, terminated: true };
    }
    if (this.spawn === undefined) {
      throw new Error(`${this.name}: a backend with no process SPI must override run().`);
    }
    const proc = await this.spawn(this.withCwdArgv(argv, options.cwd), options.env);

    // A child that exits without draining stdin makes the write fail with EPIPE, and that
    // failure arrives as an 'error' event rather than a throw — the try/catch below cannot see
    // it. With no listener node treats it as an uncaught exception and takes the whole process
    // down, which is how a hook script that ignores its stdin killed a CI run. The command's
    // exit code and output are the real result, so a stdin that nobody read is not our error.
    proc.stdin.on("error", () => {});
    if (options.stdin !== undefined) proc.stdin.write(options.stdin);
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }

    let timedOut = false;
    let terminated = false;
    let killing: Promise<void> | undefined;
    // Resolves only when the kill escalation ran out of options — the process is still alive,
    // so neither its pipes nor its exit status will ever arrive on their own. Without this
    // escape hatch a timeout or an abort would hang forever on a process that ignores signals.
    let abandonHung!: () => void;
    const abandoned = new Promise<void>((resolve) => {
      abandonHung = resolve;
    });
    const stop = (): Promise<void> =>
      (killing ??= this.escalatingKill(proc).then((ok) => {
        terminated = ok;
        if (!ok) {
          proc.stdout.destroy(); // ends the reads below (readCapped treats this as EOF)
          proc.stderr.destroy();
          abandonHung();
        }
      }));

    const onAbort = (): void => void stop();
    signal?.addEventListener("abort", onAbort);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      void stop();
    }, timeoutMs);

    try {
      const [out, err, code] = await Promise.all([
        readCapped(proc.stdout, maxOutputBytes, onOutput && ((data) => onOutput({ stream: "stdout", data }))),
        readCapped(proc.stderr, maxOutputBytes, onOutput && ((data) => onOutput({ stream: "stderr", data }))),
        Promise.race([proc.wait().catch(() => undefined), abandoned.then(() => undefined)]),
      ]);
      // A cap hit means we stop reading, but the process may still be writing — stop it so
      // it cannot keep producing output nobody will read.
      if ((out.truncated || err.truncated) && proc.exitCode === null) await stop();
      // A kill makes wait() settle immediately, so without joining the in-flight kill here we
      // would read `terminated` before it resolved and under-report every termination.
      await killing;
      return {
        stdout: out.text,
        stderr: err.text,
        exitCode: timedOut ? undefined : code,
        timedOut,
        truncated: out.truncated || err.truncated,
        terminated,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
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

  /**
   * The version the last write produced, for backends that can answer without a round
   * trip. Default: nothing — a remote backend would have to stat for it, and paying that
   * on every write to save a content comparison on the rare write-after-write is the
   * wrong trade (see WriteTextResult.version).
   */
  protected async versionAfterWrite(_path: string): Promise<FileVersion | undefined> {
    return undefined;
  }

  async writeText(path: string, data: string, options: WriteTextOptions = {}): Promise<WriteTextResult> {
    const payload = options.lineEndings === "CRLF" ? data.replaceAll("\n", "\r\n") : data;
    const buf = Buffer.from(payload, options.encoding ?? "utf8");
    await this.writeBytesRaw(path, buf);
    const version = await this.versionAfterWrite(path);
    return { bytesWritten: buf.byteLength, ...(version !== undefined ? { version } : {}) };
  }

  /** Exact bytes through the same primitive `writeText` uses — no encoding, no CRLF rewrite. */
  async writeBytes(path: string, data: Buffer): Promise<void> {
    await this.writeBytesRaw(path, data);
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
