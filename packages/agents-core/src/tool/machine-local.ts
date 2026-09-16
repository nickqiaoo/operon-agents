import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, type Dirent, type Stats } from "node:fs";
import {
  chmod as fsChmod,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  opendir,
  readFile,
  readlink as fsReadlink,
  realpath as fsRealpath,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile,
} from "node:fs/promises";
import { arch, homedir, release } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  type DecodeErrors,
  type DirEntry,
  type Environment,
  type ByteRange,
  type Machine,
  type FileInfo,
  type FileKind,
  type FileVersion,
  type OsKind,
} from "./machine.ts";
import { BaseMachine, type SpawnedProcess } from "./machine-base.ts";

function fileKindFromStats(s: Stats): FileKind {
  if (s.isFile()) return "file";
  if (s.isDirectory()) return "dir";
  if (s.isSymbolicLink()) return "symlink";
  return "other";
}

/** Dirent exposes the same predicates as Stats, so the readdir type needs no extra syscall. */
function fileKindFromDirent(entry: Dirent): FileKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "dir";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function isExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown })["code"] === "EEXIST";
}

/**
 * Write `payload` so a reader sees the old file or the new one, never a half-written one:
 * write a sibling temp file, then rename it over the target. This is what makes EVERY local
 * write all-or-nothing; remote backends write straight to the target instead, because there
 * the same staging costs round trips on every write (see Machine.writeText).
 *
 * Three details are load-bearing, all of them things a plain `writeFile` gets for free
 * and a rename does not:
 *
 * - A symlink is written THROUGH, not replaced. `renameSync` onto a symlink would clobber
 *   the link itself and leave the real file untouched — the opposite of what every editor,
 *   and `writeFileSync`, does.
 * - The target's mode is copied onto the temp file first. The new inode would otherwise be
 *   born with the process umask, silently dropping the executable bit off a script.
 * - A sibling temp, never `/tmp`: `rename(2)` is only atomic within one filesystem, and a
 *   cross-device rename fails outright rather than degrading quietly.
 *
 * On failure the temp file is removed and the write falls back to the direct one — a torn
 * file is the lesser evil against no write at all, and it is what happened before this
 * function existed.
 */
async function writeFileAtomic(target: string, payload: Buffer): Promise<void> {
  let realTarget = target;
  try {
    const link = await fsReadlink(target);
    realTarget = isAbsolute(link) ? link : resolve(dirname(target), link);
  } catch {
    // ENOENT (no such file) or EINVAL (not a symlink) — the target is its own real path.
  }

  let mode: number | undefined;
  try {
    mode = (await fsStat(realTarget)).mode;
  } catch {
    // New file: let the umask decide, exactly as writeFile would.
  }

  const temp = `${realTarget}.tmp.${String(process.pid)}.${String(Date.now())}`;
  try {
    await writeFile(temp, payload, { flush: true });
    if (mode !== undefined) await fsChmod(temp, mode);
    await fsRename(temp, realTarget);
  } catch {
    try {
      await fsUnlink(temp);
    } catch {
      /* never created, or already gone */
    }
    await writeFile(realTarget, payload, { flush: true });
  }
}

function detectWindowsGitBash(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const roots: string[] = [];
  if (env["GIT_INSTALL_ROOT"]) roots.push(env["GIT_INSTALL_ROOT"]);
  for (const base of [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]]) {
    if (base) roots.push(join(base, "Git"));
  }
  roots.push("C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git");
  for (const root of roots) {
    for (const rel of [join("bin", "bash.exe"), join("usr", "bin", "bash.exe")]) {
      const candidate = join(root, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function detectEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const platform = process.platform;
  const osKind: OsKind = platform === "win32" ? "Windows" : platform === "darwin" ? "Darwin" : "Linux";
  const shellPath =
    osKind === "Windows"
      ? (detectWindowsGitBash(env) ?? env["COMSPEC"] ?? "cmd.exe")
      : (env["SHELL"] ?? "/bin/bash");
  return {
    osKind,
    osArch: arch(),
    osVersion: release(),
    shellName: basename(shellPath).replace(/\.exe$/i, ""),
    shellPath,
  };
}

export class LocalMachine extends BaseMachine {
  readonly name = "local";
  readonly osEnv: Environment = detectEnvironment();
  private cwd: string;
  private readonly extraDirs: readonly string[];

  constructor(cwdOrOptions: string | { cwd?: string; additionalDirs?: readonly string[] } = process.cwd()) {
    super();
    if (typeof cwdOrOptions === "string") {
      this.cwd = cwdOrOptions;
      this.extraDirs = [];
    } else {
      this.cwd = cwdOrOptions.cwd ?? process.cwd();
      this.extraDirs = cwdOrOptions.additionalDirs ?? [];
    }
  }

  pathClass(): "posix" | "win32" {
    return process.platform === "win32" ? "win32" : "posix";
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return homedir();
  }

  getcwd(): string {
    return this.cwd;
  }

  // Session-granted extra roots survive a re-root (a worktree machine keeps its grants).
  withCwd(cwd: string): Machine {
    return new LocalMachine({ cwd: this.abs(cwd), additionalDirs: this.extraDirs });
  }

  override additionalDirs(): readonly string[] {
    return this.extraDirs;
  }

  private abs(path: string): string {
    return isAbsolute(path) ? path : resolve(this.cwd, path);
  }

  async fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo> {
    const follow = options?.followSymlinks ?? true;
    const s = follow ? await fsStat(this.abs(path)) : await fsLstat(this.abs(path));
    // mtimeMs 0 (some FAT-family filesystems) means "no usable mtime" — surface
    // that as undefined instead of a sentinel.
    return {
      kind: fileKindFromStats(s),
      size: s.size,
      ...(s.mtimeMs === 0 ? {} : { mtimeMs: s.mtimeMs }),
    };
  }

  /** opendir already carries the dirent type — no stat per entry (lstat semantics). */
  async listDir(path: string): Promise<readonly DirEntry[]> {
    const entries: DirEntry[] = [];
    const dir = await opendir(this.abs(path));
    for await (const entry of dir) entries.push({ name: entry.name, kind: fileKindFromDirent(entry) });
    return entries;
  }

  async readBytes(path: string, range?: ByteRange): Promise<Buffer> {
    if (range === undefined) return await readFile(this.abs(path));
    // A REAL windowed read. Slicing a whole-file read would satisfy the signature while
    // moving the entire file — which a header sniff or a log follower would then pay on
    // every call, however large the file has grown.
    const offset = range.offset ?? 0;
    const handle = await fsOpen(this.abs(path), "r");
    try {
      const length = range.length ?? Math.max(0, (await handle.stat()).size - offset);
      if (length === 0) return Buffer.alloc(0);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  protected async writeBytesRaw(path: string, data: Buffer): Promise<void> {
    await writeFileAtomic(this.abs(path), data);
  }

  /** One stat syscall, no round trip — so the ledger keeps its mtime fast path locally. */
  protected override async versionAfterWrite(path: string): Promise<FileVersion | undefined> {
    try {
      const s = await fsStat(this.abs(path));
      return s.mtimeMs === 0 ? {} : { mtimeMs: s.mtimeMs };
    } catch {
      // The write succeeded; failing to re-stat it only costs the fast path.
      return undefined;
    }
  }

  async mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    try {
      await fsMkdir(this.abs(path), { recursive: options?.parents ?? false });
    } catch (error) {
      // Recursive mkdir never throws EEXIST for an already-existing dir, so EEXIST here
      // means either the non-recursive path hit an existing entry or the entry is a FILE.
      // existOk only forgives an existing directory — a file at the path is still an error.
      if (isExistsError(error) && (options?.existOk ?? false)) {
        const info = await this.fileInfo(path).catch(() => undefined);
        if (info?.kind === "dir") return;
      }
      throw error;
    }
  }

  override async realpath(path: string): Promise<string> {
    return await fsRealpath(this.abs(path));
  }

  protected override spawn(argv: readonly string[], env?: Record<string, string>): Promise<SpawnedProcess> {
    const [command, ...rest] = argv;
    if (command === undefined) return Promise.reject(new Error("spawn requires at least one argument"));
    // Cross-machine contract: `env` is a set of OVERRIDES layered over the ambient
    // environment, not a replacement — so PATH/proxy/etc. are preserved.
    const child = spawn(command, rest, {
      cwd: this.cwd,
      env: env ? { ...(process.env as Record<string, string>), ...env } : (process.env as Record<string, string>),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return Promise.resolve(new LocalProcess(child));
  }
}

class LocalProcess implements SpawnedProcess {
  private readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
  }

  get stdin() {
    return this.child.stdin!;
  }
  get stdout() {
    return this.child.stdout!;
  }
  get stderr() {
    return this.child.stderr!;
  }
  get exitCode(): number | null {
    return this.child.exitCode;
  }

  wait(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.child.exitCode !== null) {
        resolve(this.child.exitCode);
        return;
      }
      this.child.once("exit", (code) => resolve(code ?? 0));
      this.child.once("error", reject);
    });
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.child.kill(signal);
  }
}
