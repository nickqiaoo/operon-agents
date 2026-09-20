import { readFile } from "node:fs/promises";
import { PassThrough, Transform, type Readable, type TransformCallback, type Writable } from "node:stream";
import { posix } from "node:path";
import * as ssh2 from "ssh2";
import type { AnyAuthMethod, Client, ClientChannel, ConnectConfig, OpenMode, SFTPWrapper, Stats as SFTPStats } from "ssh2";
import {
  type Environment,
  type OsKind,
  type ShellName,
  type ByteRange,
  type Machine,
  type DirEntry,
  type FileInfo,
  type FileKind,
} from "./machine.ts";
import { BaseMachine, type SpawnedProcess } from "./machine-base.ts";
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

/** First stderr line of every posix command: the process group the command runs in. */
const PGID_MARKER = "__OPERON_PGID__=";

/**
 * Prefix that makes a remote command report its process group before it runs.
 *
 * sshd starts an exec request as `$SHELL -c '<command>'` in a new session, so that shell leads
 * the process group everything the command starts belongs to — and its pid is the group id. A
 * child `sh` reads it back as `$PPID`: the login shell may not be POSIX (fish has no `$$`), but
 * `sh -c '…'` parses the same everywhere.
 */
export const SSH_PGID_REPORT = `sh -c 'printf "%s%s\\n" ${PGID_MARKER} "$PPID"' >&2; `;

/**
 * Strips the {@link SSH_PGID_REPORT} line off the front of stderr and hands over the group id.
 * Anything that is not the marker passes through untouched, so a server that ignored the
 * prefix costs nothing but the ability to signal the group.
 */
class PgidMarkerStripper extends Transform {
  private pending: Buffer | undefined = Buffer.alloc(0);
  private readonly onPgid: (pgid: number) => void;

  constructor(onPgid: (pgid: number) => void) {
    super();
    this.onPgid = onPgid;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.pending === undefined) {
      callback(null, chunk);
      return;
    }
    const buffered = Buffer.concat([this.pending, chunk]);
    const newline = buffered.indexOf(0x0a);
    if (newline === -1 && buffered.length < 256) {
      this.pending = buffered;
      callback();
      return;
    }
    this.pending = undefined;
    const line = newline === -1 ? "" : buffered.subarray(0, newline).toString("utf8");
    const match = line.startsWith(PGID_MARKER) ? /^(\d+)$/.exec(line.slice(PGID_MARKER.length)) : null;
    if (match === null) {
      callback(null, buffered);
      return;
    }
    this.onPgid(Number(match[1]));
    const rest = buffered.subarray(newline + 1);
    callback(null, rest.length > 0 ? rest : undefined);
  }

  override _flush(callback: TransformCallback): void {
    callback(null, this.pending !== undefined && this.pending.length > 0 ? this.pending : undefined);
  }
}

/** A short side command on the same connection, resolving with its exit code. */
export type SshSideExec = (command: string) => Promise<number>;

export class SshProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private _exitCode: number | null = null;
  private readonly _exit: Promise<number>;
  private readonly channel: ClientChannel;
  private readonly sideExec: SshSideExec | undefined;
  private pgid: number | undefined;

  /**
   * `sideExec` present = the command was started behind {@link SSH_PGID_REPORT}: stderr carries
   * the group id, and a stop signals the whole group through a second exec on the connection.
   * Without it only the channel is signalled, which sshd delivers to the login shell alone.
   */
  constructor(channel: ClientChannel, sideExec?: SshSideExec) {
    this.channel = channel;
    this.sideExec = sideExec;
    this.stdin = channel;
    // Buffer through PassThroughs so output emitted before a consumer attaches isn't dropped.
    const out = new PassThrough();
    channel.pipe(out);
    this.stdout = out;
    if (sideExec === undefined) {
      const err = new PassThrough();
      channel.stderr.pipe(err);
      this.stderr = err;
    } else {
      this.stderr = channel.stderr.pipe(new PgidMarkerStripper((pgid) => (this.pgid = pgid)));
    }

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

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const sshSignal = signal.startsWith("SIG") ? signal.slice(3) : signal;
    if (this.sideExec !== undefined && this.pgid !== undefined) {
      // The group first, the lone pid if it is not a group leader after all (a server that did
      // not start a new session). Either way the channel signal below still goes out.
      const pgid = String(this.pgid);
      await this.sideExec(`kill -s ${sshSignal} -- -${pgid} 2>/dev/null || kill -s ${sshSignal} ${pgid} 2>/dev/null`).catch(() => undefined);
    }
    this.channel.signal(sshSignal);
  }

  async survivors(): Promise<boolean> {
    if (this.sideExec === undefined || this.pgid === undefined) return false;
    // A dropped connection answers "none left": nothing more can be done about them from here.
    const code = await this.sideExec(`kill -s 0 -- -${String(this.pgid)} 2>/dev/null`).catch(() => 1);
    return code === 0;
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

/** Run a command for its exit status alone: output is drained and discarded. */
async function execForExitCode(client: Client, command: string): Promise<number> {
  const channel = await clientExec(client, command);
  return await new Promise<number>((resolve) => {
    let code: number | null = null;
    channel.on("exit", (exitCode: number | null) => {
      code = exitCode;
    });
    channel.on("close", () => resolve(code ?? 1));
    channel.resume();
    channel.stderr.resume();
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
    // A Windows server's shell has no process groups (or `sh`) to report — signal the channel.
    if (this.osEnv.osKind === "Windows") return new SshProcess(await clientExec(this.client, command));
    const channel = await clientExec(this.client, SSH_PGID_REPORT + command);
    return new SshProcess(channel, (side) => execForExitCode(this.client, side));
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
