/**
 * E2E for the two advisory classifiers on Bash commands.
 *
 * `isReadOnlyBashCommand` gates a permission APPROVE, so its errors are asymmetric: saying
 * "read-only" about a command that writes approves an unreviewed write, while failing to
 * recognize a genuine read only costs a judge round trip. Every case below that expects
 * `false` is therefore a safety assertion, not a completeness one.
 *
 * `destructiveWarning` decides nothing at all — it adds a line to the approval prompt — so its
 * assertions are about wording being present and, just as importantly, absent on ordinary
 * commands. A warning on everything is a warning on nothing.
 */
import { isReadOnlyBashCommand } from "../tool/support/bash-read-only.ts";
import { destructiveWarning } from "../tool/support/bash-destructive.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, okFlag: boolean): void {
  checks.push([label, okFlag]);
  console.log(`${okFlag ? "PASS" : "FAIL"} ${label}`);
}

function readOnly(command: string): void {
  check(`read-only: ${command}`, isReadOnlyBashCommand(command));
}
function notReadOnly(command: string): void {
  check(`NOT read-only: ${command}`, !isReadOnlyBashCommand(command));
}
function warns(command: string, expected: string): void {
  check(`warns "${expected}": ${command}`, destructiveWarning(command) === expected);
}
function silent(command: string): void {
  check(`no warning: ${command}`, destructiveWarning(command) === undefined);
}

function main(): void {
  // ── Read-only: the commands an agent runs constantly while orienting ────────
  readOnly("ls -la");
  readOnly("pwd");
  readOnly("cat src/index.ts");
  readOnly("which node");
  readOnly("git status");
  readOnly("git log --oneline -5");
  readOnly("git diff HEAD~1");
  readOnly("gh pr list");
  readOnly("npm ls");
  readOnly("docker ps");
  readOnly("FOO=bar ls"); // an inline assignment changes nothing on disk
  readOnly("cat a.txt | grep needle"); // every stage of the pipeline is read-only
  readOnly("git status && ls");

  // ── Not read-only: each of these would be an unreviewed write if approved ───
  notReadOnly("rm -rf build");
  notReadOnly("git push --force");
  notReadOnly("git checkout main"); // listed subcommand, but a write word
  notReadOnly("npm install");
  notReadOnly("gh pr create --title x");
  notReadOnly("kubectl delete pod x");
  // `config` reads with one operand and writes with two.
  readOnly("git config user.name");
  notReadOnly("git config --global user.name x");
  // Redirection creates or truncates regardless of the command in front of it.
  notReadOnly("echo hi > out.txt");
  notReadOnly("cat a.txt >> b.txt");
  // Shell state, indirection and privilege escalation are never waved through.
  notReadOnly("cd /tmp");
  notReadOnly("eval 'ls'");
  notReadOnly("source ./env.sh");
  notReadOnly("sudo ls");
  notReadOnly("bash -c 'ls'");
  notReadOnly("xargs rm < list.txt");
  // One unrecognized stage disqualifies the whole line.
  notReadOnly("git status && rm -rf build");
  notReadOnly("ls && ./deploy.sh");
  // Unrecognized subcommands are writes by default, so a new one is never free.
  notReadOnly("git gc");
  notReadOnly("docker run alpine");
  // A bare REPL would sit waiting for stdin.
  notReadOnly("node");
  notReadOnly("python");

  // ── Write-capable flags on otherwise-reading commands ──────────────────────
  // Being on the read-only list is a fact about the BINARY; these are about what it was asked
  // to do. Skipping this check let `find . -delete` through as read-only.
  notReadOnly("find . -name '*.ts' -delete");
  notReadOnly("find . -name x -exec rm {} ;");
  notReadOnly("git log --output=/tmp/x");
  notReadOnly("git diff --output /tmp/x");
  notReadOnly("sort -o out.txt in.txt");
  notReadOnly("yq -i '.a = 1' config.yaml");
  // Interpreters run arbitrary code; only a version probe is clearable.
  notReadOnly("node -e \"require('fs').writeFileSync('/tmp/x','y')\"");
  notReadOnly("python -c 'open(\"/tmp/x\",\"w\")'");
  readOnly("node --version");

  // The same flag spellings that are harmless elsewhere must not be caught: `-o` is long
  // format for ls, `-i` is ignore-case for grep, `--include` is a filter.
  readOnly("ls -o");
  readOnly("grep -i needle f.txt");
  readOnly("grep -r pattern . --include=*.ts");
  readOnly("sort in.txt");
  readOnly("find . -name '*.ts'");
  readOnly("docker inspect --format '{{.Id}}' abc");

  // ── Warnings ───────────────────────────────────────────────────────────────
  warns("git reset --hard", "may discard uncommitted changes");
  warns("git push --force-with-lease origin main", "may overwrite remote history");
  warns("git clean -fd", "may permanently delete untracked files");
  warns("git commit --amend -m x", "may rewrite the last commit");
  warns("rm -rf /tmp/x", "may recursively force-remove files");
  warns("rm -f a.txt", "may force-remove files");
  warns("terraform destroy", "may destroy Terraform infrastructure");
  warns("npm publish", "may publish a package publicly");
  warns("DROP TABLE users;", "may drop or truncate database objects");

  // Ordinary commands must stay quiet, including ones that merely mention a scary word.
  silent("ls -la");
  silent("git status");
  silent("npm test");
  silent("git log --grep 'remove files'");
  silent("cat notes-about-rm-rf.md");

  const passed = checks.filter(([, okFlag]) => okFlag).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed === checks.length) {
    console.log("✅ BASH-CLASSIFY E2E PASS — read-only fast path (fails closed) + advisory destructive warnings");
  } else {
    console.log("❌ BASH-CLASSIFY E2E FAIL");
    process.exit(1);
  }
}

main();
