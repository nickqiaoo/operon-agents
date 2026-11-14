/**
 * E2E for builtin filesystem safety: Read ranges and size ceilings, Edit's
 * old_string matching against the file as it is on disk (there is no
 * read-before-write gate — old_string is the proof of what the model saw),
 * Write's line-ending handling, and Bash permission rules' conservative
 * compound-command matching.
 */
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  bashTool,
  editTool,
  LocalEnvironment,
  readTool,
  writeTool,
  type ByteRange,
  type FileInfo,
  type Tool,
  type ToolResult,
} from "../index.ts";
import { matchesBashRule } from "../internal.ts";
import { MAX_UNPAGED_FILE_BYTES } from "../tool/builtin/read.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, okFlag: boolean): void {
  checks.push([label, okFlag]);
  console.log(`${okFlag ? "PASS" : "FAIL"} ${label}`);
}

function makeCtx(host: LocalEnvironment) {
  return {
    turnId: "t1",
    toolCallId: "c1",
    signal: new AbortController().signal,
    environment: host,
  };
}

async function runTool(tool: Tool, args: unknown, ctx: ReturnType<typeof makeCtx>): Promise<ToolResult> {
  const plan = await tool.resolve(args, ctx);
  return await plan.run(ctx as Parameters<typeof plan.run>[0]);
}

function text(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operon-filesystem-safety-"));
  const host = new LocalEnvironment(dir);
  const ctx = makeCtx(host);

  try {
    const notes = path.join(dir, "notes.txt");
    await writeFile(notes, "alpha\nbeta\ngamma\n");

    const r1 = await runTool(readTool, { path: notes }, ctx);
    check("read: line-numbered output", text(r1).includes("1\talpha") && text(r1).includes("3\tgamma"));

    const partial = await runTool(readTool, { path: notes, n_lines: 1 }, ctx);
    check("read: partial output", text(partial).includes("1\talpha") && !text(partial).includes("2\tbeta"));

    const lineOffsetSchema = (readTool.schema.parameters as { properties: Record<string, Record<string, unknown>> }).properties.line_offset;
    check("read: line_offset is one integer, not anyOf", lineOffsetSchema?.type === "integer" && lineOffsetSchema.anyOf === undefined);
    const stringified = await runTool(readTool, { path: notes, line_offset: "2", n_lines: "1" }, ctx);
    check("read: integer strings are accepted", text(stringified).includes("2\tbeta") && !text(stringified).includes("3\tgamma"));
    const stringTail = await runTool(readTool, { path: notes, line_offset: "-1" }, ctx);
    check("read: a negative integer string reads the tail", text(stringTail).includes("3\tgamma") && !text(stringTail).includes("2\tbeta"));
    const rejected = await Promise.all(
      [{ line_offset: 0 }, { line_offset: "abc" }, { line_offset: "1.5" }, { n_lines: "0" }, { line_offset: -2001 }].map((bad) =>
        runTool(readTool, { path: notes, ...bad }, ctx).then(() => false, () => true),
      ),
    );
    check("read: invalid line ranges are still refused", rejected.every(Boolean));

    // No dedup stub: after a context compaction the earlier Read result may be gone, so a
    // repeat Read must always serve the content itself.
    const repeat = await runTool(readTool, { path: notes }, ctx);
    check("read: a repeat read serves the content again", text(repeat).includes("1\talpha") && text(repeat).includes("3\tgamma"));

    // ── No read-before-write gate: the model may have seen the file through Bash, Grep or an
    //    earlier turn. Edit's old_string is the proof — it must match the file on disk. ────
    {
      const existing = path.join(dir, "existing.txt");
      await writeFile(existing, "old\n");
      const writeUnread = await runTool(writeTool, { path: existing, content: "new\n" }, ctx);
      check("write: an existing file can be overwritten without a prior Read", !writeUnread.isError && readFileSync(existing, "utf8") === "new\n");

      const code = path.join(dir, "code.ts");
      await writeFile(code, "const a = 1;\nconst b = 1;\n");
      const editUnread = await runTool(editTool, { path: code, old_string: "const a = 1;", new_string: "const a = 9;" }, ctx);
      check("edit: an existing file can be edited without a prior Read", !editUnread.isError && readFileSync(code, "utf8").includes("const a = 9;"));

      const multi = await runTool(editTool, { path: code, old_string: "const ", new_string: "let " }, ctx);
      check("edit: uniqueness guard still runs", multi.isError === true && text(multi).includes("not unique"));

      const missing = await runTool(editTool, { path: code, old_string: "const c = 1;", new_string: "x" }, ctx);
      check("edit: an old_string absent from the file is refused", missing.isError === true && text(missing).includes("not found"));
    }

    // ── An external change between the model's view and its edit: old_string is matched
    //    against the file as it is NOW, so the edit lands only where it still applies. ──
    {
      const changed = path.join(dir, "changed.txt");
      await writeFile(changed, "one\ntwo\n");
      await runTool(readTool, { path: changed }, ctx);
      await writeFile(changed, "one\nchanged\n");
      const applies = await runTool(editTool, { path: changed, old_string: "one", new_string: "uno" }, ctx);
      check("edit: changed on disk but old_string still unique → applied to the current file", !applies.isError && readFileSync(changed, "utf8") === "uno\nchanged\n");

      const gone = await runTool(editTool, { path: changed, old_string: "two", new_string: "dos" }, ctx);
      check("edit: changed on disk and old_string gone → refused, file untouched", gone.isError === true && readFileSync(changed, "utf8") === "uno\nchanged\n");

      const dup = path.join(dir, "dup.txt");
      await writeFile(dup, "x = 1\n");
      await runTool(readTool, { path: dup }, ctx);
      await writeFile(dup, "x = 1\nx = 1\n");
      const dupEdit = await runTool(editTool, { path: dup, old_string: "x = 1", new_string: "x = 2" }, ctx);
      check("edit: changed on disk and old_string no longer unique → refused, file untouched", dupEdit.isError === true && readFileSync(dup, "utf8") === "x = 1\nx = 1\n");
    }

    // ── A paged read leaves most of a big file unseen, yet the edit resolves: uniqueness
    //    is checked against the whole file on disk, not against what the model was shown. ──
    {
      const big = path.join(dir, "big.ts");
      const lines = Array.from({ length: 500 }, (_, i) => (i === 400 ? "SENTINEL_LINE" : `line${String(i)}`));
      await writeFile(big, `${lines.join("\n")}\n`);

      await runTool(readTool, { path: big, line_offset: 1, n_lines: 100 }, ctx);
      const bigEdit = await runTool(editTool, { path: big, old_string: "SENTINEL_LINE", new_string: "EDITED_LINE" }, ctx);
      check("edit: text outside the paged window still edits when unique", !bigEdit.isError && readFileSync(big, "utf8").includes("EDITED_LINE"));

      const ambiguous = await runTool(editTool, { path: big, old_string: "line1", new_string: "X" }, ctx);
      check("edit: a non-unique old_string is refused", ambiguous.isError === true);
    }

    // ── Past MAX_UNPAGED_FILE_BYTES an unpaged read is refused rather than served a
    //    truncated prefix: serving one costs the full output cap in tokens to answer
    //    a question the caller did not ask. Paging must stay open — it is the way out
    //    of this very error. ─────────────────────────────────────────────────────────
    {
      const huge = path.join(dir, "huge.log");
      const line = "x".repeat(200);
      await writeFile(huge, `${Array.from({ length: Math.ceil(MAX_UNPAGED_FILE_BYTES / 200) + 100 }, () => line).join("\n")}\n`);

      const refused = await runTool(readTool, { path: huge }, ctx);
      check(
        "read: an oversized file is refused, with the way out in the message",
        refused.isError === true && text(refused).includes("line_offset") && text(refused).includes("Grep"),
      );

      const paged = await runTool(readTool, { path: huge, line_offset: 1, n_lines: 5 }, ctx);
      check("read: the same file pages fine — the size gate is unpaged-only", !paged.isError && text(paged).includes("1\txxx"));
    }

    // ── The output ceiling is the limit that actually bites: a file can clear the
    //    whole-file size gate and still render past MAX_BYTES. That is refused too, and
    //    the refusal has to carry a usable retry — a bare "too big" leaves the caller
    //    guessing at an n_lines that fits. ───────────────────────────────────────────
    {
      const wide = path.join(dir, "wide.txt");
      // ~140 KB: under the 256 KB whole-file gate, over the 100 KB rendered-output one.
      await writeFile(wide, `${Array.from({ length: 700 }, () => "y".repeat(200)).join("\n")}\n`);

      const refused = await runTool(readTool, { path: wide }, ctx);
      check("read: output past the render ceiling is refused, not truncated", refused.isError === true);
      check(
        "read: the refusal names how many lines fit, so the retry is not a guess",
        /About \d+ lines from line 1 fit/.test(text(refused)),
      );

      // Follow the advice the error gave and the read succeeds.
      const fitted = Number(/About (\d+) lines/.exec(text(refused))?.[1] ?? "0");
      check("read: the suggested n_lines is a real number of lines", fitted > 0 && fitted < 700);
      const retried = await runTool(readTool, { path: wide, line_offset: 1, n_lines: fitted }, ctx);
      check("read: retrying with the suggested n_lines succeeds", !retried.isError && text(retried).includes("1\tyyy"));

      // A tail read that does not fit is refused on the same terms — answering "the last
      // 700 lines" with some smaller number it happened to fit would be a silent lie.
      const tailRefused = await runTool(readTool, { path: wide, line_offset: -700 }, ctx);
      check(
        "read: an oversized tail read is refused too",
        tailRefused.isError === true && /About \d+ lines from line \d+ fit/.test(text(tailRefused)),
      );
    }

    const crlfAppend = path.join(dir, "crlf-append.txt");
    await writeFile(crlfAppend, "a\r\nb\r\n");
    const appendCrlf = await runTool(writeTool, { path: crlfAppend, content: "c\n", mode: "append" }, ctx);
    check(
      "write append: preserves pure CRLF file endings",
      !appendCrlf.isError && readFileSync(crlfAppend, "utf8") === "a\r\nb\r\nc\r\n" && text(appendCrlf).includes("Appended 3 bytes"),
    );

    const mixedAppend = path.join(dir, "mixed-append.txt");
    await writeFile(mixedAppend, "a\r\nb\n");
    const appendMixed = await runTool(writeTool, { path: mixedAppend, content: "c\n", mode: "append" }, ctx);
    check(
      "write append: does not normalize mixed line endings",
      !appendMixed.isError && readFileSync(mixedAppend, "utf8") === "a\r\nb\nc\n",
    );

    const created = path.join(dir, "created.txt");
    const create = await runTool(writeTool, { path: created, content: "hello\n" }, ctx);
    const editCreated = await runTool(editTool, { path: created, old_string: "hello", new_string: "hi" }, ctx);
    check("write: a created file can be edited right away", !create.isError && !editCreated.isError && readFileSync(created, "utf8") === "hi\n");

    // ── Chunked writes (the documented way to write a large file: overwrite, then
    //    append, append…) read the file once per append chunk — to concatenate — and
    //    never more. Counted on a wrapped environment, the remote shape where every read
    //    is a round trip. ────────────────────────────────────────────────────────────
    {
      class CountingEnvironment extends LocalEnvironment {
        reads = 0;
        stats = 0;
        override async readBytes(p: string, range?: ByteRange): Promise<Buffer> {
          this.reads++;
          return await super.readBytes(p, range);
        }
        override async fileInfo(p: string, options?: { followSymlinks?: boolean }): Promise<FileInfo> {
          this.stats++;
          return await super.fileInfo(p, options);
        }
      }

      const remote = new CountingEnvironment(dir);
      const chunkedCtx = makeCtx(remote);
      const chunked = path.join(dir, "chunked.txt");

      remote.reads = 0;
      remote.stats = 0;
      await runTool(writeTool, { path: chunked, content: "a\n" }, chunkedCtx);
      check("write overwrite: no read at all", remote.reads === 0);
      check("write overwrite: no stat — the write itself is the only round trip", remote.stats === 0);
      remote.reads = 0;
      const appended = await runTool(writeTool, { path: chunked, content: "b\n", mode: "append" }, chunkedCtx);
      check("write append: one read per chunk", remote.reads === 1 && !appended.isError);

      await runTool(writeTool, { path: chunked, content: "c\n", mode: "append" }, chunkedCtx);
      check("write append: chunks accumulate in order", readFileSync(chunked, "utf8") === "a\nb\nc\n");

      // The parent is inspected only once the write has failed, and the message names why.
      const noParent = await runTool(writeTool, { path: path.join(dir, "missing-dir", "f.txt"), content: "x" }, chunkedCtx);
      check("write: a missing parent directory is created", noParent.isError !== true);
      const fileParent = await runTool(writeTool, { path: path.join(chunked, "f.txt"), content: "x" }, chunkedCtx);
      check("write: a file in the parent position is reported as not a directory", fileParent.isError === true && text(fileParent).includes("Parent path is not a directory"));
      const appendNoParent = await runTool(writeTool, { path: path.join(dir, "missing-dir", "g.txt"), content: "x", mode: "append" }, chunkedCtx);
      check("write append: a missing parent directory is created", appendNoParent.isError !== true);
    }

    const bashPlan = await bashTool.resolve({ command: "git add . && git commit -m x" }, ctx);
    check("bash-rule: plan exposes compound matcher", bashPlan.matchesRule?.("git:*") === true);
    check("bash-rule: partial compound coverage rejected", bashPlan.matchesRule?.("git add:*") === false);
    check("bash-rule: command substitution never covered", !matchesBashRule("echo:*", "echo $(whoami)"));
    check("bash-rule: safe env prefix stripped", matchesBashRule("npm test:*", "NODE_ENV=test npm test"));
    check("bash-rule: unsafe env prefix not stripped", !matchesBashRule("npm test:*", "PATH=/evil npm test"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, okFlag]) => okFlag).length;
  console.log(`\n${String(passed)}/${String(checks.length)} checks passed`);
  if (passed !== checks.length) {
    console.log("FILESYSTEM-SAFETY E2E FAIL");
    process.exit(1);
  }
  console.log("FILESYSTEM-SAFETY E2E PASS");
}

main().catch((error) => {
  console.error("FILESYSTEM-SAFETY E2E ERROR:", error);
  process.exit(1);
});
