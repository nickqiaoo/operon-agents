import type { FileData, FilesystemEvent, WatchHandle, WatchOptions, ProcessInfo, CommandConnectOptions, PtySize, PtyCreateOptions, SandboxInfo, SandboxMetrics } from 'operon-agents-core';
/**
 * The slice of the E2B SDK this adapter uses, described structurally rather than imported.
 *
 * Structural typing keeps `e2b` an OPTIONAL peer: the package compiles without it, tests can
 * inject a fake, and a minor SDK release cannot break our build. The shapes mirror the E2B
 * JS SDK v1.4 reference (`Sandbox.commands` / `Sandbox.files`); anything optional here is
 * optional in the SDK too, or is a method we degrade gracefully without.
 */

export interface E2BCommandResult {
  readonly stdout?: string;
  readonly stderr?: string;
  /** null = the SDK reported no exit status (still running / killed). */
  readonly exitCode?: number | null;
  readonly error?: string;
}

/** `background: true` resolves to this instead of a finished result. */
export interface E2BCommandHandle extends E2BCommandResult {
  readonly pid: number;
  /**
   * Rejects for any nonzero exit with a `CommandExitError` whose `result` is the finished
   * result, and with a plain error when the event stream fails (a kill, a dropped connection).
   */
  wait?(): Promise<E2BCommandResult>;
  kill?(): Promise<boolean>;
  disconnect?(): Promise<void>;
}

export interface E2BRunOpts {
  retainOutput?: boolean;
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  user?: string;
  /** SDK default 60 000 when omitted; `0` = no deadline. */
  timeoutMs?: number;
  /** Incremental stdout. Present natively — this is what the OpenAI adapter never passes. */
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  stdin?: boolean;
}

export interface E2BCommandsApi {
  list?(): Promise<readonly ProcessInfo[]>;
  connect?(pid: number, options?: CommandConnectOptions & { timeoutMs?: number }): Promise<E2BCommandHandle>;
  run(command: string, opts?: E2BRunOpts): Promise<E2BCommandResult | E2BCommandHandle>;
  /** Real SIGKILL by pid; resolves to whether a process was actually killed. */
  kill?(pid: number, opts?: { requestTimeoutMs?: number }): Promise<boolean>;
  sendStdin?(pid: number, data: string | Uint8Array, opts?: { requestTimeoutMs?: number }): Promise<void>;
  /** EOF on the command's stdin. */
  closeStdin?(pid: number, opts?: { requestTimeoutMs?: number }): Promise<void>;
}

/** `type` is only ever file or dir. A symlink is marked by `symlinkTarget` instead, and
 *  `list()` drops entries of any other kind altogether. */
export type E2BFileType = "file" | "dir" | "symlink";

/** SDK `EntryInfo`, as returned by both `files.getInfo` and `files.list`. */
export interface E2BEntryInfo {
  readonly name: string;
  readonly path: string;
  readonly type?: E2BFileType;
  readonly size?: number;
  /** Millisecond precision (the SDK floors envd's nanoseconds). */
  readonly modifiedTime?: Date;
  /** Present when the entry is a symlink. */
  readonly symlinkTarget?: string;
  readonly mode?: number;
  readonly permissions?: string;
  readonly owner?: string;
  readonly group?: string;
  readonly metadata?: Record<string, string>;
}

export interface E2BFilesystemApi {
  writeFiles?(files: { path: string; data: FileData }[]): Promise<unknown>;
  rename?(oldPath: string, newPath: string): Promise<E2BEntryInfo>;
  watchDir?(path: string, onEvent: (event: FilesystemEvent) => void, options?: WatchOptions & { timeoutMs?: number }): Promise<WatchHandle>;
  list(path: string, opts?: Record<string, unknown>): Promise<readonly E2BEntryInfo[]>;
  read(path: string, opts?: { format?: "text" | "bytes" | "stream" }): Promise<string | Uint8Array | ReadableStream<Uint8Array>>;
  /**
   * `data` is deliberately NOT `Uint8Array`: the SDK takes `string | ArrayBuffer | Blob |
   * ReadableStream`, so declaring the wider type here would let a `Buffer` typecheck against
   * a signature that rejects it. See `E2BEnvironment.writeBytes` for the conversion.
   */
  write(path: string, data: FileData, opts?: Record<string, unknown>): Promise<unknown>;
  /** Creates missing parents too. `false` = the path already existed (the SDK maps AlreadyExists). */
  makeDir?(path: string): Promise<boolean>;
  /** One envd stat RPC. Rejects with `FileNotFoundError` for a missing path. */
  getInfo?(path: string): Promise<E2BEntryInfo>;
  remove?(path: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
}

export interface E2BPtyApi {
  create(options: PtySize & { onData: (data: Uint8Array) => void; cwd?: string; envs?: Record<string, string>; user?: string; timeoutMs?: number }): Promise<E2BCommandHandle>;
  connect(pid: number, options?: { onData?: (data: Uint8Array) => void; timeoutMs?: number }): Promise<E2BCommandHandle>;
  sendInput(pid: number, data: Uint8Array): Promise<void>;
  resize(pid: number, size: PtySize): Promise<void>;
  kill(pid: number): Promise<boolean>;
}
export interface E2BSandbox {
  readonly pty?: E2BPtyApi;
  readonly sandboxId: string;
  isRunning?(): Promise<boolean>;
  getInfo?(): Promise<Omit<SandboxInfo, "id"> & { sandboxId: string }>;
  getMetrics?(): Promise<SandboxMetrics[]>;
  setTimeout?(timeoutMs: number): Promise<void>;
  uploadUrl?(path?: string): Promise<string>;
  downloadUrl?(path: string): Promise<string>;
  fork?(options?: { count?: number }): Promise<(E2BSandbox | Error)[]>;
  readonly commands: E2BCommandsApi;
  readonly files: E2BFilesystemApi;
  /** Public URL for a port exposed inside the sandbox. */
  getHost?(port: number): string | Promise<string>;
  createSnapshot?(): Promise<{ snapshotId?: string }>;
  pause?(): Promise<boolean>;
  kill(): Promise<void | boolean>;
}

/**
 * How to obtain the CURRENT sandbox. Deliberately a function, not a value: restoring a
 * snapshot replaces the underlying instance (the old one gets killed), so an environment holding
 * a captured reference would keep talking to a dead sandbox.
 */
export type SandboxRef = () => E2BSandbox;
