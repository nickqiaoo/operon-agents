/**
 * E2E for the Machine high-level ops + FileFreshnessLedger. Covers:
 *  - readBytes: whole-file / prefix / window reads, byte-exactness, and default
 *    composition parity with the native local implementation
 *  - writeTextIfUnchanged: must-not-exist, mtime-fresh write, stale detection,
 *    mtime false-positive review via expectedContent
 *  - writeText: unconditional overwrite, CRLF restore, bytesWritten
 *  - FileFreshnessLedger + checkFreshness verdicts (mtime-first, content fallback)
 *  - realpath: native local + `readlink -f` default composition
 */
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath as nodeRealpath, readdir, readFile, rm, stat as nodeStat, symlink, utimes, writeFile } from "node:fs/promises";
import {
  BaseMachine,
  checkFreshness,
  FileExistsError,
  FileFreshnessLedger,
  LocalMachine,
  StaleFileError,
  type DirEntry,
  type Machine,
  type ByteRange,
  type RunCommandOptions,
  type RunCommandResult,
  type FileInfo,
} from "../index.ts";
import type { ReadFileRangeResult } from "../index.ts";
import { fileVersionFromInfo } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Forwards only the SPI members — exercises BaseMachine's derived default operations. */
class BareHost extends BaseMachine {
  readonly name = "bare";
  private readonly inner: LocalMachine;
  constructor(inner: LocalMachine) {
    super();
    this.inner = inner;
  }
  get osEnv() {
    return this.inner.osEnv;
  }
  pathClass(): "posix" | "win32" {
    return this.inner.pathClass();
  }
  normpath(p: string): string {
    return this.inner.normpath(p);
  }
  gethome(): string {
    return this.inner.gethome();
  }
  getcwd(): string {
    return this.inner.getcwd();
  }
  withCwd(cwd: string): Machine {
    return new BareHost(this.inner.withCwd(cwd) as LocalMachine);
  }
  fileInfo(p: string, o?: { followSymlinks?: boolean }): Promise<FileInfo> {
    return this.inner.fileInfo(p, o);
  }
  listDir(p: string): Promise<readonly DirEntry[]> {
    return this.inner.listDir(p);
  }
  readBytes(p: string, range?: ByteRange): Promise<Buffer> {
    return this.inner.readBytes(p, range);
  }
  protected async writeBytesRaw(p: string, data: Buffer): Promise<void> {
    await writeFile(p, data);
  }
  mkdir(p: string, o?: { parents?: boolean; existOk?: boolean }): Promise<void> {
    return this.inner.mkdir(p, o);
  }
  // No process SPI: this fake only exercises file reads/writes, and delegating `run` to the
  // inner machine keeps it honest if something ever does need a command.
  override run(argv: readonly string[], options?: RunCommandOptions): Promise<RunCommandResult> {
    return this.inner.run(argv, options);
  }
}

function sameRangeResult(a: ReadFileRangeResult, b: ReadFileRangeResult): boolean {
  return (
    a.content === b.content &&
    a.lineCount === b.lineCount &&
    a.totalLines === b.totalLines &&
    a.totalBytes === b.totalBytes &&
    a.truncatedByBytes === b.truncatedByBytes &&
    a.lineEndings === b.lineEndings &&
    a.version.mtimeMs === b.version.mtimeMs
  );
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "operon-freshness-"));
  const host = new LocalMachine(dir);
  const bare = new BareHost(host);

  try {
    // ── readBytes: the one read member. Whole file, prefix, window, and the
    //    default composition (BareHost has no native overrides) must agree. ──
    const basic = path.join(dir, "basic.txt");
    await writeFile(basic, "l1\nl2\nl3\nl4\nl5\n");
    check("readBytes: whole file", (await host.readBytes(basic)).toString("utf8") === "l1\nl2\nl3\nl4\nl5\n");
    check("readBytes: prefix", (await host.readBytes(basic, { length: 5 })).toString("utf8") === "l1\nl2");
    check("readBytes: window", (await host.readBytes(basic, { offset: 3, length: 5 })).toString("utf8") === "l2\nl3");
    check("readBytes: offset to EOF", (await host.readBytes(basic, { offset: 12 })).toString("utf8") === "l5\n");
    check("readBytes: offset past EOF → empty", (await host.readBytes(basic, { offset: 999 })).byteLength === 0);
    check(
      "readBytes: default composition matches the native local read",
      (await bare.readBytes(basic, { offset: 3, length: 5 })).equals(await host.readBytes(basic, { offset: 3, length: 5 })),
    );

    // Binary safety: a window must move bytes, never decoded text.
    const bin = path.join(dir, "raw.bin");
    await writeFile(bin, Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x42]));
    check("readBytes: binary window is byte-exact", (await host.readBytes(bin, { offset: 1, length: 2 })).equals(Buffer.from([0xff, 0xfe])));

    // ── writeTextIfUnchanged ─────────────────────────────────────────────────────
    const target = path.join(dir, "write.txt");
    const created = await host.writeTextIfUnchanged(target, "v1\n", { expected: "must-not-exist" });
    check("writeTextIfUnchanged: must-not-exist creates", created.version.mtimeMs !== undefined && created.bytesWritten === 3);

    let existsErr = false;
    try {
      await host.writeTextIfUnchanged(target, "v1b\n", { expected: "must-not-exist" });
    } catch (error) {
      existsErr = error instanceof FileExistsError;
    }
    check("writeTextIfUnchanged: must-not-exist on existing → FileExistsError", existsErr);

    const v2 = await host.writeTextIfUnchanged(target, "v2\n", { expected: created.version });
    check("writeTextIfUnchanged: matching version writes", v2.version.mtimeMs !== undefined);

    await writeFile(target, "external\n");
    let stale = false;
    try {
      await host.writeTextIfUnchanged(target, "v3\n", { expected: v2.version });
    } catch (error) {
      stale = error instanceof StaleFileError;
    }
    check("writeTextIfUnchanged: external modification → StaleFileError", stale);

    // mtime false positive: same content, mtime bumped → expectedContent review passes.
    const fp = path.join(dir, "fp.txt");
    const fpV = await host.writeTextIfUnchanged(fp, "same\n", { expected: "must-not-exist" });
    await utimes(fp, new Date(), new Date(Date.now() + 5_000));
    const fpWrite = await host
      .writeTextIfUnchanged(fp, "next\n", { expected: fpV.version, expectedContent: "same\n" })
      .then(() => true)
      .catch(() => false);
    check("writeTextIfUnchanged: mtime moved + content unchanged → expectedContent review passes", fpWrite);

    const crlfOut = path.join(dir, "crlf-out.txt");
    const crlfRes = await host.writeText(crlfOut, "a\nb\n", { lineEndings: "CRLF" });
    const crlfBytes = await host.readBytes(crlfOut);
    check("writeText: CRLF restored on write", crlfBytes.toString("utf8") === "a\r\nb\r\n" && crlfRes.bytesWritten === 6);

    // writeText is unconditional: overwrites a stale file without any expectation.
    await host.writeText(crlfOut, "plain\n");
    check("writeText: unconditional overwrite", (await host.readBytes(crlfOut)).toString("utf8") === "plain\n");

    // default composition (BareHost) staleness path
    let composedStale = false;
    try {
      await bare.writeTextIfUnchanged(target, "v4\n", { expected: v2.version });
    } catch (error) {
      composedStale = error instanceof StaleFileError;
    }
    check("ops default writeTextIfUnchanged: stale detection matches", composedStale);

    // ── FileFreshnessLedger + checkFreshness ─────────────────────────────────────
    const ledger = new FileFreshnessLedger();
    const lPath = path.join(dir, "ledger.txt");
    await writeFile(lPath, "content\n");
    const lInfo = await host.fileInfo(lPath);
    const lVersion: FileVersion = fileVersionFromInfo(lInfo);

    check("checkFreshness: unknown path → not-read", (await checkFreshness({ ledger, path: lPath, current: lVersion })).kind === "not-read");

    ledger.recordRead(lPath, {
      version: lVersion,
      content: "content\n",
      fullRead: true,
      lineEndings: "LF",
      encoding: "utf8",
      readAt: Date.now(),
    });
    check("checkFreshness: same mtime → fresh (no content I/O)", (await checkFreshness({ ledger, path: lPath, current: lVersion })).kind === "fresh");

    const movedMtime: FileVersion = { mtimeMs: (lVersion.mtimeMs ?? 0) + 1234 };
    const freshByContent = await checkFreshness({
      ledger,
      path: lPath,
      current: movedMtime,
      currentContent: () => Promise.resolve("content\n"),
    });
    check("checkFreshness: mtime moved + content equal → fresh", freshByContent.kind === "fresh");

    const staleByContent = await checkFreshness({
      ledger,
      path: lPath,
      current: movedMtime,
      currentContent: () => Promise.resolve("tampered\n"),
    });
    check("checkFreshness: mtime moved + content differs → stale", staleByContent.kind === "stale");

    const noMtime = await checkFreshness({ ledger, path: lPath, current: {} });
    check("checkFreshness: mtime unavailable + no content provider → stale (conservative)", noMtime.kind === "stale");

    ledger.recordRead(lPath, {
      version: lVersion,
      content: "content\n",
      fullRead: false,
      lineEndings: "LF",
      encoding: "utf8",
      readAt: Date.now(),
    });
    const partialStale = await checkFreshness({
      ledger,
      path: lPath,
      current: movedMtime,
      currentContent: () => Promise.resolve("content\n"),
    });
    check("checkFreshness: partial read never passes content review", partialStale.kind === "stale");

    ledger.recordWrite(lPath, lVersion, { content: "content\n" });
    check("ledger: recordWrite marks writer as last reader", ledger.get(lPath)?.fullRead === true);

    // ── realpath ─────────────────────────────────────────────────────────────────
    const realDir = path.join(dir, "real");
    await mkdir(realDir);
    const realFile = path.join(realDir, "target.txt");
    await writeFile(realFile, "x\n");
    const link = path.join(dir, "link.txt");
    await symlink(realFile, link);
    const expected = await nodeRealpath(realFile);
    check("realpath: native local resolves symlink", (await host.realpath(link)) === expected);
    check("realpath: exec-derived default composition resolves symlink", (await bare.realpath(link)) === expected);

    // ── local CAS lands atomically (temp + rename), without the two things a bare
    //    rename would break: the symlink it lands on, and the target's mode. ──────
    {
      const linkTarget = path.join(realDir, "script.sh");
      await writeFile(linkTarget, "#!/bin/sh\necho old\n", { mode: 0o755 });
      const viaLink = path.join(dir, "script-link.sh");
      await symlink(linkTarget, viaLink);

      const before = fileVersionFromInfo(await host.fileInfo(viaLink));
      await host.writeTextIfUnchanged(viaLink, "#!/bin/sh\necho new\n", {
        expected: before,
        expectedContent: "#!/bin/sh\necho old\n",
      });

      // A rename onto the link would have replaced the LINK with a regular file and
      // left the real script untouched — silently breaking every other path to it.
      const linkInfo = await host.fileInfo(viaLink, { followSymlinks: false });
      check("local CAS: writes THROUGH the symlink, does not replace it", linkInfo.kind === "symlink");
      check("local CAS: the real file received the write", (await readFile(linkTarget, "utf8")).includes("echo new"));
      // A fresh temp inode is born with the umask; without the chmod the +x is lost.
      check("local CAS: target's mode survives the swap", ((await nodeStat(linkTarget)).mode & 0o777) === 0o755);

      // No residue: a leftover .tmp.* beside the target is litter in the user's workspace.
      const residue = (await readdir(realDir)).filter((n) => n.includes(".tmp."));
      check("local CAS: no temp file left behind", residue.length === 0);

      // The unconditional path is deliberately NOT atomic — only CAS pays for the swap.
      const plain = path.join(realDir, "plain.txt");
      await host.writeText(plain, "direct\n");
      check("local writeText: unconditional write still lands", (await readFile(plain, "utf8")) === "direct\n");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ FILE-FRESHNESS E2E PASS — readBytes + writeTextIfUnchanged + ledger + realpath");
  } else {
    console.log("❌ FILE-FRESHNESS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ FILE-FRESHNESS E2E ERROR:", error);
  process.exit(1);
});
