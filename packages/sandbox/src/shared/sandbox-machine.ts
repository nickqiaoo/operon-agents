/**
 * Shared base for the vendor sandbox Machines (E2B, Cloudflare).
 *
 * The two transports differ in almost everything — one has a native process handle, the
 * other an HTTP API; one takes bytes, the other base64 — but they share one fallback: file
 * metadata from `stat(1)` through the shell. Cloudflare has no stat API at all; E2B has one and
 * uses it, falling back here only where it is ambiguous (symlinks). The derivation is identical
 * for both, so it is stated once here instead of twice in the backends.
 */
import { BaseMachine } from "operon-agents-core";
import type { FileInfo, FileKind } from "operon-agents-core";

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function statKind(raw: string): FileKind {
  if (/directory/.test(raw)) return "dir";
  if (/regular/.test(raw)) return "file";
  if (/symbolic link/.test(raw)) return "symlink";
  return "other";
}

/**
 * Seconds-since-epoch from `stat`, at the best precision the image's `stat` offered.
 *
 * `%Y` is whole seconds, and whole seconds are not enough to decide freshness: a linter
 * that rewrites a file in the same second the agent read it leaves the mtime IDENTICAL,
 * so the write sails through the version check and silently discards the linter's work.
 * `%.3Y` adds the millisecond fraction — the precision a local stat gives and the
 * resolution the freshness check is designed around.
 *
 * Not every image's `stat` understands the precision specifier — BusyBox echoes the
 * format string back verbatim. So both fields are requested and the fraction is used
 * only when it parses AND agrees with the whole-second value. A backend that can't
 * offer it degrades to second resolution rather than to a wrong timestamp.
 */
function parseMtimeSeconds(wholeRaw: string, fractionalRaw: string): number | undefined {
  const whole = Number(wholeRaw);
  if (!Number.isFinite(whole)) return undefined;
  const fractional = Number(fractionalRaw);
  // Math.floor, not a tolerance: the two fields come from ONE stat call, so a fraction
  // that doesn't floor to its own whole-second field isn't imprecise, it's unparsed.
  if (Number.isFinite(fractional) && Math.floor(fractional) === whole) return fractional;
  return whole;
}

export abstract class SandboxMachine extends BaseMachine {
  /**
   * Absolutize against the sandbox cwd. Both backends resolve identically; it is abstract
   * only because the cwd is a subclass constructor argument, not because the rule differs.
   */
  protected abstract resolve(path: string): string;

  /**
   * One `stat(1)` command. `-L` follows the
   * symlink; without it the link itself is described, which is what `DirEntry` wants.
   */
  async fileInfo(path: string, options?: { followSymlinks?: boolean }): Promise<FileInfo> {
    const target = this.resolve(path);
    const format = "%F|%s|%Y|%.3Y";
    const argv = (options?.followSymlinks ?? true)
      ? ["stat", "-L", "-c", format, "--", target]
      : ["stat", "-c", format, "--", target];
    const { stdout, exitCode } = await this.run(argv);
    if (exitCode !== 0) throw codedError(`No such file or directory: ${target}`, "ENOENT");
    // Last line only: a shell that prepends a banner would otherwise poison the parse.
    const [kindRaw = "", sizeRaw = "", mtimeRaw = "", mtimeFracRaw = ""] = (stdout.trim().split("\n").pop() ?? "").split("|");
    const size = Number(sizeRaw);
    const mtimeSec = parseMtimeSeconds(mtimeRaw, mtimeFracRaw);
    if (!Number.isFinite(size) || mtimeSec === undefined) {
      throw codedError(`Unparsable stat output for ${target}`, "EIO");
    }
    // mtime 0 means "the backend has no clock for this file" — report it as absent
    // rather than as 1970, so the freshness check falls back to content comparison.
    // Rounded: `1726480000.123 * 1000` is not always an exact integer in floating point, and an
    // mtime that is off by a hair never equals the same instant read from a native API.
    return { kind: statKind(kindRaw), size, ...(mtimeSec === 0 ? {} : { mtimeMs: Math.round(mtimeSec * 1000) }) };
  }
}
