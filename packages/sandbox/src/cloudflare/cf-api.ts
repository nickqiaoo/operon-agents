/**
 * The slice of `@cloudflare/sandbox`'s `SandboxClient` this adapter calls, described
 * structurally so the package stays an optional peer and tests can inject a fake.
 *
 * This is the ROUTE transport (`new SandboxClient({ baseUrl })`), which is what a Node
 * process gets. It is deliberately not `getSandbox()` — that one needs a
 * `DurableObjectNamespace` and only exists inside a Worker. Consequences of that choice,
 * all visible below: every call carries a `sessionId`, incremental output arrives as an SSE
 * stream rather than an `onOutput` callback, and tunnels (hence public port URLs) are
 * unavailable because the SDK implements them on the RPC transport only.
 */

export interface CloudflareSandboxClient {
  readonly commands: CloudflareCommandsApi;
  readonly processes: CloudflareProcessesApi;
  readonly files: CloudflareFilesApi;
  readonly git?: CloudflareGitApi;
  readonly backup?: CloudflareBackupApi;
}

export interface CloudflareExecOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface CloudflareExecuteResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CloudflareCommandsApi {
  /** One round trip, native `timeoutMs`, no handle to cancel with. */
  execute(command: string, sessionId: string, options?: CloudflareExecOptions): Promise<CloudflareExecuteResponse>;
}

export interface CloudflareProcessStartResult {
  processId: string;
  pid?: number;
}

export interface CloudflareProcessInfoResult {
  process: {
    id: string;
    status: string;
    exitCode?: number;
  };
}

export interface CloudflareProcessesApi {
  /**
   * Starts a command and returns immediately with a `processId` — the handle that makes
   * cancellation real, which `commands.execute` cannot give us.
   */
  startProcess(
    command: string,
    sessionId: string,
    options?: CloudflareExecOptions & { processId?: string; autoCleanup?: boolean },
  ): Promise<CloudflareProcessStartResult>;
  getProcess(processId: string): Promise<CloudflareProcessInfoResult>;
  killProcess(processId: string): Promise<unknown>;
  killAllProcesses?(): Promise<unknown>;
  /** SSE stream of `LogEvent` records: `stdout` / `stderr` / `exit` / `error`. */
  streamProcessLogs(processId: string): Promise<ReadableStream<Uint8Array>>;
}

/** One decoded `LogEvent` from `streamProcessLogs`. */
export interface CloudflareLogEvent {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number;
}

export interface CloudflareFileEntry {
  name: string;
  /** Present on directory listings; the SDK's own `FileInfo` shape varies by version. */
  type?: string;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface CloudflareFilesApi {
  mkdir(path: string, sessionId: string, options?: { recursive?: boolean }): Promise<unknown>;
  /** `encoding: "base64"` is the only way to move bytes over this transport. */
  writeFile(path: string, content: string, sessionId: string, options?: { encoding?: string }): Promise<unknown>;
  readFile(path: string, sessionId: string, options?: { encoding?: string }): Promise<{ content: string }>;
  listFiles(
    path: string,
    sessionId: string,
    options?: { recursive?: boolean; includeHidden?: boolean },
  ): Promise<{ files: readonly CloudflareFileEntry[] }>;
  exists?(path: string, sessionId: string): Promise<{ exists: boolean }>;
}

export interface CloudflareGitApi {
  /** Native shallow clone — cheaper and more precise than shelling out to `git`. */
  checkout(
    repoUrl: string,
    sessionId: string,
    options?: { branch?: string; targetDir?: string; depth?: number; timeoutMs?: number },
  ): Promise<unknown>;
}

export interface CloudflareBackupApi {
  /** squashfs archive of a directory — Cloudflare's stand-in for a vendor snapshot. */
  createArchive(
    dir: string,
    archivePath: string,
    sessionId: string,
    options?: { excludes?: string[]; gitignore?: boolean },
  ): Promise<unknown>;
  restoreArchive(dir: string, archivePath: string, sessionId: string): Promise<unknown>;
}

/** Read a `SandboxClient` through a function so a workspace can swap the instance underneath. */
export type CloudflareClientRef = () => CloudflareSandboxClient;
