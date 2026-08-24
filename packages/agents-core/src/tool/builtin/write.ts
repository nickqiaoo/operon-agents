import { dirname } from "node:path";
import { z } from "zod";
import { ToolAccesses } from "../access.ts";
import { defineTool } from "../define.ts";
import { FileExistsError, StaleFileError, type Machine, type FileInfo } from "../machine.ts";
import { checkFreshness, FILE_MODIFIED_MESSAGE, FILE_NOT_READ_MESSAGE, type FileFreshnessLedger } from "../file-freshness.ts";
import { fileVersionFromInfo, normalizeForCompare } from "../support/machine-ops.ts";
import { pathApproval, resolveToolPath } from "../support/tool-path.ts";
import type { ToolResolveContext, ToolResult, ToolRunContext } from "../types.ts";
import { detectLineEndingStyle, materializeModelText, type LineEndingStyle } from "./line-endings.ts";

const WriteInput = z.object({
  path: z
    .string()
    .describe(
      "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. The parent directory must already exist.",
    ),
  content: z
    .string()
    .describe(
      "Content to write. Overwrite writes this exactly as the full file content. Append adds this content to the end without inserting a newline.",
    ),
  mode: z
    .enum(["overwrite", "append"])
    .optional()
    .describe(
      "Write mode. Defaults to overwrite. append adds content to the end without adding a newline.",
    ),
});

type WriteInput = z.infer<typeof WriteInput>;

const WRITE_DESCRIPTION = [
  "Overwrite or append to a file, creating the file if needed; the parent directory must already exist. Defaults to overwrite; append adds content to the end without adding a newline. Write does not use the Read/Edit model text view and writes content exactly as provided — `\\n` stays LF, `\\r\\n` stays CRLF. The one exception: appending to a file whose existing lines are all CRLF writes your `\\n` as CRLF too, so the file stays consistent. Use Edit for targeted changes to existing files. When the content is very large, you can split it across multiple calls: write the first chunk with overwrite, then add the remaining chunks with append.",
  "",
  "For an existing file you must Read it first; Write fails otherwise. Overwrite replaces the ENTIRE file — whatever you did not read is replaced too, so prefer Edit for changing part of a file and keep Write for new files and complete rewrites. Reading the file in full (no paging) also lets Write tell a real concurrent change from a timestamp that merely moved. Creating a missing file does not require a prior Read.",
  "Never use Write to talk to the user — output text directly.",
].join("\n");

export const writeTool = defineTool({
  name: "Write",
  description: WRITE_DESCRIPTION,
  params: WriteInput,
  // Expose path + content so the judge can see what is being written (e.g. a curl|bash
  // payload, an SSH key), projected as `${file_path}: ${content}`.
  toAutoApprovalInput: (args) => `${args.path}: ${args.content}`,
  async resolve(args, ctx) {
    const path = await resolveToolPath(args.path, ctx.machine, "write");
    return {
      accesses: ToolAccesses.writeFile(path),
      display: { title: `Writing ${args.path}` },
      ...pathApproval("Write", ctx.machine, path),
      run: (runCtx) => execute(args, path, runCtx),
    };
  },
});

async function execute(args: WriteInput, safePath: string, ctx: ToolRunContext): Promise<ToolResult> {
  const machine = ctx.machine;
  const parentError = await checkParentDirectory(safePath, machine);
  if (parentError !== undefined) return errorResult(parentError);

  try {
    const mode = args.mode ?? "overwrite";
    const info = await statOrUndefined(machine, safePath);
    if (info !== undefined) await validateWrite(safePath, ctx);

    const ledger = ctx.fileLedger;
    const record = info !== undefined ? ledger?.get(safePath) : undefined;
    let nextContent = args.content;
    let writtenContent = args.content;

    if (mode === "append") {
      // Append composed from the core members: read-concat-write. Fine for the
      // tool's occasional appends; high-frequency log appends belong elsewhere.
      let prior = "";
      try {
        prior = (await machine.readBytes(safePath)).toString("utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const priorLineEndings = detectLineEndingStyle(prior);
      writtenContent =
        prior.length > 0 && priorLineEndings === "crlf"
          ? materializeModelText(args.content, priorLineEndings)
          : args.content;
      nextContent = prior + writtenContent;
    }

    const result = await machine.writeTextIfUnchanged(safePath, nextContent, {
      expected: info !== undefined ? record!.version : "must-not-exist",
      // Only a full read's content can be compared against the whole file; a paged
      // record's text would differ from it by definition and read as a conflict.
      ...(record?.fullRead === true && record.content !== undefined ? { expectedContent: record.content } : {}),
    });

    ledger?.recordWrite(safePath, result.version, {
      content: normalizeForCompare(nextContent),
      lineEndings: toLedgerLineEndings(detectLineEndingStyle(nextContent)),
      encoding: "utf8",
    });

    // Report UTF-8 bytes written; string length only equals byte count for pure ASCII.
    const bytesWritten = Buffer.byteLength(writtenContent, "utf8");
    return textResult(`${mode === "append" ? "Appended" : "Wrote"} ${String(bytesWritten)} bytes to ${args.path}`);
  } catch (error) {
    if (error instanceof StaleFileError || error instanceof FileExistsError) return errorResult(FILE_MODIFIED_MESSAGE);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      return errorResult(`Failed to write ${args.path}: parent directory does not exist.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function requireLedger(ctx: ToolResolveContext | ToolRunContext): FileFreshnessLedger {
  if (ctx.fileLedger === undefined) {
    throw new Error("File freshness tracking unavailable - cannot verify read-before-write safety for this session.");
  }
  return ctx.fileLedger;
}

async function statOrUndefined(machine: Machine, path: string): Promise<FileInfo | undefined> {
  try {
    return await machine.fileInfo(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function validateWrite(path: string, ctx: ToolResolveContext | ToolRunContext): Promise<void> {
  const info = await statOrUndefined(ctx.machine, path);
  if (info === undefined) return;

  const ledger = requireLedger(ctx);
  // "Has this agent seen the file", not "did it see all of it" — see the same gate in
  // edit.ts. Overwriting a file the model only paged through DOES discard the part it
  // never saw — an accepted trade, since the alternative locks Write out of every
  // file past the Read tool's caps.
  const record = ledger.get(path);
  if (record === undefined) throw new Error(FILE_NOT_READ_MESSAGE);

  const verdict = await checkFreshness({
    ledger,
    path,
    current: fileVersionFromInfo(info),
    currentContent: async () => {
      try {
        return normalizeForCompare((await ctx.machine.readBytes(path)).toString(record.encoding));
      } catch {
        return undefined;
      }
    },
  });
  if (verdict.kind === "not-read") throw new Error(FILE_NOT_READ_MESSAGE);
  if (verdict.kind === "stale") throw new Error(FILE_MODIFIED_MESSAGE);
}

function toLedgerLineEndings(style: LineEndingStyle): "LF" | "CRLF" | "mixed" {
  if (style === "crlf") return "CRLF";
  if (style === "mixed") return "mixed";
  return "LF";
}

async function checkParentDirectory(safePath: string, machine: Machine): Promise<string | undefined> {
  const parent = dirname(safePath);
  let info;
  try {
    info = await machine.fileInfo(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `Parent directory does not exist: ${parent}. Create it before writing this file.`;
    }
    return undefined;
  }
  if (info.kind !== "dir") {
    return `Parent path is not a directory: ${parent}.`;
  }
  return undefined;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
