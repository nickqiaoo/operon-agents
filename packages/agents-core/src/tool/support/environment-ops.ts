/**
 * Text on top of the Environment's byte I/O.
 *
 * Environment speaks bytes only (`readBytes` / `writeBytes`); decoding, encoding and
 * line endings are the same on every backend, so they live here once instead of in each
 * backend.
 */
import type { DecodeErrors, Environment } from "../environment.ts";
import { materializeModelText } from "../builtin/line-endings.ts";

/** Decode with the shared contract: strict UTF-8 throws on invalid bytes (binary detection). */
export function decodeText(data: Buffer, options?: { encoding?: BufferEncoding; errors?: DecodeErrors }): string {
  const encoding = options?.encoding ?? "utf8";
  const errors = options?.errors ?? "strict";
  if ((encoding === "utf8" || encoding === "utf-8") && errors === "strict") {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  }
  return data.toString(encoding);
}

/** Whole-file text read: `readBytes` + {@link decodeText} (strict UTF-8 by default). */
export async function readTextFile(
  environment: Pick<Environment, "readBytes">,
  path: string,
  options?: { encoding?: BufferEncoding; errors?: DecodeErrors },
): Promise<string> {
  return decodeText(await environment.readBytes(path), options);
}

export interface WriteTextFileOptions {
  /**
   * Line endings to write. Default `"LF"`: the text is written exactly as given.
   *
   * `"CRLF"` normalizes to LF first and then joins, so text that ALREADY contains `\r\n` —
   * which model output routinely does, having just read a CRLF file — comes out with `\r\n`
   * rather than `\r\r\n`. Same two-step as the Edit path, so the two never disagree about
   * what "write this as CRLF" means.
   */
  readonly lineEndings?: "LF" | "CRLF";
}

/** Unconditional whole-file UTF-8 write: encode, then `writeBytes`. */
export async function writeTextFile(
  environment: Pick<Environment, "writeBytes">,
  path: string,
  text: string,
  options: WriteTextFileOptions = {},
): Promise<void> {
  const payload = options.lineEndings === "CRLF" ? materializeModelText(text, "crlf") : text;
  await environment.writeBytes(path, Buffer.from(payload, "utf8"));
}
