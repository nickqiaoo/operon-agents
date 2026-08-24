import { z } from "zod";
import { ToolAccesses } from "../access.ts";
import { defineTool } from "../define.ts";
import { StaleFileError, type Machine, type FileInfo } from "../machine.ts";
import { checkFreshness, FILE_MODIFIED_MESSAGE, FILE_NOT_READ_MESSAGE, type FileFreshnessLedger } from "../file-freshness.ts";
import { fileVersionFromInfo, normalizeForCompare, readTextFile } from "../support/machine-ops.ts";
import { pathApproval, resolveToolPath } from "../support/tool-path.ts";
import type { ToolResolveContext, ToolResult, ToolRunContext } from "../types.ts";
import { materializeModelText, toModelTextView, type LineEndingStyle } from "./line-endings.ts";

// `old_string` must be non-empty: the non-replace_all branch walks occurrences with
// indexOf, which would loop forever on an empty search string.
const EditInput = z.object({
  path: z
    .string()
    .describe(
      "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.",
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.",
    ),
  new_string: z
    .string()
    .describe("Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Set true only when every occurrence of old_string should be replaced."),
});

type EditInput = z.infer<typeof EditInput>;

const EDIT_DESCRIPTION = [
  "Perform exact string replacements against the text view returned by Read.",
  "",
  "- When copying from Read output, omit the line-number prefix and tab; match only the file content.",
  "- By default, old_string must occur exactly once. If it matches multiple locations, add surrounding context or set replace_all when every occurrence should change.",
  "- Prefer Edit for targeted changes to existing files; use Write only for new files or complete overwrites.",
  "- To modify a file, always use Edit; do not run a Bash `sed` command for edits.",
  "- Read the file first so Edit can use the latest text view and verify the file has not changed before writing.",
  "- When making several independent changes, issue multiple Edit calls in parallel within a single response; edits to the same file are serialized automatically by a write lock.",
  "- When several parallel Edit calls target the same file, a write lock serializes them; they apply in the order the calls appear in your response. An edit fails with `old_string not found` if its old_string was taken from text an earlier edit already replaced — base every old_string on the latest Read view and order dependent edits accordingly.",
  "- For pure CRLF files, Read shows LF and Edit.old_string/new_string should use LF; Edit writes the file back with CRLF preserved.",
  "- For mixed line endings or lone carriage returns, Read displays carriage returns as \\r; include actual \\r escapes in old_string/new_string for those positions.",
].join("\n");

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

export const editTool = defineTool({
  name: "Edit",
  description: EDIT_DESCRIPTION,
  params: EditInput,
  // The replacement text is what lands in the file — that's the security-relevant part.
  toAutoApprovalInput: (args) => `${args.path}: ${args.new_string}`,
  async resolve(args, ctx) {
    const path = await resolveToolPath(args.path, ctx.machine, "write");
    return {
      accesses: ToolAccesses.readWriteFile(path),
      display: { title: `Editing ${args.path}`, before: args.old_string, after: args.new_string },
      ...pathApproval("Edit", ctx.machine, path),
      run: (runCtx) => execute(args, path, runCtx),
    };
  },
});

async function execute(args: EditInput, safePath: string, ctx: ToolRunContext): Promise<ToolResult> {
  const machine = ctx.machine;
  if (args.old_string === args.new_string) {
    return errorResult("No changes to make: old_string and new_string are exactly the same.");
  }

  try {
    await validateEdit(args, safePath, ctx);
    const raw = await readTextFile(machine, safePath);
    const modelView = toModelTextView(raw);
    const content = modelView.text;
    const replaceAll = args.replace_all ?? false;

    if (!replaceAll) {
      let count = 0;
      let pos = 0;
      while (pos < content.length) {
        const idx = content.indexOf(args.old_string, pos);
        if (idx === -1) break;
        count++;
        pos = idx + args.old_string.length;
      }

      if (count === 0) {
        return errorResult(
          `old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`,
        );
      }
      if (count > 1) {
        return errorResult(
          `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
            "To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.",
        );
      }

      const newContent = replaceOnceLiteral(content, args.old_string, args.new_string);
      await writeFreshText(ctx, safePath, materializeModelText(newContent, modelView.lineEndingStyle), modelView.lineEndingStyle);
      return textResult(`Replaced 1 occurrence in ${args.path}`);
    }

    const parts = content.split(args.old_string);
    const replacementCount = parts.length - 1;
    if (replacementCount === 0) {
      return errorResult(
        `old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`,
      );
    }

    const newContent = parts.join(args.new_string);
    await writeFreshText(ctx, safePath, materializeModelText(newContent, modelView.lineEndingStyle), modelView.lineEndingStyle);
    return textResult(`Replaced ${String(replacementCount)} occurrences in ${args.path}`);
  } catch (error) {
    if (error instanceof StaleFileError) return errorResult(FILE_MODIFIED_MESSAGE);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "EISDIR") {
      return errorResult(`${args.path} is not a file.`);
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

async function validateEdit(args: EditInput, path: string, ctx: ToolResolveContext | ToolRunContext): Promise<void> {
  if (args.old_string === args.new_string) {
    throw new Error("No changes to make: old_string and new_string are exactly the same.");
  }

  const ledger = requireLedger(ctx);
  // Read-before-write asks "has this agent seen the file", which any ledger record
  // answers. NOT `fullRead` — that says whether the RETAINED CONTENT is the whole
  // file, and gating on it locked Edit out of every file over the Read tool's line
  // or byte cap, with no way back in (a paged re-read is not a full read either).
  // Partial reads stay safe further down: the uniqueness check below runs against
  // the WHOLE file, so an old_string guessed from unseen text fails to match or
  // fails to be unique.
  const record = ledger.get(path);
  if (record === undefined) throw new Error(FILE_NOT_READ_MESSAGE);

  const raw = await readTextFile(ctx.machine, path);
  const info: FileInfo = await ctx.machine.fileInfo(path);
  const verdict = await checkFreshness({
    ledger,
    path,
    current: fileVersionFromInfo(info),
    currentContent: () => Promise.resolve(normalizeForCompare(raw)),
  });
  if (verdict.kind === "not-read") throw new Error(FILE_NOT_READ_MESSAGE);
  if (verdict.kind === "stale") throw new Error(FILE_MODIFIED_MESSAGE);

  const content = toModelTextView(raw).text;
  const replaceAll = args.replace_all ?? false;

  if (!replaceAll) {
    let count = 0;
    let pos = 0;
    while (pos < content.length) {
      const idx = content.indexOf(args.old_string, pos);
      if (idx === -1) break;
      count++;
      pos = idx + args.old_string.length;
    }
    if (count === 0) {
      throw new Error(`old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`);
    }
    if (count > 1) {
      throw new Error(
        `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
          "To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.",
      );
    }
    return;
  }

  if (!content.includes(args.old_string)) {
    throw new Error(`old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`);
  }
}

async function writeFreshText(
  ctx: ToolRunContext,
  path: string,
  materializedContent: string,
  lineEndingStyle: LineEndingStyle,
): Promise<void> {
  const ledger = requireLedger(ctx);
  const record = ledger.get(path);
  if (record === undefined) throw new Error(FILE_NOT_READ_MESSAGE);

  // `expectedContent` only rides along when the ledger kept the whole file — on a
  // partial read the CAS has the mtime and nothing else, so a moved mtime is a
  // conflict with no content review to overturn it.
  const result = await ctx.machine.writeTextIfUnchanged(path, materializedContent, {
    expected: record.version,
    ...(record.fullRead && record.content !== undefined ? { expectedContent: record.content } : {}),
  });

  ledger.recordWrite(path, result.version, {
    content: normalizeForCompare(materializedContent),
    lineEndings: toLedgerLineEndings(lineEndingStyle),
    encoding: "utf8",
  });
}

function toLedgerLineEndings(style: LineEndingStyle): "LF" | "CRLF" | "mixed" {
  if (style === "crlf") return "CRLF";
  if (style === "mixed") return "mixed";
  return "LF";
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
