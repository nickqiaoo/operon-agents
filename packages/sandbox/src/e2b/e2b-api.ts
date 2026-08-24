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
  wait?(): Promise<E2BCommandResult>;
  kill?(): Promise<boolean>;
  disconnect?(): Promise<void>;
}

export interface E2BRunOpts {
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  user?: string;
  timeoutMs?: number;
  /** Incremental stdout. Present natively — this is what the OpenAI adapter never passes. */
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  stdin?: boolean;
}

export interface E2BCommandsApi {
  run(command: string, opts?: E2BRunOpts): Promise<E2BCommandResult | E2BCommandHandle>;
  /** Real SIGKILL by pid; resolves to whether a process was actually killed. */
  kill?(pid: number, opts?: { requestTimeoutMs?: number }): Promise<boolean>;
  sendStdin?(pid: number, data: string, opts?: { requestTimeoutMs?: number }): Promise<void>;
}

/** `list()` reports only file/dir — there is no symlink value and no stat method (see machine.ts). */
export type E2BFileType = "file" | "dir";

export interface E2BEntryInfo {
  readonly name: string;
  readonly path: string;
  readonly type?: E2BFileType;
}

export interface E2BFilesystemApi {
  list(path: string, opts?: Record<string, unknown>): Promise<readonly E2BEntryInfo[]>;
  read(path: string, opts?: { format?: "text" | "bytes" }): Promise<string | Uint8Array>;
  /**
   * `data` is deliberately NOT `Uint8Array`: the SDK takes `string | ArrayBuffer | Blob |
   * ReadableStream`, so declaring the wider type here would let a `Buffer` typecheck against
   * a signature that rejects it. See `writeBytesRaw` for the conversion.
   */
  write(path: string, data: string | ArrayBuffer, opts?: Record<string, unknown>): Promise<unknown>;
  makeDir?(path: string): Promise<boolean>;
  remove?(path: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
}

export interface E2BSandbox {
  readonly sandboxId: string;
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
 * snapshot replaces the underlying instance (the old one gets killed), so a machine holding
 * a captured reference would keep talking to a dead sandbox.
 */
export type SandboxRef = () => E2BSandbox;
