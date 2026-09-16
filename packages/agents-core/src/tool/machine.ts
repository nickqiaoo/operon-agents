/** One increment of command output. `stream` keeps stdout and stderr distinguishable —
 *  a PTY would merge them, which is why tool execution deliberately does not use one. */
export interface OutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

/**
 * What the caller WANTS from a command run. Every field is an intent the backend fulfils
 * with its own native means — local spawn + signals, SSH channel teardown, a vendor's
 * `timeoutMs` + `kill(pid)`. The alternative this replaced was handing back POSIX process
 * MACHINERY and making the caller assemble timeout/capping around it — an assembly that
 * only ever worked on local backends, and silently did nothing everywhere else.
 */
export interface RunCommandOptions {
  readonly cwd?: string;
  /** Overrides layered over the ambient environment, not a replacement. */
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  /** Kill the command after this long. `RunCommandResult.timedOut` reports whether it fired. */
  readonly timeoutMs?: number;
  /**
   * Cap on captured output. Backends should stop the command at the source when they can
   * rather than transferring everything and trimming after.
   */
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  /**
   * Incremental output. Backends that can stream call this as output arrives; backends
   * that cannot call it once at the end. Degradation lives in the contract, so a caller
   * writes one code path and never queries a capability.
   */
  readonly onOutput?: (chunk: OutputChunk) => void;
}

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * `undefined` means the backend cannot confirm the command finished (e.g. a sandbox that
   * yielded while it kept running). The type forces callers to face that case instead of
   * receiving a fabricated 0.
   */
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  /** Output hit `maxOutputBytes` and was cut. */
  readonly truncated: boolean;
  /**
   * Whether the command was actually stopped when a timeout or abort demanded it. `false`
   * means the backend could only walk away — surface it to the user, never pretend.
   */
  readonly terminated: boolean;
}

/** A byte window of a file. Both ends optional: `{}` is the whole file, `{length}` a prefix,
 *  `{offset}` everything from there on, both a slice. Reads past EOF return what exists. */
export interface ByteRange {
  /** 0-based byte to start at. Default 0. */
  readonly offset?: number;
  /** Maximum bytes to return. Omit to read to EOF. */
  readonly length?: number;
}

export type DecodeErrors = "strict" | "replace" | "ignore";

export type OsKind = "Linux" | "Darwin" | "Windows" | (string & {});
export type ShellName = "bash" | "zsh" | "sh" | "powershell" | "cmd" | (string & {});

export interface Environment {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
}

export type FileKind = "file" | "dir" | "symlink" | "other";

/**
 * The metadata tools actually consume — the honest cross-backend subset of stat.
 * Backends without an mtime (some sandbox vendors) leave `mtimeMs` undefined;
 * there is no 0-sentinel anywhere in the new surface.
 */
export interface FileInfo {
  readonly kind: FileKind;
  /** File size in bytes. */
  readonly size: number;
  /** stat mtime in milliseconds. undefined = backend does not provide one. */
  readonly mtimeMs?: number;
}

/**
 * One entry of a directory listing, with the kind the backend already knew.
 *
 * `kind` is LSTAT semantics — a symlink reads as `"symlink"`, never as its target's
 * kind. That is what `opendir`/`readdir` hand back for free on every backend, so a
 * listing costs one round trip instead of one-per-entry. A caller that needs the
 * target kind resolves just the `"symlink"` entries with `fileInfo` (which follows
 * by default), paying a stat only for the entries that actually need one.
 */
export interface DirEntry {
  /** Entry basename, as `listDir` would return it. */
  readonly name: string;
  readonly kind: FileKind;
}

/**
 * Version stamp for the session's read-state record (see FileFreshnessLedger).
 * mtime and nothing else (local-first): on hosts with a reliable mtime the check
 * is free; hosts without one (some sandbox vendors) leave `mtimeMs` undefined,
 * and every check there falls back to content comparison, done on a digest
 * (`hashFileContent`) so neither side retains the text.
 *
 * Size deliberately plays no part. It only ever ruled on cases the mtime had
 * already decided, except for one it decided WRONG: an mtime-less backend
 * with an unchanged size was read as "no evidence of a change" when it is in
 * fact no evidence either way. Without it, mtime-less means unverifiable
 * means fall back to content — one rule instead of a matrix.
 */
export interface FileVersion {
  /** stat mtime in milliseconds. undefined = backend does not provide one. */
  readonly mtimeMs?: number;
}

export type LineEndings = "LF" | "CRLF" | "mixed";

export interface WriteTextOptions {
  readonly encoding?: BufferEncoding;
  /** Line-ending style to restore on write; `data` is LF-normalized. Default LF. */
  readonly lineEndings?: "LF" | "CRLF";
}

export interface WriteTextResult {
  readonly bytesWritten: number;
}

/**
 * Handle to the machine the workspace lives on.
 *
 * Not a filesystem abstraction: files, processes and path/OS semantics are one
 * contract precisely because they must agree — a command started by `run` sees
 * the same files `readBytes` reads. Every member is defined at the altitude
 * each backend (local / SSH / sandbox vendor) can implement honestly:
 *
 * - `run` is the universal primitive — the single way anything executes, from a
 *   one-shot `git status` to a background build. Search-shaped operations (grep,
 *   glob) run a uniform binary through it rather than getting their own member.
 * - File I/O is `readBytes` (every read, whole file or a byte window) plus two
 *   unconditional writes, `writeText` and `writeBytes`. There is deliberately NO
 *   compare-and-swap write: the read-before-write safety the tools need is decided
 *   against the session's read-state record (FileFreshnessLedger) BEFORE the write,
 *   and no backend but the local one can make the compare and the write one step
 *   anyway — a CAS member could only have promised what it does not deliver.
 * - `realpath` exists for symlink anti-bypass: path-access
 *   checks canonicalize before prefix-matching. The threat model is the tool
 *   call escaping the workspace, not the backend lying — so a `readlink -f` run
 *   through `run` is as authoritative as the backend's own FS view.
 *
 * Implementations extend {@link BaseMachine} (machine-base.ts):
 * it derives the high-level operations from a small SPI so a new backend only
 * writes the dumb primitives, and overrides them only where it can do better
 * (single round trip, true atomicity, bounded-memory streaming).
 *
 * Agent bookkeeping (cron/background task state, plans, plugin registries)
 * does NOT belong here — that is SessionStore's job. The rule: content owned
 * by the user's workspace goes through the host; content owned by the agent's
 * session goes through the store.
 */
export interface Machine {
  readonly name: string;
  readonly osEnv: Environment;

  // Identity & path semantics (sync, no I/O).
  pathClass(): "posix" | "win32";
  normpath(path: string): string;
  gethome(): string;
  getcwd(): string;
  /**
   * Extra workspace roots granted the same path access as the cwd tree (the
   * `--add-dir` equivalent). Consumed by the path-access policy: a path inside any of these
   * resolves like an in-workspace path instead of tripping the outside-workspace guard.
   * Optional — absent means "cwd only".
   */
  additionalDirs?(): readonly string[];
  /**
   * Return a sibling machine rooted at `cwd`, sharing this machine's backend
   * resources (the same ssh connection / sandbox session / local machine) — only
   * the working directory differs. Purely structural and cheap (no I/O); the
   * symmetric counterpart of `getcwd()`. Callers that need an isolated workspace
   * (e.g. a git worktree for a subagent) build it on top of this rather than the
   * machine knowing anything about isolation. A relative `cwd` resolves against
   * the current one. Never mutates this machine, so re-rooting one copy can't
   * clobber the cwd of another that shares the same connection.
   */
  withCwd(cwd: string): Machine;

  /**
   * Public URL for a port listening inside this machine, or `undefined` when the backend
   * has no way to expose one (local, ssh, a sandbox without port forwarding). A dev server
   * the agent just started is only useful if someone can reach it, and only the backend
   * knows the mapping — E2B's `getHost`, a vendor tunnel, and so on.
   *
   * This is an OPERATION on a running machine, not workspace lifecycle: it answers a
   * question about a machine we were handed, and never creates or destroys anything.
   * `undefined` rather than a throw, so a caller writes one code path.
   */
  exposedPortUrl?(port: number): Promise<string | undefined>;

  /**
   * Run a command to completion — the ONE way callers execute anything.
   *
   * Everything a caller might want from a running command is stated here as INTENT
   * (timeout / output cap / cancellation / incremental output / stdin) and fulfilled by the
   * backend natively. There is deliberately no "give me a process handle" alternative: a
   * handle is POSIX machinery only local backends implement honestly, so callers built on
   * one end up with timeouts and kills that silently do nothing over a sandbox transport.
   *
   * Long-running work is this same call, not-awaited: cancel through `signal`, watch through
   * `onOutput`, learn how it ended from the resolved result. That is exactly what the
   * background-task machinery does.
   *
   * `BaseMachine` derives it from a process-spawning SPI, so local and SSH backends get it
   * for free; backends with native support (a vendor `timeoutMs` + `kill`) override it.
   */
  run(argv: readonly string[], options?: RunCommandOptions): Promise<RunCommandResult>;

  // Directories & metadata.
  /** Metadata for one  path. Follows symlinks by default; `followSymlinks: false` = lstat semantics. */
  fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo>;
  /**
   * Shallow listing: one entry per child, no `.`/`..`. Maps 1:1 to opendir / SFTP readdir /
   * vendor listDir.
   *
   * Entries carry their `kind` because every backend's readdir already knows it — handing
   * back bare names would force callers into a stat per entry, which is free locally and
   * seconds of serial round trips on a remote machine. `kind` is lstat semantics; resolve
   * `"symlink"` entries with `fileInfo` when the target kind matters (see `DirEntry`).
   */
  listDir(path: string): Promise<readonly DirEntry[]>;
  /**
   * Create a directory. Option contract:
   *  - `parents: true` — `mkdir -p`: missing ancestors are created and an existing
   *    directory is always OK (`existOk` is implied and effectively ignored).
   *  - `existOk: true` (with `parents` unset/false) — an existing DIRECTORY at `path` is
   *    OK; anything else occupying the path (a file) must still throw EEXIST.
   *    (Known deviation: `SshMachine` currently passes a file occupant through.)
   *  - neither — plain mkdir: throws if `path` exists or its parent is missing.
   */
  mkdir(path: string, options?: { parents?: boolean; existOk?: boolean }): Promise<void>;

  // Files.
  /**
   * Raw bytes, optionally a byte RANGE of them. Omit `range` for the whole file.
   *
   * The range is a genuine pushdown, not a convenience: every backend can read a slice
   * without moving the rest (local `read(fd, …, position)`, SFTP `read` at an offset, a
   * sandbox's `tail -c +N | head -c L`). That is what makes two very different callers cheap
   * on every backend — sniffing a media header off the front of a 500 MB file, and following
   * a growing log by reading only what is new since the last offset.
   */
  readBytes(path: string, range?: ByteRange): Promise<Buffer>;
  /**
   * Unconditional binary write — the exact bytes, no encoding and no line-ending rewriting.
   * The counterpart of `readBytes`: without it, anything not valid UTF-8 (an image, an
   * archive being unpacked into the workspace) has no way in, and callers resort to base64
   * through a shell.
   */
  writeBytes(path: string, data: Buffer): Promise<void>;
  /**
   * Unconditional text write — no staleness check, no stat round trips, no version stamp.
   *
   * Whether the file lands all-at-once is a BACKEND property, not a promise of this
   * contract: LocalMachine swaps a sibling temp file into place (free there, and it
   * keeps symlink/mode semantics), remote backends write straight to the target
   * because staging a temp file and renaming it costs round trips on every write to
   * narrow a window nothing in the tool path depends on.
   */
  writeText(path: string, data: string, options?: WriteTextOptions): Promise<WriteTextResult>;

  /**
   * Canonicalize symlinks (security: path-access checks must canonicalize before
   * prefix-matching). Derived default is `readlink -f` on posix / normpath on
   * win32; hosts with a native resolver (local fs.realpath, SFTP realpath)
   * override for exactness.
   */
  realpath(path: string): Promise<string>;

}

export interface MachineOpenContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

/**
 * Lazy, per-session way to hand a session its {@link Machine} — for hosts that can only
 * build one once they know the session (or that must `await` a connection). Pass a
 * `Machine` directly whenever one already exists; that is the common case.
 *
 * Sandbox LIFECYCLE — creating, snapshotting, pausing, destroying — deliberately lives
 * outside this framework. A sandbox is typically a user- or workspace-scoped resource
 * whose lifetime spans many sessions (new, resumed and forked alike), so the layer that
 * knows when a user is actually done is the host, not a session. The host creates the
 * sandbox, hands the machine in, and disposes of it on its own terms; everything here
 * only ever OPERATES a machine it was given — which is also why this type has no
 * teardown half: a factory that mints a machine per session has nowhere to release it.
 *
 * The concrete thing this buys: nothing in a session's durable state points at a sandbox,
 * so forking a session cannot silently make two sessions share one workspace, and closing
 * one session cannot pull the sandbox out from under the others.
 */
export type MachineFactory = (ctx: MachineOpenContext) => Machine | Promise<Machine>;
