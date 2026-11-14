import type { EntryInfo, EnvironmentPty, PtyHandle, EnvironmentFiles, FileData, WriteEntry, FilesystemEvent, WatchOptions, WatchHandle } from 'operon-agents-core';
import { commandLine, runViaHandle, EnvironmentFilesAdapter, toBuffer, wrapForTaskLog, shellQuote as quoteArgument } from 'operon-agents-core';
import type { Command, CommandStartOptions, CommandHandle, EnvironmentCommands, EnvironmentSandbox } from 'operon-agents-core';
import { posix } from "node:path";
import type {
  DirEntry,
  OsInfo,
  FileInfo,
  Environment,
  ByteRange,
  RunCommandOptions,
  RunCommandResult,
} from "operon-agents-core";
import type { E2BCommandHandle, E2BCommandResult, E2BEntryInfo, E2BSandbox, SandboxRef } from "./e2b-api.ts";
import { readWindowViaShell, sliceRange } from "../shared/remote-file-ops.ts";
import { SandboxEnvironment } from "../shared/sandbox-environment.ts";

const DEFAULT_CWD = "/home/user";

export interface E2BEnvironmentOptions {
  readonly cwd?: string;
  /** Runs commands and file ops as this user (E2B `user` option). */
  readonly runAs?: string;
  readonly shellPath?: string;
  /** Applied when `RunCommandOptions.timeoutMs` is absent. Unset = no deadline. */
  readonly defaultTimeoutMs?: number;
}

/**
 * An `Environment` backed directly by the E2B SDK.
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
export class E2BEnvironment extends SandboxEnvironment {
  readonly name = "e2b";
  readonly osInfo: OsInfo;

  private readonly sdkRef: SandboxRef;
  private readonly cwd: string;
  private readonly runAs: string | undefined;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(sandbox: SandboxRef | E2BSandbox, options: E2BEnvironmentOptions = {}) {
    super();
    this.files = new E2BFiles(this, () => this.sdk);
    this.sdkRef = typeof sandbox === "function" ? sandbox : () => sandbox;
    this.cwd = normalizeAbs(options.cwd ?? DEFAULT_CWD);
    this.runAs = options.runAs;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    if (this.sdk.pty) this.pty = {
      create: async options => this.wrapPty(await this.sdk.pty!.create({ ...options, cwd: options.cwd ?? this.cwd, envs: options.env, user: this.runAs, timeoutMs: 0 })),
      connect: async (pid, options) => this.wrapPty(await this.sdk.pty!.connect(pid, { ...options, timeoutMs: 0 })),
      sendInput: async (pid, data) => this.sdk.pty!.sendInput(pid, typeof data === 'string' ? Buffer.from(data) : data),
      resize: async (pid, size) => this.sdk.pty!.resize(pid, size),
      kill: async pid => this.sdk.pty!.kill(pid),
    };
    const shellPath = options.shellPath ?? "/bin/bash";
    this.osInfo = {
      osKind: "Linux",
      osArch: "unknown",
      osVersion: "unknown",
      shellName: posix.basename(shellPath),
      shellPath,
    };
  }

  private get sdk(): E2BSandbox {
    return this.sdkRef();
  }

  override readonly files: EnvironmentFiles;
  override readonly pty: EnvironmentPty | undefined = undefined;

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
    const clone = new E2BEnvironment(this.sdkRef, {
      cwd: this.resolve(cwd),
      ...(this.runAs !== undefined ? { runAs: this.runAs } : {}),
      shellPath: this.osInfo.shellPath,
      ...(this.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: this.defaultTimeoutMs } : {}),
    });
    return clone;
  }

  // ---- commands ----

  /**
   * The whole reason this adapter exists: every intent maps to a native E2B feature.
   * `background: true` is what yields a pid, and a pid is what makes cancellation real.
   */
  override readonly commands: EnvironmentCommands = {
    run: (command, options) => runViaHandle((cmd, opts) => this.startCommand(cmd, opts), command, { ...options, timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs }),
    start: (command, options) => this.startCommand(command, options ?? {}),
    list: async () => { if (!this.sdk.commands.list) throw new Error('E2B commands.list unavailable'); return this.sdk.commands.list(); },
    connect: async (pid, options) => {
      if (!this.sdk.commands.connect) throw new Error('E2B commands.connect unavailable');
      try { return this.wrapHandle(await this.sdk.commands.connect(pid, { ...options, timeoutMs: 0 })); }
      catch (error) {
        if ((error as Error).name === 'NotFoundError') throw codedError(`No such process: ${pid}`, 'ESRCH');
        throw error;
      }
    },
    kill: async pid => this.sdk.commands.kill?.(pid) ?? false,
    sendStdin: async (pid, data) => {
      if (!this.sdk.commands.sendStdin) throw new Error('E2B stdin unavailable');
      await this.sdk.commands.sendStdin(pid, data);
    },
    closeStdin: async pid => {
      if (!this.sdk.commands.closeStdin) throw new Error('E2B closeStdin unavailable');
      await this.sdk.commands.closeStdin(pid);
    },
  };
  protected override async startCommand(command: Command, options: CommandStartOptions): Promise<CommandHandle> {
    if (options.outputFile) {
      await this.files.write(options.outputFile, '');
      await this.files.remove(`${options.outputFile}.exit`);
      if (options.stderrFile) await this.files.write(options.stderrFile, '');
      const durable = wrapForTaskLog(commandLine(command), options.outputFile, options.stderrFile, true);
      const handle = await this.startCommand(durable, { ...options, outputFile: undefined, stderrFile: undefined, onStderr: undefined });
      return handle;
    }
    if (options.stdin && !this.sdk.commands.sendStdin) throw new Error('E2B stdin unavailable');
    const started = await this.sdk.commands.run(commandLine(command), {
      background: true, timeoutMs: 0, cwd: options.cwd === undefined ? this.cwd : this.resolve(options.cwd),
      envs: options.env, user: this.runAs, stdin: options.stdin,
      retainOutput: options.retainOutput, onStdout: options.onStdout, onStderr: options.onStderr,
    });
    return this.wrapHandle(started as E2BCommandHandle);
  }
  private wrapPty(native: E2BCommandHandle): PtyHandle {
    const handle = this.wrapHandle(native);
    return { pid: handle.pid, wait: async () => ({ exitCode: (await handle.wait()).exitCode }),
      sendInput: data => this.sdk.pty!.sendInput(handle.pid, typeof data === 'string' ? Buffer.from(data) : data),
      resize: size => this.sdk.pty!.resize(handle.pid, size),
      kill: () => this.sdk.pty!.kill(handle.pid), disconnect: () => handle.disconnect() };
  }
  private wrapHandle(handle: E2BCommandHandle): CommandHandle {
    const sdk = this.sdk;
    let stopping = false;
    return {
      pid: handle.pid,
      get stdout() { return handle.stdout ?? ''; }, get stderr() { return handle.stderr ?? ''; },
      get exitCode() { return handle.exitCode ?? undefined; },
      wait: async () => {
        const result = handle.wait ? await settledResult(handle, () => stopping) : handle;
        return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: stopping ? undefined : result.exitCode ?? undefined, error: result.error };
      },
      kill: async () => {
        stopping = true;
        try { return handle.kill ? await handle.kill() : await sdk.commands.kill?.(handle.pid) ?? false; }
        catch { await handle.disconnect?.(); return false; }
      },
      disconnect: async () => { await handle.disconnect?.(); },
      sendStdin: async data => {
        if (!sdk.commands.sendStdin) throw new Error('E2B stdin unavailable');
        await sdk.commands.sendStdin(handle.pid, data);
      },
      closeStdin: async () => {
        if (!sdk.commands.closeStdin) throw new Error('E2B closeStdin unavailable');
        await sdk.commands.closeStdin(handle.pid);
      },
    };
  }
  override readonly sandbox: EnvironmentSandbox = (() => { const owner = this; return {
    get id() { return owner.sdk.sandboxId; },
    getHost: async port => this.sdk.getHost?.(port),
    getUrl: async port => this.exposedPortUrl(port),
    isRunning: async () => this.sdk.isRunning ? this.sdk.isRunning() : true,
    getInfo: async () => { const info = await this.sdk.getInfo?.(); return { ...info, id: this.sdk.sandboxId, state: info?.state ?? 'running' }; },
    getMetrics: async () => (await this.sdk.getMetrics?.())?.at(-1),
    setTimeout: async ms => { if (!this.sdk.setTimeout) return false; await this.sdk.setTimeout(ms); return true; },
    uploadUrl: async path => this.sdk.uploadUrl?.(path),
    downloadUrl: async path => this.sdk.downloadUrl?.(path),
  }; })();

  // ---- files & metadata ----

  /**
   * One `files.getInfo` RPC — no command, no shell. A symlink is the exception: the SDK marks one
   * with `symlinkTarget` but does not say whether the size and mtime it reports are the link's or
   * the target's, so the follow/no-follow distinction goes to `stat(1)` (SandboxEnvironment), which
   * states it exactly. An SDK build without `getInfo` takes that path for everything.
   */
  override async fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo> {
    const getInfo = this.sdk.files.getInfo;
    if (getInfo === undefined) return await super.fileInfo(path, options);
    const target = this.resolve(path);
    let entry: E2BEntryInfo;
    try {
      entry = await getInfo.call(this.sdk.files, target);
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
   * One `files.list()` round trip — the vendor listing already carries each entry's kind, so there
   * is no stat per entry. A symlink is reported as `"symlink"` (lstat semantics, per `DirEntry`)
   * from its `symlinkTarget`.
   *
   * Caveat worth knowing: the SDK drops entries that are neither a file nor a directory (a socket,
   * a FIFO, possibly a dangling symlink), so those are absent from the listing rather than
   * reported as `"other"`.
   */
  async listDir(path: string): Promise<readonly DirEntry[]> {
    const entries = await this.sdk.files.list(this.resolve(path));
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.symlinkTarget !== undefined ? "symlink" : entry.type === "dir" ? "dir" : entry.type === "file" ? "file" : "other",
    }));
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const target = this.resolve(path);
    const makeDir = this.sdk.files.makeDir;
    if (options?.parents === true) {
      if (makeDir === undefined) {
        const { exitCode } = await this.run(["mkdir", "-p", "--", target]);
        if (exitCode !== 0) throw codedError(`mkdir -p failed: ${target}`, "EIO");
        return;
      }
      // `makeDir` already creates the parents — one RPC instead of a `mkdir -p` command. When the
      // path existed, it must be a directory: `mkdir -p` over a file fails, and so does this.
      if (await makeDir.call(this.sdk.files, target)) return;
      if ((await this.fileInfo(target).catch(() => undefined))?.kind === "dir") return;
      throw codedError(`EEXIST: path exists and is not a directory: ${target}`, "EEXIST");
    }
    // Plain mkdir must fail on an existing path; `files.makeDir` returns false instead of
    // throwing, so translate that into the EEXIST the contract promises.
    const created = (await makeDir?.call(this.sdk.files, target)) ?? false;
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
    let payload: string | Uint8Array | ReadableStream<Uint8Array>;
    try {
      payload = await this.sdk.files.read(this.resolve(path), { format: "bytes" });
    } catch (error) {
      // Callers branch on ENOENT (an append to a file that does not exist yet); the SDK's
      // FileNotFoundError carries no code.
      throw asErrnoError(error, this.resolve(path));
    }
    const bytes = await toBuffer(payload);
    return sliceRange(bytes, range);
  }

  async writeBytes(path: string, data: Buffer): Promise<void> {
    await this.sdk.files.write(this.resolve(path), toArrayBuffer(data));
  }

  /** Public URL for a port listening inside the sandbox (dev servers, previews). */
  async exposedPortUrl(port: number, scheme: "http" | "https" = "https"): Promise<string | undefined> {
    if (this.sdk.getHost === undefined) return undefined;
    return `${scheme}://${await this.sdk.getHost(port)}`;
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
    const result = (error as { result?: E2BCommandResult } | null)?.result
      ?? (typeof (error as E2BCommandResult)?.exitCode === 'number' ? error as E2BCommandResult : undefined);
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

/** The SDK's not-found error, given the ENOENT code every Environment caller branches on. */
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

class E2BFiles extends EnvironmentFilesAdapter {
  private sdk: () => E2BSandbox;
  constructor(environment: E2BEnvironment, sdk: () => E2BSandbox) { super(environment); this.sdk = sdk; }
  // Initialized lazily: the sandbox reference is assigned after this adapter is constructed.
  get watchDir(): EnvironmentFiles['watchDir'] {
    const api = this.sdk().files;
    if (!api.watchDir) return undefined;
    return async (path, onEvent, options) => api.watchDir!(this.absolute(path), onEvent, { ...options, timeoutMs: 0 });
  }
  override async getInfo(path: string, options?: { followSymlinks?: boolean }): Promise<EntryInfo> {
    const api = this.sdk().files;
    if (!api.getInfo) return super.getInfo(path, options);
    try {
      const info = await api.getInfo(this.absolute(path));
      if (info.symlinkTarget || info.type === 'symlink') return { ...entryInfo(info), ...await this.environment.fileInfo(path, options) };
      return entryInfo(info);
    } catch (error) { throw asErrnoError(error, path); }
  }
  override async write(path: string, data: FileData) {
    const target = this.absolute(path);
    try { await this.sdk().files.write(target, data); }
    catch (error) { throw asErrnoError(error, target); }
    return { path: target, name: posix.basename(target) };
  }
  override async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.absolute(path);
    try {
      const data = await this.sdk().files.read(target, { format: 'stream' });
      if (typeof data === 'object' && 'getReader' in data) return data;
      const bytes = await toBuffer(data);
      return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    } catch (error) { throw asErrnoError(error, target); }
  }
  override async makeDir(path: string): Promise<boolean> {
    const api = this.sdk().files;
    if (!api.makeDir) return super.makeDir(path);
    try {
      const made = await api.makeDir(this.absolute(path));
      if (!made && (await this.getInfo(path)).kind !== 'dir') throw codedError(`Not a directory: ${path}`, 'EEXIST');
      return made;
    } catch (error) { throw asErrnoError(error, path); }
  }
  override async writeFiles(files: readonly WriteEntry[]) {
    const api = this.sdk().files;
    if (!api.writeFiles) return super.writeFiles(files);
    const entries = [];
    for (const file of files) entries.push({ path: this.absolute(file.path), data: await toBuffer(file.data) });
    try { await api.writeFiles(entries); } catch (error) { throw asErrnoError(error, 'writeFiles'); }
    return entries.map(entry => ({ path: entry.path, name: posix.basename(entry.path) }));
  }
  override async list(path: string, options?: { depth?: number }): Promise<readonly EntryInfo[]> {
    const depth = options?.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 1) throw new RangeError('depth must be a positive integer');
    try { return (await this.sdk().files.list(this.absolute(path), { depth })).map(entryInfo); }
    catch (error) { throw asErrnoError(error, path); }
  }
  override async rename(oldPath: string, newPath: string): Promise<EntryInfo> {
    const api = this.sdk().files;
    if (!api.rename) return super.rename(oldPath, newPath);
    try { return entryInfo(await api.rename(this.absolute(oldPath), this.absolute(newPath))); }
    catch (error) { throw asErrnoError(error, oldPath); }
  }
  override async remove(path: string): Promise<void> {
    const api = this.sdk().files;
    if (!api.remove) return super.remove(path);
    try { await api.remove(this.absolute(path)); }
    catch (error) { const mapped = asErrnoError(error, path); if ((mapped as NodeJS.ErrnoException).code !== 'ENOENT') throw mapped; }
  }
}
function entryInfo(entry: E2BEntryInfo): EntryInfo {
  return { ...entry, name: entry.name, path: entry.path, kind: entry.symlinkTarget !== undefined || entry.type === 'symlink' ? 'symlink' : entry.type ?? 'other', size: entry.size ?? 0, ...mtimeOf(entry) };
}
