import type { ByteRange, DirEntry, Environment, Machine, FileInfo, RunCommandOptions, RunCommandResult } from "./machine.ts";
import { BaseMachine } from "./machine-base.ts";

/**
 * An machine with no filesystem or process backing.
 *
 * Pure metadata (osEnv / path computation) returns neutral values so tools that
 * only inspect the environment don't crash; every actual I/O operation throws a
 * clear error. This is the default when a session is opened without an machine —
 * a stateless server that forgets to omit a file tool fails LOUDLY instead of
 * silently reading the host disk.
 *
 * Note `realpath` resolves to `normpath` (pure computation, no I/O): the base
 * derivation's `readlink -f` attempt fails with the disabled error and falls back.
 */
export class NullMachine extends BaseMachine {
  readonly name = "null";
  readonly osEnv: Environment = {
    osKind: "Linux",
    osArch: "unknown",
    osVersion: "0",
    shellName: "sh",
    shellPath: "/bin/sh",
  };

  private disabled(op: string): Error {
    return new Error(
      `NullMachine: filesystem disabled — operation "${op}" requires an machine, but none was configured for this session.`,
    );
  }

  // Path operations — pure computation, no I/O, safe to answer.
  pathClass(): "posix" | "win32" {
    return "posix";
  }
  normpath(path: string): string {
    return path;
  }
  gethome(): string {
    return "/";
  }
  getcwd(): string {
    return "/";
  }
  withCwd(_cwd: string): Machine {
    return this; // every operation is refused regardless of cwd
  }

  // Directories & files — I/O, refused.
  async fileInfo(_path: string, _options?: { followSymlinks?: boolean }): Promise<FileInfo> {
    throw this.disabled("fileInfo");
  }
  async listDir(_path: string): Promise<readonly DirEntry[]> {
    throw this.disabled("listDir");
  }
  async mkdir(_path: string, _options?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    throw this.disabled("mkdir");
  }
  async readBytes(_path: string, _range?: ByteRange): Promise<Buffer> {
    throw this.disabled("readBytes");
  }
  protected async writeBytesRaw(_path: string, _data: Buffer): Promise<void> {
    throw this.disabled("writeBytes");
  }

  // Command execution — refused. Overridden rather than left to the base derivation so the
  // error names this machine instead of reporting a missing process SPI.
  override async run(_argv: readonly string[], _options?: RunCommandOptions): Promise<RunCommandResult> {
    throw this.disabled("run");
  }
}
