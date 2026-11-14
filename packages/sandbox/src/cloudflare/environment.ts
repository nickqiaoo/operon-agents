import { commandLine, runViaHandle, wrapForTaskLog, codedError as processError } from 'operon-agents-core';
import type { Command, CommandHandle, CommandStartOptions, CommandConnectOptions, EnvironmentCommands, ProcessInfo } from 'operon-agents-core';
import { posix } from "node:path";
import type {
  DirEntry,
  OsInfo,
  FileKind,
  Environment,
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
import { SandboxEnvironment } from "../shared/sandbox-environment.ts";

const DEFAULT_CWD = "/workspace";

export interface CloudflareEnvironmentOptions {
  readonly cwd?: string;
  /** Cloudflare scopes every call to a session id; one environment, one session. */
  readonly sessionId?: string;
  readonly shellPath?: string;
  /** Applied when `RunCommandOptions.timeoutMs` is absent. */
  readonly defaultTimeoutMs?: number;
}

/**
 * An `Environment` backed directly by `@cloudflare/sandbox`'s route-transport client.
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
export class CloudflareEnvironment extends SandboxEnvironment {
  readonly name = "cloudflare";
  readonly osInfo: OsInfo;

  private readonly clientRef: CloudflareClientRef;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(client: CloudflareClientRef | CloudflareSandboxClient, options: CloudflareEnvironmentOptions = {}) {
    super();
    this.clientRef = typeof client === "function" ? client : () => client;
    this.cwd = normalizeAbs(options.cwd ?? DEFAULT_CWD);
    this.sessionId = options.sessionId ?? "default";
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    const shellPath = options.shellPath ?? "/bin/bash";
    this.osInfo = {
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
  withCwd(cwd: string): Environment {
    const clone = new CloudflareEnvironment(this.clientRef, {
      cwd: this.resolve(cwd),
      sessionId: this.sessionId,
      shellPath: this.osInfo.shellPath,
      ...(this.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: this.defaultTimeoutMs } : {}),
    });
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
  private live = new Map<number, { id: string; info: ProcessInfo }>();
  private nextPid = -1;
  override readonly commands: EnvironmentCommands = {
    run: (command, options = {}) => {
      if (options.stdin !== undefined) return Promise.reject(new Error('CloudflareEnvironment: this transport has no stdin channel'));
      if (!options.signal && !options.onOutput && options.maxOutputBytes === undefined) return this.runViaExecute(typeof command === 'string' ? [this.osInfo.shellPath, '-c', command] : command, options);
      return runViaHandle((cmd, opts) => this.startCommand(cmd, opts), command, { ...options, timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs });
    },
    start: (cmd, opts) => this.startCommand(cmd, opts ?? {}),
    list: async () => [...this.live.values()].map(entry => entry.info),
    connect: async (pid, opts) => {
      const entry = this.live.get(pid); if (!entry) throw processError(`No such process: ${pid}`, 'ESRCH');
      return this.connectProcess(pid, entry.id, opts ?? {});
    },
    kill: async pid => { const entry = this.live.get(pid); return entry ? this.kill(entry.id) : false; },
    sendStdin: async () => { throw new Error('CloudflareEnvironment: stdin unavailable'); },
    closeStdin: async () => { throw new Error('CloudflareEnvironment: stdin unavailable'); },
  };
  protected override async startCommand(command: Command, options: CommandStartOptions): Promise<CommandHandle> {
    if (options.stdin) throw new Error('CloudflareEnvironment: this transport has no stdin channel');
    if (options.outputFile) {
      await this.files.write(options.outputFile, '');
      await this.files.remove(`${options.outputFile}.exit`);
      if (options.stderrFile) await this.files.write(options.stderrFile, '');
      command = wrapForTaskLog(commandLine(command), options.outputFile, options.stderrFile, true);
    }
    const started = await this.client.processes.startProcess(commandLine(command), this.sessionId, { cwd: options.cwd === undefined ? this.cwd : this.resolve(options.cwd), env: options.env });
    const pid = started.pid ?? this.nextPid--;
    this.live.set(pid, { id: started.processId, info: { pid, cmd: commandLine(command), args: [], envs: options.env ?? {}, cwd: options.cwd ?? this.cwd } });
    return this.connectProcess(pid, started.processId, options);
  }
  private async connectProcess(pid: number, id: string, options: CommandConnectOptions): Promise<CommandHandle> {
    let stdout = '', stderr = '', exitCode: number | undefined;
    let disconnected = false, stopped = false;
    const controller = new AbortController();
    const stream = await this.client.processes.streamProcessLogs(id);
    const done = (async () => {
      try {
        for await (const event of readLogEvents(stream, controller.signal)) {
          if (event.type === 'exit') exitCode = event.exitCode;
          else if (!disconnected && (event.type === 'stdout' || event.type === 'stderr')) {
            const data = event.data ?? '';
            if (event.type === 'stdout') { if (options.retainOutput !== false) stdout += data; options.onStdout?.(data); }
            else { if (options.retainOutput !== false) stderr += data; options.onStderr?.(data); }
          } else if (event.type === 'error' && !stopped) throw new Error(event.data ?? 'Cloudflare command stream failed');
        }
        if (exitCode === undefined && !stopped && !disconnected) exitCode = await this.exitCodeOf(id);
        return { stdout, stderr, exitCode: stopped ? undefined : exitCode };
      } finally { if (!disconnected) this.live.delete(pid); }
    })();
    done.catch(() => {});
    return {
      pid, get stdout() { return stdout; }, get stderr() { return stderr; }, get exitCode() { return exitCode; },
      wait: () => done,
      kill: async () => { stopped = true; return this.kill(id); },
      disconnect: async () => { disconnected = true; controller.abort(); await done; },
      sendStdin: async () => { throw new Error('CloudflareEnvironment: stdin unavailable'); },
      closeStdin: async () => { throw new Error('CloudflareEnvironment: stdin unavailable'); },
    };
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

  // `fileInfo` comes from SandboxEnvironment: no stat API here either, so it costs one `stat(1)`.

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

  async writeBytes(path: string, data: Buffer): Promise<void> {
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
async function* readLogEvents(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<CloudflareLogEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel);
  if (signal?.aborted) cancel();
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
    signal?.removeEventListener('abort', cancel);
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
