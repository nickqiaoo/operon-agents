/**
 * E2E against the REAL platform sandbox (Seatbelt on macOS, bubblewrap on
 * Linux). On an unsupported platform, or when srt's dependencies are missing
 * (no bwrap on a Linux CI box), the sandbox degrades and this file only
 * asserts the degrade contract — that is a pass, not a skip, because the
 * degrade path IS the product behavior there.
 *
 * Layout: workspace under tmp is the machine's cwd (writable); a sibling
 * "secret" dir is deny-read; $HOME is outside every write root. Network is
 * deny-all.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { OsSandbox, SandboxedLocalMachine } from "../index.ts";
import { LocalMachine } from "operon-agents-core";

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${!ok && detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const work = mkdtempSync(join(tmpdir(), "oss-e2e-work-"));
const secretDir = mkdtempSync(join(tmpdir(), "oss-e2e-secret-"));
const secretFile = join(secretDir, "secret.txt");
writeFileSync(secretFile, "s3cret\n");
const denyWriteFile = join(work, "protected.txt");
writeFileSync(denyWriteFile, "keep me\n");
const homeProbe = join(homedir(), `.oss-e2e-denied-${String(process.pid)}`);

const sandbox = await OsSandbox.start({
  network: { allowedDomains: [] },
  filesystem: { denyRead: [secretDir], denyWrite: [denyWriteFile] },
});

async function testDisabledContract(): Promise<void> {
  console.log(`sandbox disabled (${sandbox.status.enabled ? "?" : sandbox.status.reason}) — asserting the degrade contract`);
  const machine = sandbox.machine(work);
  check("degrade: plain LocalMachine", machine instanceof LocalMachine && !(machine instanceof SandboxedLocalMachine));
  const result = await machine.run(["/bin/sh", "-c", "echo degraded"]);
  check("degrade: commands still run", result.exitCode === 0 && result.stdout.trim() === "degraded");
}

async function testEnabledContract(): Promise<void> {
  const machine = sandbox.machine(work);
  check("machine: sandboxed type", machine instanceof SandboxedLocalMachine);

  // Baseline: an ordinary command runs and its streams come home.
  const echo = await machine.run(["/bin/sh", "-c", "echo hello && echo oops >&2"]);
  check("run: exit 0", echo.exitCode === 0, `exit=${String(echo.exitCode)} stderr=${echo.stderr}`);
  check("run: stdout", echo.stdout.trim() === "hello");
  check("run: stderr", echo.stderr.trim() === "oops");

  // cwd tree is writable.
  const writeIn = await machine.run(["/bin/sh", "-c", "echo data > inside.txt && cat inside.txt"]);
  check("fs: write inside cwd allowed", writeIn.exitCode === 0 && writeIn.stdout.trim() === "data", writeIn.stderr);

  // $HOME is outside every write root.
  const writeOut = await machine.run(["/bin/sh", "-c", `echo nope > ${homeProbe}`]);
  check("fs: write outside roots denied", writeOut.exitCode !== 0 && !existsSync(homeProbe), `exit=${String(writeOut.exitCode)}`);

  // denyRead carve-out.
  const readSecret = await machine.run(["/bin/sh", "-c", `cat ${secretFile}`]);
  check("fs: deny-read enforced", readSecret.exitCode !== 0 && !readSecret.stdout.includes("s3cret"), `exit=${String(readSecret.exitCode)}`);

  // denyWrite carve-out inside the writable cwd; reading it stays fine.
  const writeProtected = await machine.run(["/bin/sh", "-c", `echo clobber > ${denyWriteFile}`]);
  check("fs: deny-write carve-out enforced", writeProtected.exitCode !== 0);
  const readProtected = await machine.run(["/bin/sh", "-c", `cat ${denyWriteFile}`]);
  check("fs: deny-write file still readable", readProtected.exitCode === 0 && readProtected.stdout.trim() === "keep me");

  // Deny-all network. Blocking has two shapes: plain HTTP gets the filter
  // proxy's block-page BODY (curl exits 0), HTTPS gets a refused CONNECT
  // (curl exits nonzero). Either way the request never reaches the target.
  const netHttp = await machine.run(["/bin/sh", "-c", "curl -sS --max-time 5 http://example.com/"], { timeoutMs: 15_000 });
  const httpBlocked = netHttp.exitCode !== 0 || /blocked by network allowlist/i.test(netHttp.stdout + netHttp.stderr);
  check("net: deny-all intercepts http", httpBlocked, `exit=${String(netHttp.exitCode)} stdout=${netHttp.stdout.slice(0, 80)}`);
  const netHttps = await machine.run(["/bin/sh", "-c", "curl -sS --max-time 5 https://example.com/"], { timeoutMs: 15_000 });
  check("net: deny-all refuses https CONNECT", netHttps.exitCode !== 0, `exit=${String(netHttps.exitCode)} stdout=${netHttps.stdout.slice(0, 80)}`);

  // Non-shell argv form goes through the quoting path.
  const argvForm = await machine.run(["ls", work]);
  check("run: plain argv form works", argvForm.exitCode === 0 && argvForm.stdout.includes("inside.txt"), argvForm.stderr);

  // A per-run cwd override is folded in BEFORE wrapping.
  const sub = join(work, "sub");
  await machine.mkdir(sub);
  const cwdRun = await machine.run(["/bin/sh", "-c", "pwd"], { cwd: sub });
  check("run: cwd override respected", cwdRun.stdout.trim().endsWith("/sub"), cwdRun.stdout);

  // withCwd keeps the sandbox: same policy object, still denied outside.
  const sibling = machine.withCwd(sub);
  check("withCwd: sandboxed sibling", sibling instanceof SandboxedLocalMachine);
  const siblingDenied = await sibling.run(["/bin/sh", "-c", `echo nope > ${homeProbe}`]);
  check("withCwd: still denied outside", siblingDenied.exitCode !== 0 && !existsSync(homeProbe));
  const siblingWrite = await sibling.run(["/bin/sh", "-c", "echo ok > from-sibling.txt"]);
  check("withCwd: sibling cwd writable", siblingWrite.exitCode === 0 && existsSync(join(sub, "from-sibling.txt")), siblingWrite.stderr);

  // Direct file I/O is NOT the sandbox's business (path-access policy owns it).
  await machine.writeText(join(work, "direct.txt"), "direct\n");
  check("io: writeText untouched", (await machine.readBytes(join(work, "direct.txt"))).toString("utf8") === "direct\n");

  // Timeout/kill machinery still works through the wrapper.
  const slow = await machine.run(["/bin/sh", "-c", "sleep 30"], { timeoutMs: 1_500 });
  check("run: timeout kills wrapped command", slow.timedOut && slow.terminated);

  // stderr annotation is best-effort (macOS log stream lags) — report, don't fail.
  const annotated = /sandbox/i.test(writeOut.stderr);
  console.log(`ℹ️  violation annotation on denied write: ${annotated ? "present" : "not present (timing-dependent, ok)"}`);
}

try {
  if (sandbox.status.enabled) {
    console.log(`sandbox enabled on ${sandbox.status.platform}${sandbox.status.warnings.length > 0 ? ` (warnings: ${sandbox.status.warnings.join("; ")})` : ""}`);
    await testEnabledContract();
  } else {
    await testDisabledContract();
  }

  // The explicit-off constructor honors the same machine() contract everywhere.
  const off = OsSandbox.disabled("test");
  check("disabled(): plain LocalMachine", !(off.machine(work) instanceof SandboxedLocalMachine));
} finally {
  await sandbox.dispose();
  rmSync(work, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
  rmSync(homeProbe, { force: true });
}

console.log(failures === 0 ? "\n✅ OS-SANDBOX E2E PASS" : `\n❌ ${String(failures)} FAILED`);
process.exit(failures > 0 ? 1 : 0);
