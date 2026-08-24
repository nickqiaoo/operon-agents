import { posix } from "node:path";
import type {
  DirEntry,
  Environment,
  FileKind,
  Machine,
  ByteRange,
  RunCommandOptions,
  RunCommandResult,
} from "operon-agents-core";
import type {
  CloudflareClientRef,
  CloudflareLogEvent,
  CloudflareSandboxClient,
} from "./cf-api.ts";
import { readWindowViaShell, sliceRange } from "../shared/remote-file-ops.ts";
import { SandboxMachine } from "../shared/sandbox-machine.ts";

const DEFAULT_CWD = "/workspace";

export interface CloudflareMachineOptions {
  readonly cwd?: string;
  /** Cloudflare scopes every call to a session id; one machine, one session. */
  readonly sessionId?: string;
  readonly shellPath?: string;
  /** Applied when `RunCommandOptions.timeoutMs` is absent. */
  readonly defaultTimeoutMs?: number;
}

/**
 * A `Machine` backed directly by `@cloudflare/sandbox`'s route-transport client.
 *
 * Direct rather than through a general sandbox abstraction for the same reason as the E2B
 * adapter: the vendor natively provides a per-command timeout, incremental output and a real
 * kill, and a lowest-common-denominator layer in between can express none of the three.
 *
 * Backend limits, surfaced rather than papered over:
 * - No public port URLs. The SDK implements tunnels on the RPC transport only, so
 *   `exposedPortUrl` truthfully returns `undefined` here instead of inventing a host.
 * - `listFiles` reports directory-or-not, with no symlink kind, so `DirEntry.kind` is not
 *   strict lstat semantics (a symlink reads as its target's kind — see `listDir`).
 * - No stat API, so `fileInfo` costs one `stat(1)` command.
 * - Bytes move as base64: the transport takes a string, and `writeFileStream` is RPC-only.
 */
export class CloudflareMachine extends SandboxMachine {
  readonly name = "cloudflare";
  readonly osEnv: Environment;

  private readonly clientRef: CloudflareClientRef;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(client: CloudflareClientRef | CloudflareSandboxClient, options: CloudflareMachineOptions = {}) {
    super();
    this.clientRef = typeof client === "function" ? client : () => client;
    this.cwd = normalizeAbs(options.cwd ?? DEFAULT_CWD);
    this.sessionId = options.sessionId ?? "default";
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

  private get client(): CloudflareSandboxClient {
    return this.clientRef();
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
    const clone = new CloudflareMachine(this.clientRef, {
      cwd: this.resolve(cwd),
      sessionId: this.sessionId,
      shellPath: this.osEnv.shellPath,
      ...(this.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: this.defaultTimeoutMs } : {}),
    });
    // One sandbox, one file namespace — clones must share write locks.
    clone.pathLocks = this.pathLocks;
    return clone;
  }

  // ---- commands ----

  /**
   * Two paths, because the vendor splits the capability in two:
   *
   * - `commands.execute` is ONE round trip with a native timeout, but hands back no handle,
   *   so nothing can cancel it mid-flight.
   * - `processes.startProcess` returns a `processId` immediately — the handle that makes
   *   `killProcess` (and therefore abort, and a cap that actually stops the command) real —
   *   with output arriving as an SSE log stream.
   *
   * So a plain "run this and give me the output" takes the cheap path, and anything that
   * asked for cancellation, incremental output or an output cap takes the process path. The
   * caller states intent once; which mechanism delivers it stays in here.
   */
  override async run(argv: readonly string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
    if (options.signal?.aborted) {
      return { stdout: "", stderr: "", exitCode: undefined, timedOut: false, truncated: false, terminated: true };
    }
    // The route transport has no stdin channel at all — neither `commands.execute` nor
    // `processes.startProcess` accepts one. Refuse rather than drop it: a command fed no
    // input would see EOF and "succeed" on empty data.
    if (options.stdin !== undefined) {
      throw new Error("CloudflareMachine: this transport has no stdin channel, so run({ stdin }) cannot be honored.");
    }
    const needsHandle =
      options.onOutput !== undefined || options.signal !== undefined || options.maxOutputBytes !== undefined;
    return needsHandle ? await this.runViaProcess(argv, options) : await this.runViaExecute(argv, options);
  }

  /** Cheap path: one request, native timeout, no cancellation. */
  private async runViaExecute(argv: readonly string[], options: RunCommandOptions): Promise<RunCommandResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const result = await this.client.commands.execute(shellJoin(argv), this.sessionId, {
      cwd: options.cwd !== undefined ? this.resolve(options.cwd) : this.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    options.onOutput?.({ stream: "stdout", data: result.stdout });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: false,
      truncated: false,
      terminated: false,
    };
  }

  /** Cancellable path: a processId to kill, plus an SSE log stream for incremental output. */
  private async runViaProcess(argv: readonly string[], options: RunCommandOptions): Promise<RunCommandResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const started = await this.client.processes.startProcess(shellJoin(argv), this.sessionId, {
      cwd: options.cwd !== undefined ? this.resolve(options.cwd) : this.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    const processId = started.processId;

    const cap = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    let out = "";
    let err = "";
    let bytes = 0;
    let truncated = false;
    let exitCode: number | undefined;
    let timedOut = false;
    let terminated = false;
    let stopping: Promise<void> | undefined;

    const stop = (): Promise<void> => (stopping ??= this.kill(processId).then((ok) => void (terminated = ok)));

    const collect = (stream: "stdout" | "stderr", data: string): void => {
      options.onOutput?.({ stream, data });
      if (truncated) return;
      const room = cap - bytes;
      if (data.length >= room) {
        const kept = data.slice(0, Math.max(0, room));
        if (stream === "stdout") out += kept;
        else err += kept;
        bytes = cap;
        truncated = true;
        // Cap reached; stop the command rather than let it keep producing output nobody reads.
        void stop();
        return;
      }
      bytes += data.length;
      if (stream === "stdout") out += data;
      else err += data;
    };

    const onAbort = (): void => void stop();
    options.signal?.addEventListener("abort", onAbort);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      void stop();
    }, timeoutMs);

    try {
      const stream = await this.client.processes.streamProcessLogs(processId);
      for await (const event of readLogEvents(stream)) {
        if (event.type === "stdout" || event.type === "stderr") collect(event.type, event.data ?? "");
        else if (event.type === "exit") exitCode = event.exitCode;
      }
      // A kill makes the log stream end at once, so without joining the in-flight stop here
      // we would read `terminated` before it resolved and under-report every termination.
      await stopping;
      // The stream can end without an `exit` event (killed, or the transport dropped it);
      // ask the process registry rather than assume success.
      if (exitCode === undefined && !terminated && !timedOut) exitCode = await this.exitCodeOf(processId);
      return {
        stdout: out,
        stderr: err,
        // A killed or timed-out command has no meaningful completion status.
        exitCode: timedOut || terminated ? undefined : exitCode,
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
  private async kill(processId: string): Promise<boolean> {
    try {
      await this.client.processes.killProcess(processId);
      return true;
    } catch {
      return false;
    }
  }

  private async exitCodeOf(processId: string): Promise<number | undefined> {
    try {
      return (await this.client.processes.getProcess(processId)).process.exitCode;
    } catch {
      return undefined;
    }
  }

  // No `spawn`: this transport hands back no OS process, so the base class's process SPI stays
  // unimplemented and `run` above — which every caller uses — is native instead.

  // ---- files & metadata ----

  // `fileInfo` comes from SandboxMachine: no stat API here either, so it costs one `stat(1)`.

  /**
   * One `listFiles` round trip — the vendor listing already says directory-or-not, so no
   * stat per entry.
   *
   * Caveat: it carries no symlink kind, so a symlink reads as its target's kind. As on E2B,
   * `DirEntry.kind` here is not strict lstat semantics; callers that must distinguish a
   * symlink stat explicitly. Mapped as reported rather than guessed at.
   */
  async listDir(path: string): Promise<readonly DirEntry[]> {
    const { files } = await this.client.files.listFiles(this.resolve(path), this.sessionId);
    return files.map((entry) => ({
      name: entry.name,
      kind: entryKind(entry.isDirectory ?? (entry.type === "directory" || entry.type === "dir")),
    }));
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const target = this.resolve(path);
    if (options?.parents === true) {
      await this.client.files.mkdir(target, this.sessionId, { recursive: true });
      return;
    }
    // Plain mkdir must fail on an existing path. The vendor call is not documented to throw
    // EEXIST, so check first and translate — the contract promises the POSIX behaviour.
    const existing = await this.fileInfo(target).catch(() => undefined);
    if (existing !== undefined) {
      if (options?.existOk === true && existing.kind === "dir") return;
      throw codedError(`EEXIST: path already exists: ${target}`, "EEXIST");
    }
    await this.client.files.mkdir(target, this.sessionId);
  }

  async readBytes(path: string, range?: ByteRange): Promise<Buffer> {
    if (range !== undefined) {
      const window = await readWindowViaShell(this, this.resolve(path), range);
      if (window !== undefined) return window;
      // Fall through: no `tail`/`head`/`base64` in this image. Correct, just expensive.
    }
    const { content } = await this.client.files.readFile(this.resolve(path), this.sessionId, { encoding: "base64" });
    return sliceRange(Buffer.from(content, "base64"), range);
  }

  protected async writeBytesRaw(path: string, data: Buffer): Promise<void> {
    // base64 is the only binary-safe route on this transport (writeFileStream is RPC-only).
    await this.client.files.writeFile(this.resolve(path), data.toString("base64"), this.sessionId, {
      encoding: "base64",
    });
  }

  /**
   * Always `undefined` on this transport: the SDK implements tunnels over RPC only, and the
   * route transport's `tunnels` accessor throws. Saying so plainly beats inventing a URL that
   * would not resolve.
   */
  async exposedPortUrl(): Promise<string | undefined> {
    return undefined;
  }

  protected resolve(path: string): string {
    return normalizeAbs(path.startsWith("/") ? path : posix.join(this.cwd, path));
  }
}

/** Decode an SSE byte stream into the `LogEvent`s the process log endpoint emits. */
async function* readLogEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<CloudflareLogEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a partial tail stays buffered.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = parseSseFrame(frame);
        if (event !== undefined) yield event;
      }
    }
    const last = parseSseFrame(buffer);
    if (last !== undefined) yield last;
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): CloudflareLogEvent | undefined {
  const payload = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (payload.length === 0) return undefined;
  try {
    const parsed = JSON.parse(payload) as CloudflareLogEvent;
    return typeof parsed.type === "string" ? parsed : undefined;
  } catch {
    // A malformed frame is dropped rather than failing the whole run — the command's own
    // output matters more than one unreadable log record.
    return undefined;
  }
}

function entryKind(isDir: boolean): FileKind {
  return isDir ? "dir" : "file";
}

function normalizeAbs(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/** Cloudflare takes a command STRING; quote every argv element so nothing is re-split. */
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
