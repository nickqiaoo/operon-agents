import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { posix } from "node:path";
import * as ssh2 from "ssh2";
import type { AnyAuthMethod, Client, ClientChannel, ConnectConfig, OpenMode, SFTPWrapper, Stats as SFTPStats } from "ssh2";
import {
  FileExistsError,
  type Environment,
  type OsKind,
  type ShellName,
  type ByteRange,
  type Machine,
  type DirEntry,
  type FileInfo,
  type FileKind,
  type WriteFileResult,
  type WriteTextIfUnchangedOptions,
} from "./machine.ts";
import { BaseMachine, type SpawnedProcess } from "./machine-base.ts";
import { fileVersionFromInfo } from "./support/machine-ops.ts";
import { proxyEnv } from "./shell-env.ts";

const FALLBACK_SFTP_STATUS = {
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
} as const;

export type SshMachineExtraOptions = Omit<
  ConnectConfig,
  "host" | "port" | "username" | "password" | "privateKey" | "authHandler" | "hostVerifier"
>;

export interface SshMachineOptions {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly password?: string;
  readonly keyPaths?: readonly string[];
  readonly keyContents?: readonly string[];
  readonly cwd?: string;
  /** Extra workspace roots granted cwd-equivalent path access (see Machine.additionalDirs). */
  readonly additionalDirs?: readonly string[];
  readonly name?: string;
  readonly hostVerifier?: (key: Buffer) => boolean;
  readonly forwardProxyEnv?: boolean;
  readonly extraOptions?: SshMachineExtraOptions;
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function sftpStatusCode(): typeof FALLBACK_SFTP_STATUS {
  return { ...FALLBACK_SFTP_STATUS, ...(ssh2.utils?.sftp?.STATUS_CODE as Partial<typeof FALLBACK_SFTP_STATUS>) };
}

function mapSftpError(operation: string, error: unknown): NodeJS.ErrnoException {
  const raw = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const code = typeof raw === "number" ? raw : undefined;
  const message = `${operation} failed: ${error instanceof Error ? error.message : String(error)}`;
  const status = sftpStatusCode();
  if (code === status.NO_SUCH_FILE) return codedError(message, "ENOENT");
  if (code === status.PERMISSION_DENIED) return codedError(message, "EACCES");
  if (code === status.NO_CONNECTION || code === status.CONNECTION_LOST) return codedError(message, "ECONNRESET");
  return codedError(message, "EIO");
}

export function sshShellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:=@%^,+-]+$/.test(arg)) return arg;
  return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
}

export function buildSshExecCommand(args: readonly string[], cwd: string, env?: Record<string, string>): string {
  let command = args.map((arg) => sshShellQuote(arg)).join(" ");
  if (env !== undefined) {
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`SshMachine: invalid env variable name ${JSON.stringify(key)}`);
      }
      assignments.push(`${key}=${sshShellQuote(value)}`);
    }
    if (assignments.length > 0) command = `${assignments.join(" ")} ${command}`;
  }
  if (cwd !== "") command = `cd ${sshShellQuote(cwd)} && ${command}`;
  return command;
}

function fileKindFromSftpStats(attrs: SFTPStats): FileKind {
  if (attrs.isFile()) return "file";
  if (attrs.isDirectory()) return "dir";
  if (attrs.isSymbolicLink()) return "symlink";
  return "other";
}

export class SshProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private _exitCode: number | null = null;
  private readonly _exit: Promise<number>;
  private readonly channel: ClientChannel;

  constructor(channel: ClientChannel) {
    this.channel = channel;
    this.stdin = channel;
    // Buffer through PassThroughs so output emitted before a consumer attaches isn't dropped.
    const out = new PassThrough();
    const err = new PassThrough();
    channel.pipe(out);
    channel.stderr.pipe(err);
    this.stdout = out;
    this.stderr = err;

    this._exit = new Promise<number>((resolve) => {
      // Resolve on 'close' (all buffered output flushed); 'exit' carries the code on some backends.
      channel.on("exit", (code: number | null) => {
        this._exitCode = code ?? 1;
      });
      channel.on("close", (code: number | null) => {
        this._exitCode ??= code ?? 1;
        resolve(this._exitCode);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  wait(): Promise<number> {
    return this._exit;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const sshSignal = signal.startsWith("SIG") ? signal.slice(3) : signal;
    this.channel.signal(sshSignal);
    return Promise.resolve();
  }
}

function connectClient(config: ConnectConfig): Promise<Client> {
  const client = new ssh2.Client();
  return new Promise<Client>((resolve, reject) => {
    client.on("ready", () => resolve(client));
    client.on("error", (err: Error) => reject(err));
    client.connect(config);
  });
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function clientExec(client: Client, command: string): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel)));
  });
}

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (err, abs) => (err ? reject(mapSftpError("realpath", err)) : resolve(abs)));
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<SFTPStats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(mapSftpError("stat", err)) : resolve(stats)));
  });
}

function sftpLstat(sftp: SFTPWrapper, path: string): Promise<SFTPStats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (err, stats) => (err ? reject(mapSftpError("lstat", err)) : resolve(stats)));
  });
}

interface SftpEntry {
  readonly filename: string;
  readonly attrs: SFTPStats;
}

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<SftpEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(mapSftpError("readdir", err)) : resolve(list as SftpEntry[])));
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(mapSftpError("mkdir", err)) : resolve()));
  });
}

function sftpExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => sftp.exists(path, (exists) => resolve(exists)));
}

/** Occupant kind probe for mkdir: `exists` alone can't tell a file from a directory, and
 *  mkdir's `existOk`/`parents` semantics only tolerate DIRECTORY occupants. */
async function sftpKindOf(sftp: SFTPWrapper, path: string): Promise<"dir" | "other" | undefined> {
  try {
    const attrs = await sftpStat(sftp, path);
    return attrs.isDirectory() ? "dir" : "other";
  } catch {
    return undefined; // missing (or unstat-able — the subsequent mkdir surfaces the real error)
  }
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, data) => (err ? reject(mapSftpError("readFile", err)) : resolve(data)));
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (err) => (err ? reject(mapSftpError("writeFile", err)) : resolve()));
  });
}

function sftpOpen(sftp: SFTPWrapper, path: string, flags: OpenMode): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (err, handle) => (err ? reject(mapSftpError("open", err)) : resolve(handle)));
  });
}

/** Reads at most `length` bytes starting at `offset` — a genuine windowed read, not a
 *  whole-file transfer that gets sliced afterwards. */
function sftpReadHandle(sftp: SFTPWrapper, handle: Buffer, offset: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(length);
    sftp.read(handle, buf, 0, length, offset, (err, bytesRead) => {
      // EOF before `length` bytes arrives as an error on some servers; an empty read is
      // the honest answer there, not a failure.
      if (err) return bytesRead ? resolve(buf.subarray(0, bytesRead)) : resolve(Buffer.alloc(0));
      resolve(buf.subarray(0, bytesRead));
    });
  });
}

function sftpClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => sftp.close(handle, () => resolve()));
}

function sftpWriteHandle(sftp: SFTPWrapper, handle: Buffer, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // ssh2 chunks writes beyond the server's max packet size internally.
    sftp.write(handle, data, 0, data.byteLength, 0, (err) => (err ? reject(mapSftpError("write", err)) : resolve()));
  });
}

function sftpCloseHandle(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => (err ? reject(mapSftpError("close", err)) : resolve()));
  });
}

function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => (err ? reject(mapSftpError("unlink", err)) : resolve()));
  });
}

function sftpRename(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(src, dst, (err) => (err ? reject(mapSftpError("rename", err)) : resolve()));
  });
}

function sftpSetstat(sftp: SFTPWrapper, path: string, attrs: { mode: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.setstat(path, attrs, (err) => (err ? reject(mapSftpError("setstat", err)) : resolve()));
  });
}

/**
 * Atomic overwriting rename: posix-rename@openssh.com when the server offers it.
 * ONLY the unsupported-extension error falls back to unlink+rename (which has a tiny
 * no-file window between the two calls) — any real failure propagates untouched,
 * because unlinking the destination after e.g. a permission error would delete the
 * target with no replacement guaranteed.
 */
async function sftpAtomicRename(sftp: SFTPWrapper, src: string, dst: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      // ssh2 throws synchronously when the server lacks the extension; the
      // executor converts that throw into a rejection.
      sftp.ext_openssh_rename(src, dst, (err) => (err ? reject(mapSftpError("rename", err)) : resolve()));
    });
    return;
  } catch (error) {
    const unsupported = error instanceof Error && /does not support this extended request/i.test(error.message);
    if (!unsupported) throw error;
  }
  try {
    await sftpUnlink(sftp, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await sftpRename(sftp, src, dst); // SFTP v3 rename refuses to overwrite — dst is gone by now
}

function buildAuthHandler(
  username: string,
  privateKeys: readonly (Buffer | string)[],
  password?: string,
): ConnectConfig["authHandler"] {
  const queue: AnyAuthMethod[] = privateKeys.map((key) => ({ key, type: "publickey", username }));
  if (password !== undefined) queue.push({ password, type: "password", username });
  let index = 0;
  return (_authsLeft, _partialSuccess, next) => {
    const nextAuth = queue[index];
    index += 1;
    (next as (auth: AnyAuthMethod | false) => void)(nextAuth ?? false);
  };
}

/** Deadline for the env probe: the probe is best-effort (failure already falls back to
 *  defaults), but a server that never closes the exec channel — a restricted shell, an
 *  unclean close — must not hang `SshMachine.create()` forever. */
const PROBE_TIMEOUT_MS = 10_000;

async function probeRemoteEnvironment(client: Client): Promise<Environment> {
  let raw = "";
  try {
    raw = await new Promise<string>((resolve, reject) => {
      // Timeout resolves to "" — the same defaults path a failed probe takes. NOT unref'd:
      // this timer is what unblocks create() when the channel never closes.
      const timer = setTimeout(() => resolve(""), PROBE_TIMEOUT_MS);
      clientExec(client, 'uname -s; uname -m; uname -r; printf "%s" "${SHELL:-/bin/sh}"').then(
        (channel) => {
          const chunks: Buffer[] = [];
          channel.on("data", (d: Buffer) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
          channel.on("close", () => {
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString("utf-8"));
          });
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  } catch {
    /* fall through to defaults */
  }
  const [sysname = "", machine = "", osVersion = "", shell = ""] = raw.split("\n").map((line) => line.trim());
  const osKind: OsKind = /^linux/i.test(sysname)
    ? "Linux"
    : /^darwin/i.test(sysname)
      ? "Darwin"
      : /mingw|msys|cygwin|windows/i.test(sysname)
        ? "Windows"
        : sysname.length > 0
          ? sysname
          : "Linux";
  const shellPath = shell.length > 0 ? shell : "/bin/sh";
  const shellName: ShellName = posix.basename(shellPath);
  return { osKind, osArch: machine || "unknown", osVersion: osVersion || "unknown", shellName, shellPath };
}

export class SshMachine extends BaseMachine {
  readonly name: string;
  readonly osEnv: Environment;
  private readonly client: Client;
  private readonly sftp: SFTPWrapper;
  private readonly home: string;
  private readonly cwd: string;
  private readonly injectedEnv: Record<string, string>;
  private readonly extraDirs: readonly string[];

  private constructor(args: {
    client: Client;
    sftp: SFTPWrapper;
    home: string;
    cwd: string;
    osEnv: Environment;
    name: string;
    injectedEnv: Record<string, string>;
    additionalDirs: readonly string[];
  }) {
    super();
    this.client = args.client;
    this.sftp = args.sftp;
    this.home = args.home;
    this.cwd = args.cwd;
    this.osEnv = args.osEnv;
    this.name = args.name;
    this.injectedEnv = args.injectedEnv;
    this.extraDirs = args.additionalDirs;
  }

  static fromConnection(args: {
    client: Client;
    sftp: SFTPWrapper;
    home: string;
    cwd?: string;
    osEnv: Environment;
    name?: string;
    injectedEnv?: Record<string, string>;
    additionalDirs?: readonly string[];
  }): SshMachine {
    return new SshMachine({
      client: args.client,
      sftp: args.sftp,
      home: args.home,
      cwd: args.cwd ?? args.home,
      osEnv: args.osEnv,
      name: args.name ?? "ssh",
      injectedEnv: args.injectedEnv ?? {},
      additionalDirs: args.additionalDirs ?? [],
    });
  }

  static async create(options: SshMachineOptions): Promise<SshMachine> {
    const config: ConnectConfig = {
      ...options.extraOptions,
      host: options.host,
      port: options.port ?? 22,
      username: options.username,
    };
    if (options.password !== undefined) config.password = options.password;

    const privateKeys: (Buffer | string)[] = [...(options.keyContents ?? [])];
    if (options.keyPaths) {
      const loaded = await Promise.all(options.keyPaths.map((p) => readFile(p, "utf-8")));
      privateKeys.push(...loaded);
    }
    if (privateKeys.length > 0) {
      const handler = buildAuthHandler(options.username, privateKeys, options.password);
      if (handler !== undefined) config.authHandler = handler;
    }
    config.hostVerifier = options.hostVerifier ?? (() => true);

    const client = await connectClient(config);
    try {
      const sftp = await getSftp(client);
      const home = await sftpRealpath(sftp, ".");
      let cwd = home;
      if (options.cwd !== undefined) {
        cwd = await sftpRealpath(sftp, options.cwd);
        const attrs = await sftpStat(sftp, cwd);
        if (!attrs.isDirectory()) throw codedError(`${cwd} is not a directory`, "ENOTDIR");
      }
      const osEnv = await probeRemoteEnvironment(client);
      const injectedEnv = options.forwardProxyEnv === false ? {} : proxyEnv();
      return new SshMachine({ client, sftp, home, cwd, osEnv, name: options.name ?? `ssh:${options.host}`, injectedEnv, additionalDirs: options.additionalDirs ?? [] });
    } catch (error) {
      client.end();
      throw error;
    }
  }

  pathClass(): "posix" | "win32" {
    return "posix";
  }
  normpath(path: string): string {
    return posix.normalize(path);
  }
  gethome(): string {
    return this.home;
  }
  getcwd(): string {
    return this.cwd;
  }

  override additionalDirs(): readonly string[] {
    return this.extraDirs;
  }

  private resolvePath(path: string): string {
    return posix.isAbsolute(path) ? path : posix.join(this.cwd, path);
  }

  async fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo> {
    const resolved = this.resolvePath(path);
    const follow = options?.followSymlinks ?? true;
    const st = follow ? await sftpStat(this.sftp, resolved) : await sftpLstat(this.sftp, resolved);
    // SFTP v3 mtime is POSIX seconds; the cross-host contract is milliseconds.
    return {
      kind: fileKindFromSftpStats(st),
      size: st.size,
      ...(st.mtime === 0 ? {} : { mtimeMs: st.mtime * 1000 }),
    };
  }

  /** SFTP readdir returns each entry's attrs (lstat semantics) alongside its name, so the
   *  whole listing — kinds included — is a single round trip. */
  async listDir(path: string): Promise<readonly DirEntry[]> {
    const entries = await sftpReaddir(this.sftp, this.resolvePath(path));
    return entries
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .map((entry) => ({ name: entry.filename, kind: fileKindFromSftpStats(entry.attrs) }));
  }

  withCwd(cwd: string): Machine {
    // Share this connection's client/sftp — only the cwd differs. Never close the
    // clone independently; the connection is owned by whoever opened this machine.
    const clone = SshMachine.fromConnection({
      client: this.client,
      sftp: this.sftp,
      home: this.home,
      cwd: this.resolvePath(cwd),
      osEnv: this.osEnv,
      name: this.name,
      injectedEnv: this.injectedEnv,
    });
    clone.pathLocks = this.pathLocks; // one connection, one file namespace — clones share write locks
    return clone;
  }

  async readBytes(path: string, range?: ByteRange): Promise<Buffer> {
    const resolved = this.resolvePath(path);
    if (range === undefined) return await sftpReadFile(this.sftp, resolved);
    // Open + bounded read: only the requested window crosses the wire, which is the whole
    // point of asking for one (a header sniff must not pull a 500 MB file over SFTP).
    const offset = range.offset ?? 0;
    const length = range.length ?? Math.max(0, (await this.fileInfo(path)).size - offset);
    if (length === 0) return Buffer.alloc(0);
    const handle = await sftpOpen(this.sftp, resolved, "r");
    try {
      return await sftpReadHandle(this.sftp, handle, offset, length);
    } finally {
      await sftpClose(this.sftp, handle);
    }
  }

  /** Streamed via SFTP + the shared scanner: bounded memory ("read the last 10 lines"
   *  no longer pulls the whole file into a Buffer), same range/byte-cap semantics as
   *  LocalMachine's streaming path — replaces the whole-file BaseMachine composition. */
  protected async writeBytesRaw(path: string, data: Buffer): Promise<void> {
    await sftpWriteFile(this.sftp, this.resolvePath(path), data);
  }

  /** Same file → same lock across path spellings: resolve against cwd like every SFTP call does. */
  protected override lockKeyFor(path: string): string {
    return this.resolvePath(path);
  }

  override async writeTextIfUnchanged(path: string, data: string, options: WriteTextIfUnchangedOptions): Promise<WriteFileResult> {
    return await this.withPathLock(path, async () => {
      const encoding = options.encoding ?? "utf8";
      const resolved = this.resolvePath(path);
      const payload = options.lineEndings === "CRLF" ? data.replaceAll("\n", "\r\n") : data;
      const buf = Buffer.from(payload, encoding);

      if (options.expected === "must-not-exist") {
        let handle: Buffer;
        try {
          handle = await sftpOpen(this.sftp, resolved, "wx");
        } catch (error) {
          // SFTP v3 has no EEXIST status (servers report a generic FAILURE) — disambiguate by stat.
          if (await sftpExists(this.sftp, resolved)) throw new FileExistsError();
          throw error;
        }
        try {
          await sftpWriteHandle(this.sftp, handle, buf);
        } catch (error) {
          // The EXCL open created the file; don't leave a torn one behind.
          await sftpCloseHandle(this.sftp, handle).catch(() => undefined);
          await sftpUnlink(this.sftp, resolved).catch(() => undefined);
          throw error;
        }
        await sftpCloseHandle(this.sftp, handle);
      } else {
        // Check before the upload — a stale file shouldn't cost the whole transfer.
        await this.assertUnchanged(path, options, encoding);
        const tmp = posix.join(posix.dirname(resolved), `.${posix.basename(resolved)}.tmp-${randomBytes(6).toString("hex")}`);
        try {
          await sftpWriteFile(this.sftp, tmp, buf);
          const target = await sftpStat(this.sftp, resolved).catch(() => undefined);
          if (target !== undefined) await sftpSetstat(this.sftp, tmp, { mode: target.mode & 0o7777 });
          await this.assertUnchanged(path, options, encoding); // re-check right before the swap
          await sftpAtomicRename(this.sftp, tmp, resolved);
        } catch (error) {
          await sftpUnlink(this.sftp, tmp).catch(() => undefined);
          throw error;
        }
      }
      const after = await this.fileInfo(path); // still inside the lock — the version is THIS write's
      return { bytesWritten: buf.byteLength, version: fileVersionFromInfo(after) };
    });
  }

  /** SFTP has a native canonicalizer — exact, no readlink dependency. */
  override async realpath(path: string): Promise<string> {
    return await sftpRealpath(this.sftp, this.resolvePath(path));
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    const resolved = this.resolvePath(path);
    const existOk = options?.existOk ?? false;
    if (options?.parents) {
      const parts = resolved.split("/").filter(Boolean);
      let current = resolved.startsWith("/") ? "/" : "";
      for (const part of parts) {
        current = current === "/" || current === "" ? `${current}${part}` : `${current}/${part}`;
        const kind = await sftpKindOf(this.sftp, current);
        if (kind === "dir") continue;
        // `mkdir -p` tolerates existing DIRECTORIES only — a file occupant anywhere on
        // the way (final component included) is EEXIST, matching LocalMachine/Node.
        if (kind !== undefined) throw codedError(`${current} already exists and is not a directory`, "EEXIST");
        try {
          await sftpMkdir(this.sftp, current);
        } catch (error) {
          // Lost a create race — fine only if the winner made a directory.
          if ((await sftpKindOf(this.sftp, current)) !== "dir") throw error;
        }
      }
      return;
    }
    const kind = await sftpKindOf(this.sftp, resolved);
    if (kind !== undefined) {
      // existOk only tolerates a directory occupant; a file at the path is always EEXIST.
      if (existOk && kind === "dir") return;
      throw codedError(`${resolved} already exists`, "EEXIST");
    }
    await sftpMkdir(this.sftp, resolved);
  }

  protected override async spawn(argv: readonly string[], env?: Record<string, string>): Promise<SpawnedProcess> {
    if (argv.length === 0) throw new Error("spawn requires at least one argument");
    // Layer proxy forwarding under the caller's overrides (caller wins on conflict).
    const merged = { ...this.injectedEnv, ...(env ?? {}) };
    const command = buildSshExecCommand(argv, this.cwd, Object.keys(merged).length > 0 ? merged : undefined);
    const channel = await clientExec(this.client, command);
    return new SshProcess(channel);
  }

  close(): Promise<void> {
    this.sftp.end();
    return new Promise<void>((resolve) => {
      this.client.once("close", () => resolve());
      this.client.end();
    });
  }
}

/*
 * No `sshMachineFactory` here on purpose. Its only job would be closing the connection on
 * session close — the lifecycle management that now belongs to whoever opened it (see
 * `MachineFactory`). A host wires SSH in the same way it wires a sandbox:
 *
 *   const machine = await SshMachine.create(options);
 *   const harness = new Harness({ machine });
 *   // ...and calls machine.close() on its own terms.
 *
 * That also fixes what the factory form got wrong: it opened a NEW connection per session,
 * so several sessions on one host meant several connections, each dying with its own session.
 */
