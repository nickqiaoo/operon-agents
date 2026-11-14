import { dirname } from "node:path";
import { z } from "zod";
import { ToolAccesses } from "../access.ts";
import { defineTool } from "../define.ts";
import type { Environment } from "../environment.ts";
import { writeTextFile } from "../support/environment-ops.ts";
import { pathApproval, resolveToolPath } from "../support/tool-path.ts";
import type { ToolResult, ToolRunContext } from "../types.ts";
import { detectLineEndingStyle, materializeModelText } from "./line-endings.ts";

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
  "Overwrite replaces the ENTIRE existing file — know what is in it before overwriting, prefer Edit for changing part of a file, and keep Write for new files and complete rewrites.",
  "Never use Write to talk to the user — output text directly.",
].join("\n");

export const writeTool = defineTool({
  name: "Write",
  description: WRITE_DESCRIPTION,
  parameters: WriteInput,
  // Expose path + content so the judge can see what is being written (e.g. a curl|bash
  // payload, an SSH key), projected as `${file_path}: ${content}`.
  toAutoApprovalInput: (args) => `${args.path}: ${args.content}`,
  async resolve(args, ctx) {
    const path = await resolveToolPath(args.path, ctx.environment, "write");
    return {
      accesses: ToolAccesses.writeFile(path),
      display: { title: `Writing ${args.path}`, path: args.path, content: args.content },
      ...pathApproval("Write", ctx.environment, path),
      run: (runCtx) => execute(args, path, runCtx),
    };
  },
});

async function execute(args: WriteInput, safePath: string, ctx: ToolRunContext): Promise<ToolResult> {
  const environment = ctx.environment;
  try {
    const mode = args.mode ?? "overwrite";

    let nextContent = args.content;
    let writtenContent = args.content;

    if (mode === "append") {
      // Append composed from the core members: read-concat-write. Fine for the
      // tool's occasional appends; high-frequency log appends belong elsewhere.
      let prior = "";
      try {
        prior = (await environment.files.read(safePath)).toString("utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      const priorLineEndings = detectLineEndingStyle(prior);
      writtenContent =
        prior.length > 0 && priorLineEndings === "crlf"
          ? materializeModelText(args.content, priorLineEndings)
          : args.content;
      nextContent = prior + writtenContent;
    }

    // No read-before-write gate: whether the model has seen the file (through Read, Bash
    // or anything else) is its call, not a ledger's. And no stat up front either: the write
    // itself reports a missing parent, so the parent is only inspected on that failure —
    // one round trip per Write on a remote backend instead of two.
    await writeTextFile(environment, safePath, nextContent);

    // Report UTF-8 bytes written; string length only equals byte count for pure ASCII.
    const bytesWritten = Buffer.byteLength(writtenContent, "utf8");
    return textResult(`${mode === "append" ? "Appended" : "Wrote"} ${String(bytesWritten)} bytes to ${args.path}`);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EEXIST") {
      const parentError = await checkParentDirectory(safePath, environment);
      return errorResult(parentError ?? `Failed to write ${args.path}: parent directory does not exist.`);
    }
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

async function checkParentDirectory(safePath: string, environment: Environment): Promise<string | undefined> {
  const parent = dirname(safePath);
  let info;
  try {
    info = await environment.files.getInfo(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
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
