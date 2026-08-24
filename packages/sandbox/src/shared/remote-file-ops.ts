import { posix } from "node:path";
import type { Machine } from "operon-agents-core";

/**
 * Read a byte WINDOW of a remote file without transferring the rest.
 *
 * Neither vendor's file API takes a byte range, so the window is cut on the far side and
 * only that much comes back. The bytes ride home base64-encoded because `run` hands back
 * `stdout` as a STRING — raw binary through that path would be mangled by UTF-8 decoding,
 * and both callers (a media header sniff, a log follower) are binary reads.
 *
 * `tail -c +N` is 1-indexed, so a 0-based offset becomes `N = offset + 1`; at offset 0 it is
 * a pass-through, which keeps one command shape for every case.
 *
 * `undefined` means the image lacks these coreutils; the caller falls back to a whole-file
 * read. Returning a value it cannot vouch for would be worse than being slow.
 */
/** Apply a byte range to bytes already in hand — the fallback path's share of the contract. */
export function sliceRange(bytes: Buffer, range?: { readonly offset?: number; readonly length?: number }): Buffer {
  if (range === undefined) return bytes;
  const offset = Math.max(0, Math.trunc(range.offset ?? 0));
  return range.length === undefined ? bytes.subarray(offset) : bytes.subarray(offset, offset + Math.max(0, Math.trunc(range.length)));
}

export async function readWindowViaShell(
  machine: Machine,
  absPath: string,
  range: { readonly offset?: number; readonly length?: number },
): Promise<Buffer | undefined> {
  const offset = Math.max(0, Math.trunc(range.offset ?? 0));
  const length = range.length === undefined ? undefined : Math.max(0, Math.trunc(range.length));
  if (length === 0) return Buffer.alloc(0);
  const cut = length === undefined ? "" : ` | head -c ${String(length)}`;
  // The path goes through `$0` rather than string interpolation, so no quoting scheme has to
  // be trusted with a filename containing quotes, spaces or newlines. The numbers are ours.
  const result = await machine
    .run(["sh", "-c", `tail -c +${String(offset + 1)} -- "$0"${cut} | base64`, absPath])
    .catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return undefined;
  // base64(1) wraps its output; strip every kind of whitespace before decoding.
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

/**
 * Put `data` at `absPath` so a concurrent reader sees the old file or the new one, never a
 * half-written one: upload to a sibling temp path, then `mv` over the target. Within one
 * filesystem that rename is indivisible, which is the guarantee the CAS write needs and
 * neither vendor's file API offers on its own.
 *
 * The temp file is a SIBLING, not `/tmp` — a cross-device `mv` degrades to copy-then-unlink
 * and loses exactly the atomicity this exists for.
 *
 * Returns false when the swap could not be completed, leaving the caller to fall back to a
 * plain write; the temp file is cleaned up either way.
 */
export async function writeViaTempSwap(
  machine: Machine,
  absPath: string,
  data: Buffer,
  writeRaw: (path: string, data: Buffer) => Promise<void>,
  tempSuffix: string,
): Promise<boolean> {
  const temp = `${posix.join(posix.dirname(absPath), `.${posix.basename(absPath)}`)}.${tempSuffix}.tmp`;
  try {
    await writeRaw(temp, data);
  } catch {
    return false; // nothing landed; nothing to clean up
  }
  const moved = await machine.run(["mv", "-f", "--", temp, absPath]).catch(() => undefined);
  if (moved?.exitCode === 0) return true;
  // `mv` unavailable or refused — drop the temp file rather than leave litter in the workspace.
  await machine.run(["rm", "-f", "--", temp]).catch(() => undefined);
  return false;
}
