/** Unit coverage for the argv → srt invocation conversion — runs on every platform. */
import { shellQuoteArg, toSrtInvocation } from "../srt-command.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
}

// Shell-form argv passes the script through verbatim with its own shell.
{
  const script = `cd '/tmp/my dir' && echo "it's fine" | wc -l`;
  const inv = toSrtInvocation(["/bin/zsh", "-c", script], "/bin/bash");
  check("shell-form: script verbatim", inv.command === script);
  check("shell-form: original shell kept", inv.binShell === "/bin/zsh");
}

// bash and plain `sh` (BaseMachine's cwd fallback) are recognized as shells.
{
  check("shell-form: bare sh recognized", toSrtInvocation(["sh", "-c", "pwd"], "/bin/bash").command === "pwd");
  check("shell-form: bash path recognized", toSrtInvocation(["/bin/bash", "-c", "pwd"], "/bin/zsh").binShell === "/bin/bash");
}

// Arbitrary argv is quoted into a command string under the fallback shell.
{
  const inv = toSrtInvocation(["rg", "--json", "foo'bar baz", "/tmp/some dir"], "/bin/bash");
  check("argv-form: fallback shell", inv.binShell === "/bin/bash");
  check("argv-form: quoting", inv.command === `rg --json 'foo'\\''bar baz' '/tmp/some dir'`);
}

// A 3-element argv whose head is NOT a shell must not be mistaken for shell-form.
{
  const inv = toSrtInvocation(["node", "-c", "script.js"], "/bin/bash");
  check("argv-form: node -c is not shell-form", inv.command === "node -c script.js");
}

// Quoting round-trips through a real shell. The fixtures are deliberate: a quote, a space, a
// shell variable, a backtick, and a non-ASCII filename containing a space.
{
  const tricky = [`a'b`, `c d`, `$HOME`, `\`whoami\``, `新建 文件`];
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${tricky.map(shellQuoteArg).join(" ")}`], { encoding: "utf8" });
  check("quoting: round-trips via /bin/sh", out === `${tricky.join("\n")}\n`);
}

console.log(failures === 0 ? "\n✅ SRT-COMMAND E2E PASS" : `\n❌ ${String(failures)} FAILED`);
if (failures > 0) process.exit(1);
