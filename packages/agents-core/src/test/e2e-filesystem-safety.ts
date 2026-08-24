/**
 * E2E for builtin filesystem safety: Read records FileFreshnessLedger state,
 * Write/Edit enforce read-before-write for existing files, stale files are
 * rejected, repeat Read can dedup unchanged output, and Bash permission rules
 * use conservative compound-command matching.
 */
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import {
  bashTool,
  editTool,
  FileFreshnessLedger,
  LocalMachine,
  readTool,
  writeTool,
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

function makeCtx(host: LocalMachine, ledger?: FileFreshnessLedger) {
  return {
    turnId: "t1",
    toolCallId: "c1",
    signal: new AbortController().signal,
    machine: host,
    ...(ledger ? { fileLedger: ledger } : {}),
  };
}

async function runTool(tool: Tool, args: unknown, ctx: ReturnType<typeof makeCtx>): Promise<ToolResult> {
  const plan = await tool.resolve(args, ctx);
  return await plan.run(ctx as Parameters<typeof plan.run>[0]);
}

function text(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function bumpMtime(file: string): Promise<void> {
  await utimes(file, new Date(), new Date(Date.now() + 5_000));
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operon-filesystem-safety-"));
  const host = new LocalMachine(dir);
  const ledger = new FileFreshnessLedger();
  const ctx = makeCtx(host, ledger);

  try {
    const notes = path.join(dir, "notes.txt");
    await writeFile(notes, "alpha\nbeta\ngamma\n");

    const r1 = await runTool(readTool, { path: notes }, ctx);
    check("read: line-numbered output", text(r1).includes("1\talpha") && text(r1).includes("3\tgamma"));
    check("read: full read recorded", ledger.get(notes)?.fullRead === true && ledger.get(notes)?.content === "alpha\nbeta\ngamma\n");

    const partial = await runTool(readTool, { path: notes, n_lines: 1 }, ctx);
    check("read: partial output", text(partial).includes("1\talpha") && !text(partial).includes("2\tbeta"));
    check("read: partial read not full", ledger.get(notes)?.fullRead === false);

    await runTool(readTool, { path: notes }, ctx);
    const dedup = await runTool(readTool, { path: notes }, ctx);
    check("read: unchanged repeat returns stub", text(dedup).includes("File unchanged since last read"));

    await writeFile(notes, "alpha\nbeta\ngamma\ndelta\n");
    await bumpMtime(notes);
    const changed = await runTool(readTool, { path: notes }, ctx);
    check("read: dedup invalidates after modification", text(changed).includes("4\tdelta"));

    const existing = path.join(dir, "existing.txt");
    await writeFile(existing, "old\n");
    const writeNotRead = await runTool(writeTool, { path: existing, content: "new\n" }, ctx);
    check("write: existing file requires a prior read", writeNotRead.isError === true && text(writeNotRead).includes("has not been read yet"));

    await runTool(readTool, { path: existing }, ctx);
    const writeOk = await runTool(writeTool, { path: existing, content: "new\n" }, ctx);
    check("write: read file can be overwritten", !writeOk.isError && readFileSync(existing, "utf8") === "new\n");

    // ── Read-before-write gates on "seen", not on "seen in full". Gating on the
    //    latter locked Edit/Write out of every file past the Read tool's caps: one
    //    Read reports a partial view, and a paged re-read is not a full read either,
    //    so there was no sequence of calls that opened the file back up. ──────────
    {
      const big = path.join(dir, "big.ts");
      // The sentinel sits well past the paged window below, so it is content the model
      // provably never saw in a Read result.
      const lines = Array.from({ length: 500 }, (_, i) => (i === 400 ? "SENTINEL_LINE" : `line${String(i)}`));
      await writeFile(big, `${lines.join("\n")}\n`);

      // An unpaged read of this file IS complete — a partial view now only comes from
      // asking for one, which is the point of dropping the silent default truncation.
      await runTool(readTool, { path: big }, ctx);
      check("read: an unpaged read of a whole file is recorded as a full read", ledger.get(big)?.fullRead === true);

      await runTool(readTool, { path: big, line_offset: 1, n_lines: 100 }, ctx);
      check("read: an explicitly paged read is not a full read", ledger.get(big)?.fullRead === false);
      check("read: a paged read retains no content to compare against", ledger.get(big)?.content === undefined);

      // Line 400 was never in that 100-line window, yet the edit resolves: uniqueness is
      // checked against the whole file on disk, not against what the model was shown.
      const bigEdit = await runTool(editTool, { path: big, old_string: "SENTINEL_LINE", new_string: "EDITED_LINE" }, ctx);
      check(
        "edit: a paged read satisfies read-before-write",
        !bigEdit.isError && readFileSync(big, "utf8").includes("EDITED_LINE"),
      );

      // A non-unique old_string is what actually stops an edit guessed from unseen
      // text — the gate that makes the loosened read check safe.
      await runTool(readTool, { path: big, line_offset: 1, n_lines: 100 }, ctx);
      const ambiguous = await runTool(editTool, { path: big, old_string: "line1", new_string: "X" }, ctx);
      check("edit: unseen text cannot be edited blindly — non-unique old_string is refused", ambiguous.isError === true);

      await runTool(readTool, { path: big, line_offset: 1, n_lines: 100 }, ctx);
      const bigWrite = await runTool(writeTool, { path: big, content: "replaced\n" }, ctx);
      check("write: a paged read satisfies read-before-write", !bigWrite.isError && readFileSync(big, "utf8") === "replaced\n");
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
      check("read: the refused read recorded nothing", ledger.get(huge) === undefined);

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
      check("read: nothing about the refused read reached the ledger", ledger.get(wide) === undefined);

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
    await runTool(readTool, { path: crlfAppend }, ctx);
    const appendCrlf = await runTool(writeTool, { path: crlfAppend, content: "c\n", mode: "append" }, ctx);
    check(
      "write append: preserves pure CRLF file endings",
      !appendCrlf.isError && readFileSync(crlfAppend, "utf8") === "a\r\nb\r\nc\r\n" && text(appendCrlf).includes("Appended 3 bytes"),
    );

    const mixedAppend = path.join(dir, "mixed-append.txt");
    await writeFile(mixedAppend, "a\r\nb\n");
    await runTool(readTool, { path: mixedAppend }, ctx);
    const appendMixed = await runTool(writeTool, { path: mixedAppend, content: "c\n", mode: "append" }, ctx);
    check(
      "write append: does not normalize mixed line endings",
      !appendMixed.isError && readFileSync(mixedAppend, "utf8") === "a\r\nb\nc\n",
    );

    await runTool(readTool, { path: existing }, ctx);
    await writeFile(existing, "tampered\n");
    await bumpMtime(existing);
    const writeStale = await runTool(writeTool, { path: existing, content: "clobber\n" }, ctx);
    check("write: external modification rejected", writeStale.isError === true && text(writeStale).includes("modified since read"));

    const code = path.join(dir, "code.ts");
    await writeFile(code, "const a = 1;\nconst b = 1;\n");
    const editNotRead = await runTool(editTool, { path: code, old_string: "const a", new_string: "const aa" }, ctx);
    check("edit: existing file requires prior full read", editNotRead.isError === true && text(editNotRead).includes("has not been read yet"));

    await runTool(readTool, { path: code }, ctx);
    const multi = await runTool(editTool, { path: code, old_string: "= 1;", new_string: "= 2;" }, ctx);
    check("edit: existing uniqueness guard still runs", multi.isError === true && text(multi).includes("not unique"));

    const editOk = await runTool(editTool, { path: code, old_string: "const a = 1;", new_string: "const a = 9;" }, ctx);
    check("edit: fresh edit applies", !editOk.isError && readFileSync(code, "utf8").includes("const a = 9;"));

    const staleEditFile = path.join(dir, "stale-edit.txt");
    await writeFile(staleEditFile, "one\ntwo\n");
    await runTool(readTool, { path: staleEditFile }, ctx);
    await writeFile(staleEditFile, "one\nchanged\n");
    await bumpMtime(staleEditFile);
    const editStale = await runTool(editTool, { path: staleEditFile, old_string: "one", new_string: "uno" }, ctx);
    check("edit: external modification rejected", editStale.isError === true && text(editStale).includes("modified since read"));

    const created = path.join(dir, "created.txt");
    const create = await runTool(writeTool, { path: created, content: "hello\n" }, ctx);
    const editCreated = await runTool(editTool, { path: created, old_string: "hello", new_string: "hi" }, ctx);
    check("write: successful write records writer as reader", !create.isError && !editCreated.isError && readFileSync(created, "utf8") === "hi\n");

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
