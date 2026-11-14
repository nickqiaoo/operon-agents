export type DecodeErrors = "strict" | "replace" | "ignore";

export type OsKind = "Linux" | "Darwin" | "Windows" | (string & {});
export type ShellName = "bash" | "zsh" | "sh" | "powershell" | "cmd" | (string & {});

export interface OsInfo {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** string = shell 命令行（E2B 原生形态）；string[] = 精确 argv，不经 shell 解析（本地原生形态）。 */
export type Command = string | readonly string[];

export interface OutputChunk { readonly stream: "stdout" | "stderr"; readonly data: string }

/** commands.run 的意图式选项。现有类型，语义不变。 */
export interface RunCommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;      // 覆盖项，叠加在环境变量之上
  readonly stdin?: string;                    // 写入后发 EOF
  readonly timeoutMs?: number;                // 到时杀进程
  readonly maxOutputBytes?: number;           // 每个流的累计上限；只停止累计，不杀进程
  readonly signal?: AbortSignal;
  readonly onOutput?: (chunk: OutputChunk) => void;
}

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;      // undefined = 无法确认结束
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly terminated: boolean;               // 要求停止时是否确认停住
}

export interface CommandStartOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: boolean;                   // 默认 false：命令立刻看到 EOF
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
  readonly retainOutput?: boolean;            // false = 句柄上不累计输出
  /** 输出同时写入环境上的这个文件，并在自然结束时把退出码写进 `${outputFile}.exit`。
   *  未给 stderrFile 时 stdout 与 stderr 合并写入，并合并经 onStdout 推送。见 5.2。 */
  readonly outputFile?: string;
  readonly stderrFile?: string;               // stderr 单独落盘，不经 onStdout 推送
}

export interface CommandResult {
  readonly exitCode: number | undefined;      // undefined = 被杀或未观察到结束
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface CommandHandle {
  readonly pid: number;                       // 有 OS pid 的后端就是 OS pid
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;      // 运行中为 undefined
  /** 非零退出是结果，不抛异常。只有后端在未被要求停止的情况下丢失命令才 reject。 */
  wait(): Promise<CommandResult>;
  /** 用后端最强的原生手段停掉命令及其子进程。true = 确认已停。 */
  kill(): Promise<boolean>;
  /** 不再接收输出，命令继续运行。之后可用 commands.connect 重连。 */
  disconnect(): Promise<void>;
  sendStdin(data: string | Uint8Array): Promise<void>;   // 需要 start 时 stdin: true
  closeStdin(): Promise<void>;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly tag?: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly envs: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export type CommandConnectOptions = Pick<CommandStartOptions, "onStdout" | "onStderr" | "retainOutput">;

export interface EnvironmentCommands {
  run(command: Command, options?: RunCommandOptions): Promise<RunCommandResult>;
  start(command: Command, options?: CommandStartOptions): Promise<CommandHandle>;
  list(): Promise<readonly ProcessInfo[]>;
  /** 找不到时以 code = "ESRCH" reject。 */
  connect(pid: number, options?: CommandConnectOptions): Promise<CommandHandle>;
  kill(pid: number): Promise<boolean>;
  sendStdin(pid: number, data: string | Uint8Array): Promise<void>;
  closeStdin(pid: number): Promise<void>;
}

// ── PTY ──────────────────────────────────────────────────────────────────────

export interface PtySize { readonly cols: number; readonly rows: number }
export interface PtyCreateOptions extends PtySize {
  readonly onData: (data: Uint8Array) => void;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}
export interface PtyHandle {
  readonly pid: number;
  wait(): Promise<{ readonly exitCode: number | undefined }>;
  sendInput(data: string | Uint8Array): Promise<void>;
  resize(size: PtySize): Promise<void>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}
export interface EnvironmentPty {
  create(options: PtyCreateOptions): Promise<PtyHandle>;
  connect(pid: number, options: Pick<PtyCreateOptions, "onData">): Promise<PtyHandle>;
  sendInput(pid: number, data: string | Uint8Array): Promise<void>;
  resize(pid: number, size: PtySize): Promise<void>;
  kill(pid: number): Promise<boolean>;
}

// ── Files ────────────────────────────────────────────────────────────────────

export interface ByteRange { readonly offset?: number; readonly length?: number }
export type FileKind = "file" | "dir" | "symlink" | "other";
export interface FileInfo { readonly kind: FileKind; readonly size: number; readonly mtimeMs?: number }
export interface DirEntry { readonly name: string; readonly kind: FileKind }   // kind 是 lstat 语义

/** FileInfo 与 DirEntry 的超集，所以旧调用方迁移时字段名不变。 */
export interface EntryInfo extends FileInfo, DirEntry {
  readonly path: string;                      // 绝对路径
  readonly mode?: number;
  readonly permissions?: string;
  readonly owner?: string;
  readonly group?: string;
  readonly symlinkTarget?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}
export interface WriteInfo { readonly name: string; readonly path: string }
export type FileData = string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
export interface WriteEntry { readonly path: string; readonly data: FileData }
export interface FilesystemEvent {
  readonly name: string;                      // 相对被监听目录的路径
  readonly type: "create" | "write" | "remove" | "rename" | "chmod";
}
export interface WatchOptions { readonly recursive?: boolean; readonly onExit?: (error?: Error) => void }
export interface WatchHandle { stop(): Promise<void> }

/** 相对路径基于 getcwd()。路径不存在时，所有后端都以 code = "ENOENT" reject。 */
export interface EnvironmentFiles {
  read(path: string, options?: { readonly range?: ByteRange }): Promise<Buffer>;
  readStream(path: string): Promise<ReadableStream<Uint8Array>>;
  /** 整文件写入；创建文件、覆盖已有文件、创建缺失的父目录。 */
  write(path: string, data: FileData): Promise<WriteInfo>;
  writeFiles(files: readonly WriteEntry[]): Promise<readonly WriteInfo[]>;
  list(path: string, options?: { readonly depth?: number }): Promise<readonly EntryInfo[]>;
  /** mkdir -p。true = 新建，false = 目录已存在。非目录占位时以 EEXIST reject。 */
  makeDir(path: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<EntryInfo>;
  /** 删除文件或整个目录。路径不存在不算错误。 */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getInfo(path: string, options?: { readonly followSymlinks?: boolean }): Promise<EntryInfo>;
  /** 没有变更通知的后端不提供此成员。 */
  watchDir?(path: string, onEvent: (event: FilesystemEvent) => void, options?: WatchOptions): Promise<WatchHandle>;
  realpath(path: string): Promise<string>;
}

// ── Sandbox（机器本身）────────────────────────────────────────────────────────

export interface SandboxInfo {
  readonly id: string;
  readonly state: "running" | "paused";
  readonly templateId?: string;
  readonly startedAt?: Date;
  readonly endAt?: Date;                      // 不续期就会在这个时间被回收
  readonly cpuCount?: number;
  readonly memoryMB?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}
export interface SandboxMetrics {
  readonly timestamp: Date;
  readonly cpuCount: number; readonly cpuUsedPct: number;
  readonly memUsed: number;  readonly memTotal: number;
  readonly diskUsed: number; readonly diskTotal: number;
}
export interface EnvironmentSandbox {
  readonly id: string;                        // 厂商沙箱 id；本地为 hostname。恢复快照后可能变化
  getHost(port: number): Promise<string | undefined>;
  getUrl(port: number): Promise<string | undefined>;
  isRunning(): Promise<boolean>;
  getInfo(): Promise<SandboxInfo>;
  getMetrics(): Promise<SandboxMetrics | undefined>;
  /** 续期。false = 该后端没有生命周期可续。 */
  setTimeout(timeoutMs: number): Promise<boolean>;
  uploadUrl(path?: string): Promise<string | undefined>;
  downloadUrl(path: string): Promise<string | undefined>;
}

export interface Environment {
  readonly name: string;
  readonly osInfo: OsInfo;

  readonly files: EnvironmentFiles;
  readonly commands: EnvironmentCommands;
  readonly pty?: EnvironmentPty;
  readonly sandbox: EnvironmentSandbox;

  pathClass(): "posix" | "win32";
  normpath(path: string): string;
  gethome(): string;
  getcwd(): string;
  additionalDirs?(): readonly string[];
  withCwd(cwd: string): Environment;


}

export interface EnvironmentOpenContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

/**
 * Lazy, per-session way to hand a session its {@link Environment} — for hosts that can only
 * build one once they know the session (or that must `await` a connection). Pass a
 * `Environment` directly whenever one already exists; that is the common case.
 *
 * Sandbox LIFECYCLE — creating, snapshotting, pausing, destroying — deliberately lives
 * outside this framework. A sandbox is typically a user- or workspace-scoped resource
 * whose lifetime spans many sessions (new, resumed and forked alike), so the layer that
 * knows when a user is actually done is the host, not a session. The host creates the
 * sandbox, hands the environment in, and disposes of it on its own terms; everything here
 * only ever OPERATES an environment it was given — which is also why this type has no
 * teardown half: a factory that mints an environment per session has nowhere to release it.
 *
 * The concrete thing this buys: nothing in a session's durable state points at a sandbox,
 * so forking a session cannot silently make two sessions share one workspace, and closing
 * one session cannot pull the sandbox out from under the others.
 */
export type EnvironmentFactory = (ctx: EnvironmentOpenContext) => Environment | Promise<Environment>;
