import { z } from "zod";
import { ToolAccesses } from "../access.ts";
import { defineTool } from "../define.ts";
import { StaleFileError, type FileInfo } from "../machine.ts";
import { checkFreshness, FILE_MODIFIED_MESSAGE, FILE_NOT_READ_MESSAGE, type FileFreshnessLedger } from "../file-freshness.ts";
import { fileVersionFromInfo, hashFileContent, normalizeForCompare, readTextFile } from "../support/machine-ops.ts";
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
  "- If the file changed on disk after your Read (a formatter, a script, the user) but old_string still matches exactly once, the edit applies and the result says the file holds other changes; otherwise Edit asks you to Read again. replace_all edits always require a fresh Read.",
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
      display: { title: `Editing ${args.path}`, path: args.path, before: args.old_string, after: args.new_string },
      ...pathApproval("Edit", ctx.machine, path),
      run: (runCtx) => execute(args, path, runCtx),
    };
  },
});

async function execute(args: EditInput, safePath: string, ctx: ToolRunContext): Promise<ToolResult> {
  if (args.old_string === args.new_string) {
    return errorResult("No changes to make: old_string and new_string are exactly the same.");
  }

  try {
    const ledger = requireLedger(ctx);
    // Read-before-write asks "has this agent seen the file", which any ledger record
    // answers. NOT `fullRead` — that says whether the digest covers the whole file, and
    // gating on it locked Edit out of every file over the Read tool's line or byte cap,
    // with no way back in (a paged re-read is not a full read either). Partial reads stay
    // safe below: uniqueness is checked against the WHOLE file, so an old_string guessed
    // from unseen text fails to match or fails to be unique.
    if (ledger.get(safePath) === undefined) return errorResult(FILE_NOT_READ_MESSAGE);

    // Stat BEFORE reading: a change landing between the two then leaves the version
    // older than the text, so the CAS below catches it instead of blessing it.
    const info: FileInfo = await ctx.machine.fileInfo(safePath);
    const observed = fileVersionFromInfo(info);
    const raw = await readTextFile(ctx.machine, safePath);
    const normalized = normalizeForCompare(raw);
    const verdict = await checkFreshness({
      ledger,
      path: safePath,
      current: observed,
      currentContent: () => Promise.resolve(normalized),
    });
    if (verdict.kind === "not-read") return errorResult(FILE_NOT_READ_MESSAGE);
    const stale = verdict.kind === "stale";

    const modelView = toModelTextView(raw);
    const content = modelView.text;
    const replaceAll = args.replace_all ?? false;
    const count = countOccurrences(content, args.old_string);

    // Changed since read, yet the edit still lands on exactly one place: apply it
    // against the file as it is NOW and say so, rather than make the model re-read a
    // file a formatter merely touched elsewhere. Anything short of one unambiguous
    // match — including every replace_all, which would rewrite occurrences the model
    // never saw — goes back for a Read.
    if (stale && (replaceAll || count !== 1)) return errorResult(FILE_MODIFIED_MESSAGE);

    if (count === 0) {
      return errorResult(
        `old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.\n`,
      );
    }
    if (!replaceAll && count > 1) {
      return errorResult(
        `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
          "To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.",
      );
    }

    const newContent = replaceAll
      ? content.split(args.old_string).join(args.new_string)
      : replaceOnceLiteral(content, args.old_string, args.new_string);
    const materialized = materializeModelText(newContent, modelView.lineEndingStyle);

    // The CAS guards the gap between THIS read and the write, so it expects what was
    // just observed — not the ledger's record, which a recovered edit is by definition
    // past.
    const result = await ctx.machine.writeTextIfUnchanged(safePath, materialized, {
      expected: observed,
      expectedContentHash: hashFileContent(normalized),
    });
    ledger.recordWrite(safePath, result.version, {
      content: normalizeForCompare(materialized),
      lineEndings: toLedgerLineEndings(modelView.lineEndingStyle),
      encoding: "utf8",
    });

    const summary = replaceAll
      ? `Replaced ${String(count)} occurrences in ${args.path}`
      : `Replaced 1 occurrence in ${args.path}`;
    return textResult(stale ? `${summary}${STALE_RECOVERED_NOTE}` : summary);
  } catch (error) {
    if (error instanceof StaleFileError) return errorResult(FILE_MODIFIED_MESSAGE);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "EISDIR") {
      return errorResult(`${args.path} is not a file.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

const STALE_RECOVERED_NOTE =
  " (note: the file had been modified on disk since you last read it — the edit applied cleanly, but the file contains other changes not in your context. Read it again before relying on the rest of its content.)";

/** Non-overlapping occurrences of `needle` — the same ones `split` replaces. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (pos < haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

function requireLedger(ctx: ToolResolveContext | ToolRunContext): FileFreshnessLedger {
  if (ctx.fileLedger === undefined) {
    throw new Error("File freshness tracking unavailable - cannot verify read-before-write safety for this session.");
  }
  return ctx.fileLedger;
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
