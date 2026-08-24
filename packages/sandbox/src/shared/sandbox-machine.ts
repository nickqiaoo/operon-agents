/**
 * Shared base for the vendor sandbox Machines (E2B, Cloudflare).
 *
 * The two transports differ in almost everything — one has a native process handle, the
 * other an HTTP API; one takes bytes, the other base64 — but they agree on the one shape
 * that matters here: a file API that writes DIRECTLY to the target path, plus a shell to
 * run `mv` in. That combination determines the CAS write identically for both, so it is
 * stated once here instead of twice in the backends.
 */
import { BaseMachine } from "operon-agents-core";
import type { FileInfo, FileKind } from "operon-agents-core";
import { writeViaTempSwap } from "./remote-file-ops.ts";

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

  /** Same file → same lock across path spellings: key on the resolved path. */
  protected override lockKeyFor(path: string): string {
    return this.resolve(path);
  }

  /**
   * Neither vendor exposes a stat API, so this costs one `stat(1)`. `-L` follows the
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
    return { kind: statKind(kindRaw), size, ...(mtimeSec === 0 ? {} : { mtimeMs: mtimeSec * 1000 }) };
  }

  /**
   * Both vendors' file APIs land on the target directly, so the CAS path swaps through a
   * sibling temp file instead — otherwise a failure mid-upload (a crashed sandbox, a dropped
   * request) leaves a truncated file where the caller was just promised all-or-nothing.
   *
   * Falls back to the direct write when the swap could not be completed — an image without
   * `mv`. Torn state is the lesser risk against not writing at all, and `writeViaTempSwap`
   * has already cleaned up after itself by then.
   */
  protected override async writeBytesSwap(path: string, data: Buffer): Promise<void> {
    const target = this.resolve(path);
    // `name` tags the temp file with the backend that left it, should one ever survive.
    const swapped = await writeViaTempSwap(this, target, data, (p, d) => this.writeBytesRaw(p, d), this.name);
    if (!swapped) await this.writeBytesRaw(target, data);
  }
}
