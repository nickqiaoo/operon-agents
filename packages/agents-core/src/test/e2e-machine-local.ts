/**
 * Unit-style coverage for two LocalMachine bugs (tool/machine-local.ts):
 *  - mkdir() ignored `existOk` entirely — {parents:false, existOk:true} on an
 *    already-existing dir threw EEXIST instead of succeeding, unlike SshMachine.
 *  - readBytes ignored its range and sliced a whole-file read, so a header sniff
 *    or a log follower paid for the entire file on every call.
 *  - run() wrote to the child's stdin with no 'error' listener on the stream. A child that
 *    exits without reading it fails that write with EPIPE, delivered as an event rather than a
 *    throw, so the try/catch around end() never saw it and node killed the whole process.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMachine } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function throwsWithCode(label: string, fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, typeof error === "object" && error !== null && (error as { code?: unknown }).code === code);
  }
}

async function ok(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, true);
  } catch (error) {
    console.log(`  (unexpected throw: ${error instanceof Error ? error.message : String(error)})`);
    check(label, false);
  }
}

/**
 * Feeding stdin to a command that never reads it must not be fatal. The failure arrives
 * asynchronously, so it cannot be caught at the call site — it needs a listener on the stream.
 * More than a pipe buffer (64KiB on Linux) is written on purpose: a smaller payload fits in the
 * buffer and the write looks successful even against a dead child, which is why this stayed
 * hidden until a loaded runner hit the timing that surfaces it.
 */
async function stdinToADeafChild(): Promise<void> {
  const machine = new LocalMachine();
  const big = "x".repeat(1024 * 1024);
  const result = await machine.run(["sh", "-c", "exit 0"], { stdin: big });
  check("stdin: a child that never reads it does not take the process down", result.exitCode === 0);
  check("stdin: and the command's own result still comes back", !result.timedOut && !result.terminated);

  // Same shape, but the child writes something — the result must survive the broken pipe intact.
  const echoed = await machine.run(["sh", "-c", "echo done; exit 0"], { stdin: big });
  check("stdin: output is unaffected by the unread stdin", echoed.stdout.trim() === "done");
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "machine-local-e2e-"));
  const machine = new LocalMachine(root);

  // ── mkdir: existOk × parents combinations ──
  await mkdir(join(root, "existing"), { recursive: true });

  await ok("mkdir: parents=false, existOk=true, dir exists → succeeds (no throw)", () =>
    machine.mkdir("existing", { parents: false, existOk: true }),
  );
  await throwsWithCode(
    "mkdir: parents=false, existOk=false (default), dir exists → EEXIST",
    () => machine.mkdir("existing", { parents: false }),
    "EEXIST",
  );
  await ok("mkdir: parents=true, existOk=true, dir exists → succeeds", () =>
    machine.mkdir("existing", { parents: true, existOk: true }),
  );
  await ok("mkdir: parents=true, existOk=false, dir exists → still succeeds (recursive mkdir semantics)", () =>
    machine.mkdir("existing", { parents: true, existOk: false }),
  );
  await ok("mkdir: parents=false, dir does not exist yet → succeeds", () => machine.mkdir("fresh-dir", { parents: false }));
  await throwsWithCode(
    "mkdir: parents=false, nested path with missing intermediate dir → ENOENT",
    () => machine.mkdir("no-parent/nested", { parents: false }),
    "ENOENT",
  );

  // existOk forgives an existing DIRECTORY only — a file at the path is still an error.
  await writeFile(join(root, "afile"), "not a dir");
  await throwsWithCode(
    "mkdir: existOk=true but a FILE occupies the path → still EEXIST (not silent success)",
    () => machine.mkdir("afile", { parents: false, existOk: true }),
    "EEXIST",
  );
  await throwsWithCode(
    "mkdir: parents=true, existOk=true, FILE at path → still EEXIST",
    () => machine.mkdir("afile", { parents: true, existOk: true }),
    "EEXIST",
  );

  // readBytes must honour a REAL byte window, not slice a whole-file read. Proven by
  // content: bytes that would break strict UTF-8 sit outside the window and never appear,
  // and reads past EOF return only what exists.
  {
    await writeFile(
      join(root, "window.bin"),
      Buffer.concat([Buffer.from("HEAD"), Buffer.from([0xff, 0xfe, 0xff]), Buffer.from("TAIL"), Buffer.alloc(4096, 0x41)]),
    );

    const head = await machine.readBytes("window.bin", { length: 4 });
    check("readBytes({length}): prefix only", head.byteLength === 4 && head.toString("utf8") === "HEAD");

    const slice = await machine.readBytes("window.bin", { offset: 7, length: 4 });
    check("readBytes({offset,length}): window from the middle", slice.toString("utf8") === "TAIL");

    // Offset with no length = "everything appended since here" — the log-follower shape.
    const rest = await machine.readBytes("window.bin", { offset: 11 });
    check("readBytes({offset}): reads to EOF", rest.byteLength === 4096 && rest[0] === 0x41);

    await writeFile(join(root, "short.bin"), "hi");
    const overshoot = await machine.readBytes("short.bin", { length: 100 });
    check("readBytes: length past EOF returns only what exists", overshoot.toString("utf8") === "hi");
    const pastEof = await machine.readBytes("short.bin", { offset: 99 });
    check("readBytes: offset past EOF returns empty", pastEof.byteLength === 0);

    const whole = await machine.readBytes("window.bin");
    check("readBytes(): no range still reads the whole file", whole.byteLength === 4107);
  }

  await rm(root, { recursive: true, force: true });

  await stdinToADeafChild();

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — LocalMachine mkdir(existOk) + windowed readBytes + unread stdin");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
