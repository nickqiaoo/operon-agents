/**
 * E2E for the two ripgrep-backed search tools.
 *
 * The anchored-glob cases here are regressions, not hypotheticals: `--glob` is matched
 * against the paths ripgrep PRINTS, so passing an absolute search target silently broke
 * every pattern containing a `/` — including `src/**\/*.ts`, which the tool's own
 * description recommends. It returned "No matches found" rather than an error, which is
 * exactly the shape of bug that survives without a test.
 */
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { globTool, grepTool, LocalMachine, type Tool, type ToolResult } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, okFlag: boolean): void {
  checks.push([label, okFlag]);
  console.log(`${okFlag ? "PASS" : "FAIL"} ${label}`);
}

function makeCtx(host: LocalMachine) {
  return { turnId: "t1", toolCallId: "c1", signal: new AbortController().signal, machine: host };
}

async function runTool(tool: Tool, args: unknown, ctx: ReturnType<typeof makeCtx>): Promise<ToolResult> {
  const plan = await tool.resolve(args, ctx);
  return await plan.run(ctx as Parameters<typeof plan.run>[0]);
}

function text(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function lines(result: ToolResult): string[] {
  return text(result)
    .split("\n")
    .filter((line) => line.length > 0);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operon-search-"));
  try {
    await mkdir(path.join(dir, "src", "deep"), { recursive: true });
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(dir, "src", "deep", "b.ts"), "export const b = 2;\n");
    await writeFile(path.join(dir, "top.ts"), "export const top = 3;\n");
    await writeFile(path.join(dir, "notes.md"), "not typescript\n");
    await writeFile(path.join(dir, ".git", "config.ts"), "vcs metadata\n");

    const host = new LocalMachine(dir);
    const ctx = makeCtx(host);

    // ── Glob ────────────────────────────────────────────────────────────────────
    const all = await runTool(globTool, { pattern: "**/*.ts" }, ctx);
    check(
      "glob: `**/*.ts` finds every depth",
      lines(all).sort().join(",") === "src/a.ts,src/deep/b.ts,top.ts",
    );
    check("glob: VCS metadata is excluded", !text(all).includes(".git"));
    check("glob: non-matching extensions are excluded", !text(all).includes("notes.md"));

    // REGRESSION: an anchored pattern silently matched nothing when the search target
    // was absolute — the failure mode was an empty result, not an error.
    const anchored = await runTool(globTool, { pattern: "src/**/*.ts" }, ctx);
    check(
      "glob: `src/**/*.ts` anchors to a subdirectory",
      lines(anchored).sort().join(",") === "src/a.ts,src/deep/b.ts",
    );

    // REGRESSION: an absolute pattern under the root is equivalent to the relative one.
    const absolute = await runTool(globTool, { pattern: `${dir}/src/**/*.ts` }, ctx);
    check(
      "glob: an absolute pattern under the root matches the same files",
      lines(absolute).sort().join(",") === "src/a.ts,src/deep/b.ts",
    );

    // A pattern pointing somewhere else genuinely matches nothing — reinterpreting it as
    // relative would quietly answer a different question.
    const elsewhere = await runTool(globTool, { pattern: "/nowhere/**/*.ts" }, ctx);
    check("glob: a pattern outside the root is not reinterpreted", text(elsewhere) === "No matches found");

    // Most-recently-modified first: the whole point of --sortr, and the ordering the
    // description promises.
    await utimes(path.join(dir, "src", "deep", "b.ts"), new Date(), new Date(Date.now() + 10_000));
    const sorted = await runTool(globTool, { pattern: "**/*.ts" }, ctx);
    check("glob: results are newest-modified first", lines(sorted)[0] === "src/deep/b.ts");

    const noMatch = await runTool(globTool, { pattern: "**/*.nope" }, ctx);
    check("glob: a pattern matching nothing says so", text(noMatch) === "No matches found");

    // ── Grep ────────────────────────────────────────────────────────────────────
    const found = await runTool(grepTool, { pattern: "export const" }, ctx);
    check("grep: default mode lists matching files", lines(found).length === 3);

    const content = await runTool(grepTool, { pattern: "const b", output_mode: "content" }, ctx);
    check("grep: content mode shows the matching line", text(content).includes("export const b = 2;"));
    check("grep: content mode prefixes line numbers", /b\.ts:1:/.test(text(content)));

    const counted = await runTool(grepTool, { pattern: "export", output_mode: "count_matches" }, ctx);
    check("grep: count mode reports per-file counts", /:1$/m.test(text(counted)));

    // REGRESSION: --max-columns was applied to the modes that print no file content and
    // omitted from `content`, the only mode that can print a 200 KB minified line. On a
    // remote backend every one of those bytes crosses the wire before anything trims them.
    await writeFile(path.join(dir, "min.js"), `NEEDLE_${"x".repeat(200_000)}\n`);
    const longLine = await runTool(grepTool, { pattern: "NEEDLE", output_mode: "content" }, ctx);
    // Capped at the ripgrep end this is ~540 chars. Uncapped it was 2043 — the result
    // builder's 2000-char-per-line trim, applied only after the whole line came back. The
    // threshold sits between the two so it fails if the cap moves back to the wrong mode.
    check("grep: an over-long matching line is capped by ripgrep itself", text(longLine).length < 1_000);
    check("grep: the capped line still shows the match", text(longLine).includes("NEEDLE_xxx"));

    // The cap must not cost the OTHER matches in the same search.
    await writeFile(path.join(dir, "also.js"), "NEEDLE_short\n");
    const mixed = await runTool(grepTool, { pattern: "NEEDLE", output_mode: "content" }, ctx);
    check("grep: a long line does not crowd out other matches", text(mixed).includes("NEEDLE_short"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, okFlag]) => okFlag).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed === checks.length) {
    console.log("✅ SEARCH-TOOLS E2E PASS — Glob anchoring/ordering/exclusions + Grep modes and line capping");
  } else {
    console.log("❌ SEARCH-TOOLS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ SEARCH-TOOLS E2E ERROR:", error);
  process.exit(1);
});
