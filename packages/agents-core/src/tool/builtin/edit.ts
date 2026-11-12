import { z } from "zod";
import { ToolAccesses } from "../access.ts";
import { defineTool } from "../define.ts";
import { readTextFile, writeTextFile } from "../support/environment-ops.ts";
import { pathApproval, resolveToolPath } from "../support/tool-path.ts";
import type { ToolResult, ToolRunContext } from "../types.ts";
import { materializeModelText, toModelTextView } from "./line-endings.ts";

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
  "- old_string is matched against the file as it is on disk now. If it is not found, the file has likely changed since you last saw it — look at the current content again before retrying.",
  "- When making several independent changes, issue multiple Edit calls in parallel within a single response; edits to the same file are serialized automatically.",
  "- When several parallel Edit calls target the same file, they are serialized and apply in the order the calls appear in your response. An edit fails with `old_string not found` if its old_string was taken from text an earlier edit already replaced — base every old_string on the latest Read view and order dependent edits accordingly.",
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
  parameters: EditInput,
  // The replacement text is what lands in the file — that's the security-relevant part.
  toAutoApprovalInput: (args) => `${args.path}: ${args.new_string}`,
  async resolve(args, ctx) {
    const path = await resolveToolPath(args.path, ctx.environment, "write");
    return {
      accesses: ToolAccesses.readWriteFile(path),
      display: { title: `Editing ${args.path}`, path: args.path, before: args.old_string, after: args.new_string },
      ...pathApproval("Edit", ctx.environment, path),
      run: (runCtx) => execute(args, path, runCtx),
    };
  },
});

async function execute(args: EditInput, safePath: string, ctx: ToolRunContext): Promise<ToolResult> {
  if (args.old_string === args.new_string) {
    return errorResult("No changes to make: old_string and new_string are exactly the same.");
  }

  try {
    // No read-before-edit gate: the model may have seen the file through Read, Bash, Grep
    // or an earlier edit, and old_string itself is the proof — it is matched against the
    // file as it is NOW, so text guessed or remembered from an outdated view fails to
    // match (or to be unique) instead of landing somewhere unintended.
    const raw = await readTextFile(ctx.environment, safePath);
    const modelView = toModelTextView(raw);
    const content = modelView.text;
    const replaceAll = args.replace_all ?? false;
    const count = countOccurrences(content, args.old_string);

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

    // Unconditional: an external writer landing between the read above and this write is
    // not detected — Environment deliberately has no compare-and-swap write (see its docs).
    await writeTextFile(ctx.environment, safePath, materialized);

    return textResult(
      replaceAll ? `Replaced ${String(count)} occurrences in ${args.path}` : `Replaced 1 occurrence in ${args.path}`,
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "EISDIR") {
      return errorResult(`${args.path} is not a file.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

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

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
