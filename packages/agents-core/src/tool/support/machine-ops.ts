/**
 * Shared building blocks for Machine implementations and their callers.
 *
 * The high-level operations (writeTextIfUnchanged / realpath) are mandatory
 * Machine members; their default compositions live in BaseMachine
 * (machine-base.ts). This module carries what both sides agree on: FileVersion
 * helpers, the decode contract, and the caller-side text-file helpers
 * (readTextFile / writeTextFile) composed from the core members.
 */
import { createHash } from "node:crypto";
import type {
  DecodeErrors,
  Machine,
  FileInfo,
  FileVersion,
} from "../machine.ts";

export function fileVersionFromInfo(info: FileInfo): FileVersion {
  return info.mtimeMs === undefined ? {} : { mtimeMs: info.mtimeMs };
}


/** Strip a UTF BOM and normalize CRLF to LF — the form ledger content comparisons use. */
export function normalizeForCompare(text: string): string {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return stripped.replaceAll("\r\n", "\n");
}

/**
 * Digest of a `normalizeForCompare`d text — what the ledger retains and the CAS
 * compares instead of the text itself. Keeps a record's footprint constant no matter
 * how large the file is. It is a content-review key, never the freshness criterion:
 * the mtime still decides whenever both sides have one.
 */
export function hashFileContent(normalizedText: string): string {
  return createHash("sha256").update(normalizedText, "utf8").digest("base64url");
}

/**
 * Both sides must HAVE an mtime and agree on it. A missing mtime is never a match:
 * it is the absence of evidence, and the caller's next move is a content review,
 * not a pass.
 */
export function fileVersionsMatch(expected: FileVersion, current: FileVersion): boolean {
  return expected.mtimeMs !== undefined && current.mtimeMs !== undefined && expected.mtimeMs === current.mtimeMs;
}


/** Decode with the shared contract: strict UTF-8 throws on invalid bytes (binary detection). */
export function decodeText(data: Buffer, options?: { encoding?: BufferEncoding; errors?: DecodeErrors }): string {
  const encoding = options?.encoding ?? "utf8";
  const errors = options?.errors ?? "strict";
  if ((encoding === "utf8" || encoding === "utf-8") && errors === "strict") {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  }
  return data.toString(encoding);
}

/** Whole-file text read composed from the core members (readBytes + decode). */
export async function readTextFile(
  host: Pick<Machine, "readBytes">,
  path: string,
  options?: { encoding?: BufferEncoding; errors?: DecodeErrors },
): Promise<string> {
  return decodeText(await host.readBytes(path), options);
}

/** Unconditional whole-file text write — thin sugar over Machine.writeText. */
export async function writeTextFile(
  host: Pick<Machine, "writeText">,
  path: string,
  data: string,
  options?: { encoding?: BufferEncoding },
): Promise<void> {
  await host.writeText(path, data, options?.encoding !== undefined ? { encoding: options.encoding } : {});
}

