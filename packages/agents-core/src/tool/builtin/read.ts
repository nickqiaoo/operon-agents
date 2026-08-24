import { z } from "zod";
import { ToolAccesses } from "../access.ts";
import { defineTool } from "../define.ts";
import { FILE_UNCHANGED_STUB } from "../file-freshness.ts";
import { detectFileType, MEDIA_SNIFF_BYTES } from "../support/file-type.ts";
import { compressImageForModel } from "../support/image-compress.ts";
import { fileVersionFromInfo, fileVersionsMatch, normalizeForCompare, readTextFile } from "../support/machine-ops.ts";
import { pathApproval, resolveToolPath } from "../support/tool-path.ts";
import type { FileInfo, LineEndings, Machine } from "../machine.ts";
import type { ToolResult, ToolRunContext } from "../types.ts";
import { makeCarriageReturnsVisible, type LineEndingStyle } from "./line-endings.ts";

/**
 * Ceiling on an EXPLICIT line request (`n_lines`, or a negative `line_offset`). Not a default
 * truncation: an unpaged read returns the whole file, bounded by the two limits below.
 *
 * A default that quietly served the first N lines was the worst of both worlds — the caller
 * asked for a file and got a prefix, and the ledger recorded a partial view, which is exactly
 * what disables the content-comparison fallback that the mtime-coarse backends depend on.
 */
export const MAX_LINES = 2000;
export const MAX_LINE_LENGTH = 2000;
/** Rendered-output ceiling. Past it the read is refused, never silently cut short. */
export const MAX_BYTES = 100 * 1024;
/**
 * Whole-file ceiling for an UNPAGED read (no `line_offset`/`n_lines`): past this the read is
 * refused instead of served truncated.
 *
 * Truncation is not the problem — the `<system>` footer says plainly how much was cut. The
 * cost is: a multi-megabyte file answers with `MAX_BYTES` of its opening, which is rarely
 * what the caller wanted and never cheap. Refusing costs a two-line error and leaves the
 * caller to page in, grep, or give up, all of which beat paying for a prefix nobody asked for.
 *
 * Only unpaged reads are gated. A caller that passed a range already said what it wants, and
 * gating that on the file's TOTAL size would refuse exactly the paging that is the way
 * out of this error.
 */
export const MAX_UNPAGED_FILE_BYTES = 256 * 1024;
const MAX_IMAGE_MEGABYTES = 100;
const MAX_IMAGE_BYTES = MAX_IMAGE_MEGABYTES * 1024 * 1024;

const PositiveLineOffset = z.number().int().min(1);
const TailLineOffset = z.number().int().min(-MAX_LINES).max(-1);

const ReadInput = z.object({
  path: z
    .string()
    .describe(
      "Path to a text or image file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search.",
    ),
  line_offset: z
    .union([PositiveLineOffset, TailLineOffset])
    .optional()
    .describe(
      `The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed ${String(MAX_LINES)}.`,
    ),
  n_lines: z
    .number()
    .int()
    .positive()
    .max(MAX_LINES)
    .optional()
    .describe(
      `The number of lines to read, at most ${String(MAX_LINES)}. Omit to read to the end of the file.`,
    ),
});

type ReadInput = z.infer<typeof ReadInput>;

const READ_DESCRIPTION = [
  "Read a text or image file from the local filesystem.",
  "",
  "If the user provides a concrete file path to a text or image file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use `ls` via Bash for a known directory, or Glob when you need files matching a pattern. Use `Grep` only when the task is to search for unknown content or locations.",
  "",
  "When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.",
  "",
  "- Relative paths resolve against the working directory; a path outside the working directory must be absolute.",
  "- Omitting `line_offset`/`n_lines` reads the WHOLE file — do that by default; you get the complete content and later edits are checked against it.",
  `- Two limits, and passing either is an error rather than a silent partial answer: a whole-file read needs the file under ${String(MAX_UNPAGED_FILE_BYTES / 1024)} KB, and any read must render under ${String(MAX_BYTES / 1024)} KB. Both errors say how to narrow the request.`,
  `- Page with \`line_offset\` (1-based start line) and \`n_lines\` (at most ${String(MAX_LINES)}) when a file is too big to read whole, or use Grep to locate the relevant part first.`,
  `- Lines longer than ${String(MAX_LINE_LENGTH)} chars are truncated mid-line; that is the one case where content is shortened rather than refused, and the \`<system>\` footer lists the affected line numbers.`,
  `- Supported image files return a <system> summary and image content directly; image files can be up to ${String(MAX_IMAGE_MEGABYTES)}MB.`,
  "- Only UTF-8 text files and supported image files can be read. Non-UTF-8 encodings, video files, other binary files, and files containing NUL bytes are refused; use Bash or an MCP tool for unsupported binary formats.",
  `- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed ${String(MAX_LINES)}.`,
  "- Text output format: `<line-number>\\t<content>` per line.",
  "- A `<system>...</system>` status block is appended after text file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.",
  "- Pure CRLF files are displayed with LF line endings; `Edit` and `Write`-append match this output and preserve CRLF when writing back.",
  "- Mixed or lone carriage-return line endings are shown as `\\r` and require exact `Edit.old_string` escapes.",
  "- For images, the `<system>` block summarizes the mime type, byte size and original pixel dimensions when available. When outputting coordinates, give relative coordinates first and compute absolute coordinates from the original image size. After generating or editing images via commands or scripts, read the result back before continuing.",
  "- If the same file range is read again and the file is unchanged, Read may return a `file unchanged` stub instead of repeating the content; use the earlier Read tool result in this conversation. Ask for a different range only when you need different content.",
  "- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.",
].join("\n");

interface LineEndingFlags {
  hasCrLf: boolean;
  hasLf: boolean;
  hasLoneCr: boolean;
}

interface ReadLineEntry {
  readonly lineNo: number;
  readonly rawContent: string;
}

interface RenderedLine {
  readonly line: string;
  readonly wasTruncated: boolean;
}

interface FinishReadResultInput {
  readonly renderedLines: readonly string[];
  readonly truncatedLineNumbers: readonly number[];
  readonly lineEndingStyle: LineEndingStyle;
  readonly startLine: number;
  readonly totalLines: number;
  readonly requestedLines: number;
}

interface ReadRangeKey {
  readonly lineOffset: number;
  readonly maxLines?: number;
}

interface ReadOutcome {
  readonly result: ToolResult;
  readonly fullRead: boolean;
  readonly lineEndings: LineEndings;
  readonly range: ReadRangeKey;
}

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) return line;
  const marker = "...";
  const target = Math.max(maxLength, marker.length);
  return line.slice(0, target - marker.length) + marker;
}

function stripTrailingLf(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function updateLineEndingFlags(flags: LineEndingFlags, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        flags.hasCrLf = true;
        i += 1;
      } else {
        flags.hasLoneCr = true;
      }
    } else if (code === 10) {
      flags.hasLf = true;
    }
  }
}

function lineEndingStyleFromFlags(flags: LineEndingFlags): LineEndingStyle {
  if (flags.hasLoneCr || (flags.hasCrLf && flags.hasLf)) return "mixed";
  if (flags.hasCrLf) return "crlf";
  return "lf";
}

function renderLine(entry: ReadLineEntry, lineEndingStyle: LineEndingStyle): RenderedLine {
  const modelContent =
    lineEndingStyle === "crlf" && entry.rawContent.endsWith("\r")
      ? entry.rawContent.slice(0, -1)
      : entry.rawContent;
  const truncated = truncateLine(modelContent, MAX_LINE_LENGTH);
  const renderedContent = lineEndingStyle === "mixed" ? makeCarriageReturnsVisible(truncated) : truncated;
  return {
    line: `${String(entry.lineNo)}\t${renderedContent}`,
    wasTruncated: truncated !== modelContent,
  };
}

function renderedLineBytes(renderedLine: string, isFirst: boolean): number {
  return (isFirst ? 0 : 1) + Buffer.byteLength(renderedLine, "utf8");
}

/** Whole-file line iteration (terminators included). */
function* readLinesStrict(text: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      yield text.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) yield text.slice(start);
}

function isFileNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown })["code"];
  return code === "ENOENT" || code === "ENOTDIR";
}

function isTextDecodeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown })["code"];
  if (code === "ERR_ENCODING_INVALID_ENCODED_DATA") return true;
  if (!(error instanceof Error)) return false;
  return /encoded data was not valid|invalid.*encoding|invalid.*utf-?8/i.test(error.message);
}

function containsNulByte(text: string): boolean {
  return text.includes("\u0000");
}

function notReadableFileOutput(path: string): string {
  return (
    `"${path}" is not readable as UTF-8 text. ` +
    "Only UTF-8 text files and supported image files can be read. " +
    "For video or other binary formats, use Bash or an MCP tool if available."
  );
}

function ok(output: string): ToolResult {
  return { content: [{ type: "text", text: output }] };
}

function err(output: string): ToolResult {
  return { content: [{ type: "text", text: output }], isError: true };
}

export const readTool = defineTool({
  name: "Read",
  description: READ_DESCRIPTION,
  params: ReadInput,
  async resolve(args, ctx) {
    const path = await resolveToolPath(args.path, ctx.machine, "read");
    return {
      accesses: ToolAccesses.readFile(path),
      display: { title: `Reading ${args.path}` },
      ...pathApproval("Read", ctx.machine, path),
      run: (runCtx) => execute(args, path, runCtx),
    };
  },
});

async function execute(args: ReadInput, safePath: string, ctx: ToolRunContext): Promise<ToolResult> {
  const machine = ctx.machine;
  try {
    let info: FileInfo;
    try {
      info = await machine.fileInfo(safePath);
    } catch (error) {
      if (isFileNotFoundError(error)) return err(`"${args.path}" does not exist.`);
      throw error;
    }
    if (info.kind !== "file") return err(`"${args.path}" is not a file.`);

    const header = await machine.readBytes(safePath, { length: MEDIA_SNIFF_BYTES });
    const fileType = detectFileType(safePath, header);
    if (fileType.kind === "image") return readImageFile(args, safePath, info, machine, fileType.mimeType);
    if (fileType.kind === "unknown") return err(notReadableFileOutput(args.path));

    const lineOffset = args.line_offset ?? 1;
    // No `n_lines` means to the end of the file — the byte ceiling is what bounds it.
    const requestedLines = args.n_lines ?? Number.POSITIVE_INFINITY;
    const range = rangeKeyForArgs(args);

    const record = ctx.fileLedger?.get(safePath);
    if (record?.range && rangesEqual(record.range, range)) {
      const current = fileVersionFromInfo(info);
      if (fileVersionsMatch(record.version, current)) return ok(FILE_UNCHANGED_STUB);
    }

    // After the dedup stub: an unchanged file answers for free no matter how large it is.
    if (args.line_offset === undefined && args.n_lines === undefined && info.size > MAX_UNPAGED_FILE_BYTES) {
      return err(
        `"${args.path}" is ${String(Math.round(info.size / 1024))} KB, over the ${String(MAX_UNPAGED_FILE_BYTES / 1024)} KB limit for reading a whole file at once. ` +
          "Read a range with `line_offset` (and `n_lines`), or use Grep to find the relevant part first.",
      );
    }

    const rawText = await readTextFile(machine, safePath, { errors: "strict" });

    const outcome =
      lineOffset < 0
        ? readTail(rawText, args.path, lineOffset, requestedLines, range)
        : readForward(rawText, args.path, lineOffset, requestedLines, range);

    if (outcome.result.isError !== true) {
      ctx.fileLedger?.recordRead(safePath, {
        version: fileVersionFromInfo(info),
        ...(outcome.fullRead ? { content: normalizeForCompare(rawText) } : {}),
        fullRead: outcome.fullRead,
        range: outcome.range,
        lineEndings: outcome.lineEndings,
        encoding: "utf8",
        readAt: Date.now(),
      });
    }

    return outcome.result;
  } catch (error) {
    if (isTextDecodeError(error)) return err(notReadableFileOutput(args.path));
    return err(error instanceof Error ? error.message : String(error));
  }
}

async function readImageFile(
  args: ReadInput,
  safePath: string,
  info: FileInfo,
  machine: Machine,
  mimeType: string,
): Promise<ToolResult> {
  if (args.line_offset !== undefined || args.n_lines !== undefined) {
    return err("line_offset and n_lines are only supported for text files.");
  }
  if (info.size === 0) return err(`"${args.path}" is empty.`);
  if (info.size > MAX_IMAGE_BYTES) {
    return err(
      `"${args.path}" is ${String(info.size)} bytes, which exceeds the maximum ${String(
        MAX_IMAGE_MEGABYTES,
      )}MB for image files.`,
    );
  }

  const data = await machine.readBytes(safePath);
  // Downsample/re-encode oversized images before sending to the model (best
  // effort; the original bytes are returned unchanged on any failure).
  const compressed = await compressImageForModel(data, mimeType);
  const sniffed = sniffImageDimensions(data);
  const originalDimensions = compressed.changed
    ? { width: compressed.originalWidth, height: compressed.originalHeight }
    : sniffed;
  const systemText = buildImageSystemSummary({
    mimeType: compressed.mimeType,
    byteSize: info.size,
    originalDimensions: originalDimensions && originalDimensions.width > 0 ? originalDimensions : null,
    compression: compressed.changed
      ? {
          width: compressed.width,
          height: compressed.height,
          byteSize: compressed.finalByteLength,
          mimeType: compressed.mimeType,
        }
      : null,
  });

  const imageData = Buffer.isBuffer(compressed.data)
    ? compressed.data.toString("base64")
    : Buffer.from(compressed.data).toString("base64");

  return {
    content: [
      { type: "text", text: systemText },
      { type: "text", text: `<image path="${safePath}">` },
      { type: "image", data: imageData, mimeType: compressed.mimeType },
      { type: "text", text: "</image>" },
    ],
  };
}

function buildImageSystemSummary(input: {
  readonly mimeType: string;
  readonly byteSize: number;
  readonly originalDimensions: { readonly width: number; readonly height: number } | null;
  readonly compression: {
    readonly width: number;
    readonly height: number;
    readonly byteSize: number;
    readonly mimeType: string;
  } | null;
}): string {
  const parts = [`Read image file.`];
  if (input.compression) {
    // A downsampled copy is being sent; be explicit so the model does not treat
    // the reduced resolution as the source of truth.
    parts.push(
      `Mime type: ${input.compression.mimeType}.`,
      `Size: ${String(input.compression.byteSize)} bytes (compressed from ${String(input.byteSize)} bytes).`,
    );
    if (input.originalDimensions) {
      parts.push(
        `Original dimensions: ${String(input.originalDimensions.width)}x${String(input.originalDimensions.height)} pixels.`,
        `This image was downsampled to ${String(input.compression.width)}x${String(input.compression.height)} pixels before sending. If you need finer detail, read a specific region with a tool that supports it, or ask for the original.`,
        "If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size.",
      );
    }
  } else {
    parts.push(`Mime type: ${input.mimeType}.`, `Size: ${String(input.byteSize)} bytes.`);
    if (input.originalDimensions) {
      parts.push(
        `Original dimensions: ${String(input.originalDimensions.width)}x${String(input.originalDimensions.height)} pixels.`,
        "If you need to output coordinates, output relative coordinates first and compute absolute coordinates using the original image size.",
      );
    }
  }
  parts.push("If you generate or edit images via commands or scripts, read the result back immediately before continuing.");
  return `<system>${parts.join(" ")}</system>`;
}

function sniffImageDimensions(data: Buffer): { readonly width: number; readonly height: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && (data.subarray(0, 6).toString("latin1") === "GIF87a" || data.subarray(0, 6).toString("latin1") === "GIF89a")) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (data.length >= 26 && data.subarray(0, 2).toString("latin1") === "BM") {
    return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  }
  return sniffJpegDimensions(data);
}

function sniffJpegDimensions(data: Buffer): { readonly width: number; readonly height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (isJpegStartOfFrame(marker) && length >= 7) {
      return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function rangeKeyForArgs(args: ReadInput): ReadRangeKey {
  const lineOffset = args.line_offset ?? 1;
  return {
    lineOffset: lineOffset < 0 ? lineOffset : lineOffset - 1,
    ...(args.n_lines !== undefined ? { maxLines: args.n_lines } : {}),
  };
}

function rangesEqual(a: ReadRangeKey, b: ReadRangeKey): boolean {
  return a.lineOffset === b.lineOffset && a.maxLines === b.maxLines;
}

function toLedgerLineEndings(style: LineEndingStyle): LineEndings {
  if (style === "crlf") return "CRLF";
  if (style === "mixed") return "mixed";
  return "LF";
}

function errorOutcome(result: ToolResult, range: ReadRangeKey): ReadOutcome {
  return { result, fullRead: false, lineEndings: "LF", range };
}

/**
 * Refusal for a range whose rendered output does not fit. It names how many lines DID fit, so
 * the retry is a single obvious call (`n_lines` at or under that) rather than a guess.
 */
function outputTooLargeOutcome(displayPath: string, startLine: number, linesThatFit: number, range: ReadRangeKey): ReadOutcome {
  const suggestion =
    linesThatFit > 0
      ? `About ${String(linesThatFit)} lines from line ${String(startLine)} fit — retry with \`n_lines\` at or below that`
      : "Even a single line of this range exceeds the limit";
  return errorOutcome(
    err(
      `Reading "${displayPath}" from line ${String(startLine)} produces more than ${String(MAX_BYTES / 1024)} KB of output. ` +
        `${suggestion}, or narrow the search with Grep.`,
    ),
    range,
  );
}

function readForward(
  text: string,
  displayPath: string,
  lineOffset: number,
  limit: number,
  range: ReadRangeKey,
): ReadOutcome {
  const selectedEntries: ReadLineEntry[] = [];
  const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
  let currentLineNo = 0;

  // The whole file is walked even once `limit` is met: `totalLines` in the footer is the
  // file's real length, not how far the read happened to get.
  for (const rawLine of readLinesStrict(text)) {
    if (containsNulByte(rawLine)) return errorOutcome(err(notReadableFileOutput(displayPath)), range);
    currentLineNo += 1;
    updateLineEndingFlags(flags, rawLine);
    if (currentLineNo < lineOffset || selectedEntries.length >= limit) continue;
    selectedEntries.push({ lineNo: currentLineNo, rawContent: stripTrailingLf(rawLine) });
  }

  const lineEndingStyle = lineEndingStyleFromFlags(flags);
  const renderedLines: string[] = [];
  const truncatedLineNumbers: number[] = [];
  let bytes = 0;

  for (const entry of selectedEntries) {
    const rendered = renderLine(entry, lineEndingStyle);
    const lineBytes = renderedLineBytes(rendered.line, renderedLines.length === 0);
    if (bytes + lineBytes > MAX_BYTES) {
      return outputTooLargeOutcome(displayPath, lineOffset, renderedLines.length, range);
    }
    if (rendered.wasTruncated) truncatedLineNumbers.push(entry.lineNo);
    renderedLines.push(rendered.line);
    bytes += lineBytes;
  }

  const result = finishReadResult({
    renderedLines,
    truncatedLineNumbers,
    lineEndingStyle,
    startLine: renderedLines.length > 0 ? lineOffset : 0,
    totalLines: currentLineNo,
    requestedLines: limit,
  });
  return {
    result,
    // Every line of the file, none of them cut short. Reaching a limit no longer produces a
    // result at all, so the only ways to fall short here are an offset past line 1 or an
    // over-long line that had to be clipped.
    fullRead: lineOffset === 1 && truncatedLineNumbers.length === 0 && renderedLines.length === currentLineNo,
    lineEndings: toLedgerLineEndings(lineEndingStyle),
    range,
  };
}

function readTail(
  text: string,
  displayPath: string,
  lineOffset: number,
  limit: number,
  range: ReadRangeKey,
): ReadOutcome {
  const tailCount = Math.abs(lineOffset);
  const entries: ReadLineEntry[] = [];
  const flags: LineEndingFlags = { hasCrLf: false, hasLf: false, hasLoneCr: false };
  let currentLineNo = 0;

  for (const rawLine of readLinesStrict(text)) {
    if (containsNulByte(rawLine)) return errorOutcome(err(notReadableFileOutput(displayPath)), range);
    currentLineNo += 1;
    updateLineEndingFlags(flags, rawLine);
    entries.push({ lineNo: currentLineNo, rawContent: stripTrailingLf(rawLine) });
    if (entries.length > tailCount) entries.shift();
  }

  const lineEndingStyle = lineEndingStyleFromFlags(flags);
  const renderedCandidates = entries.slice(0, limit).map((entry) => ({
    entry,
    rendered: renderLine(entry, lineEndingStyle),
  }));

  const renderedLines: string[] = [];
  const truncatedLineNumbers: number[] = [];
  let bytes = 0;
  for (const [index, candidate] of renderedCandidates.entries()) {
    const lineBytes = renderedLineBytes(candidate.rendered.line, index === 0);
    if (bytes + lineBytes > MAX_BYTES) {
      // A tail read that does not fit is refused like any other range. Silently keeping the
      // last N that fit would answer "the last 500 lines" with some other number of lines.
      return outputTooLargeOutcome(displayPath, candidate.entry.lineNo, renderedLines.length, range);
    }
    renderedLines.push(candidate.rendered.line);
    if (candidate.rendered.wasTruncated) truncatedLineNumbers.push(candidate.entry.lineNo);
    bytes += lineBytes;
  }

  const result = finishReadResult({
    renderedLines,
    truncatedLineNumbers,
    lineEndingStyle,
    startLine: renderedCandidates[0]?.entry.lineNo ?? 0,
    totalLines: currentLineNo,
    requestedLines: limit,
  });
  return {
    result,
    fullRead: false,
    lineEndings: toLedgerLineEndings(lineEndingStyle),
    range,
  };
}

function finishReadResult(input: FinishReadResultInput): ToolResult {
  return ok(finishOutput(input.renderedLines, finishMessage(input)));
}

function finishOutput(renderedLines: readonly string[], message: string): string {
  const rendered = renderedLines.join("\n");
  const status = `<system>${message}</system>`;
  return rendered.length > 0 ? `${rendered}\n${status}` : status;
}

function finishMessage(input: FinishReadResultInput): string {
  const lineCount = input.renderedLines.length;
  const lineWord = lineCount === 1 ? "line" : "lines";
  const parts =
    lineCount > 0
      ? [`${String(lineCount)} ${lineWord} read from file starting from line ${String(input.startLine)}.`]
      : ["No lines read from file."];

  parts.push(`Total lines in file: ${String(input.totalLines)}.`);
  // Fewer lines than asked for can only mean the file ran out — a limit reached mid-range is
  // now a refusal, so no result ever carries a silent shortfall.
  if (lineCount < input.requestedLines) parts.push("End of file reached.");
  if (input.truncatedLineNumbers.length > 0) {
    parts.push(`Lines [${input.truncatedLineNumbers.join(", ")}] were truncated.`);
  }
  if (input.lineEndingStyle === "mixed") {
    parts.push(
      "Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.",
    );
  }
  return parts.join(" ");
}
