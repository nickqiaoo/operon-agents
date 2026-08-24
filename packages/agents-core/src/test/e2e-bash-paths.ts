/**
 * E2E for the Bash path extractor.
 *
 * Two properties matter, and they pull in opposite directions:
 *  - it must SEE the ordinary ways a command names a file, or the file-access policies keep
 *    skipping Bash the way they did when it declared nothing;
 *  - it must stay SILENT whenever the path is not knowable from the source text, because a
 *    fabricated path means a permission prompt for a file the command never touched.
 *
 * The silence cases are therefore as load-bearing as the detection ones, and are asserted
 * exactly: not "no write", but "nothing at all".
 */
import { extractBashPaths, type BashPathAccess } from "../tool/support/bash-paths.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, okFlag: boolean): void {
  checks.push([label, okFlag]);
  console.log(`${okFlag ? "PASS" : "FAIL"} ${label}`);
}

function render(found: readonly BashPathAccess[]): string {
  return found.map((a) => `${a.operation}:${a.path}`).join(",");
}

function expect(command: string, expected: string, label: string): void {
  check(`${label} — ${command}`, render(extractBashPaths(command)) === expected);
}

function expectSilent(command: string, label: string): void {
  check(`${label} — ${command}`, extractBashPaths(command).length === 0);
}

function main(): void {
  // ── Redirections ────────────────────────────────────────────────────────────
  expect("echo hi > out.log", "write:out.log", "redirect");
  expect("echo hi >> out.log", "write:out.log", "append redirect");
  expect("echo hi >/etc/hosts", "write:/etc/hosts", "redirect with no space");
  expect("cat < in.txt", "read:in.txt", "input redirect");
  expect("make 2> err.log", "write:err.log", "fd-numbered redirect");
  expect("make &> all.log", "write:all.log", "combined redirect");
  // `2>&1` duplicates a descriptor; treating `&1` as a filename would invent an access.
  expect("make 2>&1 | tee build.log", "write:build.log", "fd duplication is not a file");

  // ── Command argument roles ──────────────────────────────────────────────────
  expect("rm -rf /tmp/x", "write:/tmp/x", "rm target");
  expect("cp a.txt /etc/foo", "read:a.txt,write:/etc/foo", "cp reads source, writes dest");
  expect("mv old.txt new.txt", "read:old.txt,write:new.txt", "mv reads source, writes dest");
  expect("chmod 755 script.sh", "write:script.sh", "chmod skips the mode argument");
  expect("cat a.txt", "read:a.txt", "read-only command");
  expect("touch a b c", "write:a,write:b,write:c", "several targets");
  // A lone argument to cp/mv is ambiguous (missing operand); classifying it would guess.
  expectSilent("cp onlyone.txt", "single-operand cp is ambiguous");

  // ── In-place editors ────────────────────────────────────────────────────────
  // These are the commands the Bash description tells the model to use Edit for instead, so
  // reaching for them is exactly the case worth seeing. Without `-i` they only read, which is
  // still declared — `sed 's/x/y/' .env` should meet the sensitive-file policy like `cat` does.
  expect("sed -i 's/a/b/' notes.txt", "write:notes.txt", "sed -i writes");
  expect("sed 's/a/b/' notes.txt", "read:notes.txt", "sed without -i only reads");
  expect("sed -n '1,5p' notes.txt", "read:notes.txt", "sed with other options only reads");
  // BSD sed needs a backup suffix for -i, normally an empty word, which shifts the operands.
  expect("sed -i '' 's/a/b/' notes.txt", "write:notes.txt", "BSD sed -i with empty suffix");
  expect("sed -i.bak 's/a/b/' notes.txt", "write:notes.txt", "sed -i with attached suffix");
  // With -e the script is that option's argument, so no operand is a script.
  expect("sed -i -e 's/a/b/' notes.txt", "write:notes.txt", "sed -i -e");
  expect("sed --in-place 's/a/b/' a.txt b.txt", "write:a.txt,write:b.txt", "long flag, several files");
  expect("perl -pi -e 's/a/b/' notes.txt", "write:notes.txt", "perl -pi");
  expect("awk '{print $1}' data.csv", "read:data.csv", "awk reads");
  // The script can contain slashes; it must not be read as a path.
  expect("sed -i 's|/etc/x|/etc/y|' /etc/config", "write:/etc/config", "script with slashes is not a path");

  // ── Command resolution ──────────────────────────────────────────────────────
  expect("sudo rm /etc/shadow", "write:/etc/shadow", "wrapper is skipped");
  expect("/bin/rm x.txt", "write:x.txt", "absolute command path");
  expect("FOO=bar rm x.txt", "write:x.txt", "inline assignment is skipped");
  expect("cat a.txt && rm b.txt", "read:a.txt,write:b.txt", "compound command");
  expect("ls -la | head -5 > /tmp/o", "write:/tmp/o", "pipeline redirect");

  // ── Quoting ─────────────────────────────────────────────────────────────────
  expect("cat 'my file.txt'", "read:my file.txt", "single-quoted path with a space");
  expect('cat "my file.txt"', "read:my file.txt", "double-quoted path with a space");
  expect("cat my\\ file.txt", "read:my file.txt", "backslash-escaped space");
  expect("rm -- -weird-name", "write:-weird-name", "`--` ends option parsing");

  // ── Silence where the path is not knowable ─────────────────────────────────
  expectSilent('eval "rm -rf $X"', "eval can run anything");
  expectSilent("rm $TARGET", "unquoted variable");
  expectSilent('rm "$TARGET"', "quoted variable still expands");
  expectSilent("rm *.log", "glob names a set, not a path");
  expectSilent("rm ?.txt", "single-char glob");
  expectSilent("rm $(ls)", "command substitution");
  expectSilent("rm `ls`", "backtick substitution");
  expectSilent("source ./script.sh", "sourced script can do anything");
  expectSilent('cat "unbalanced', "unbalanced quote");
  expectSilent("git status", "unknown command claims nothing");
  expectSilent("npm run build", "unknown command with args claims nothing");
  expectSilent("ls -la", "options only");

  // Real commands mixing knowable and unknowable parts: the knowable half still counts,
  // because the risky-construct check that would suppress everything did not trigger.
  expect("cp $SRC /etc/dest", "write:/etc/dest", "unknowable source, knowable dest");

  const passed = checks.filter(([, okFlag]) => okFlag).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed === checks.length) {
    console.log("✅ BASH-PATHS E2E PASS — redirects + argument roles + quoting, silent on anything unknowable");
  } else {
    console.log("❌ BASH-PATHS E2E FAIL");
    process.exit(1);
  }
}

main();
