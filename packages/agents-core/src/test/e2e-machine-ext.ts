import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { PassThrough, type Readable } from "node:stream";
import {
  BaseMachine,
  FileExistsError,
  LocalMachine,
  NullMachine,
  SshMachine,
  StaleFileError,
  collectGitContext,
  detectEnvironment,
  nonInteractiveShellEnv,
  parseProjectName,
  proxyEnv,
  sanitizeRemoteUrl,
  type Environment,
  type FileInfo,
  type SpawnedProcess,
  type RunCommandOptions,
  type RunCommandResult,
  type WriteFileResult,
} from "../index.ts";
import { SshProcess, buildSshExecCommand, fileVersionFromInfo, readTextFile, sshShellQuote } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf-8");
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function statObj(type: "dir" | "file", size: number, mtime = 222, mode?: number): unknown {
  return {
    mode: mode ?? (type === "dir" ? S_IFDIR | 0o755 : S_IFREG | 0o644),
    uid: 1000,
    gid: 1000,
    size,
    atime: 111,
    mtime,
    isDirectory: () => type === "dir",
    isFile: () => type === "file",
    isSymbolicLink: () => false,
    isSocket: () => false,
    isCharacterDevice: () => false,
    isBlockDevice: () => false,
    isFIFO: () => false,
  };
}

function notFound(): NodeJS.ErrnoException {
  return Object.assign(new Error("No such file"), { code: 2 }) as NodeJS.ErrnoException;
}

function makeFakeSftp(seedFiles: Record<string, string>, seedDirs: string[]) {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(seedDirs);
  const mtimes = new Map<string, number>(); // POSIX seconds, like SFTP v3
  const modes = new Map<string, number>();
  let clock = 100;
  const touch = (p: string): void => void mtimes.set(p, ++clock);
  for (const [p, content] of Object.entries(seedFiles)) {
    files.set(p, Buffer.from(content, "utf8"));
    touch(p);
  }

  const typeOf = (p: string): "dir" | "file" | undefined =>
    dirs.has(p) ? "dir" : files.has(p) ? "file" : undefined;

  // rename keeps the moved entry's own attributes, like a real filesystem.
  const moveEntry = (src: string, dst: string): void => {
    files.set(dst, files.get(src)!);
    files.delete(src);
    const mt = mtimes.get(src);
    mtimes.delete(src);
    if (mt !== undefined) mtimes.set(dst, mt);
    const md = modes.get(src);
    modes.delete(src);
    if (md !== undefined) modes.set(dst, md);
  };

  const fake = {
    // Test toggles/hooks: simulate a server without posix-rename, and an external
    // writer landing at a chosen point in the CAS sequence.
    posixRenameSupported: true,
    afterWriteFile: undefined as ((p: string) => void) | undefined,

    stat(p: string, cb: (err: unknown, stats?: unknown) => void) {
      const t = typeOf(p);
      if (t === undefined) return cb(notFound());
      cb(null, statObj(t, t === "file" ? files.get(p)!.byteLength : 0, mtimes.get(p) ?? 222, modes.get(p)));
    },
    lstat(p: string, cb: (err: unknown, stats?: unknown) => void) {
      this.stat(p, cb);
    },
    readdir(p: string, cb: (err: unknown, list?: unknown) => void) {
      if (!dirs.has(p)) return cb(notFound());
      const children: Array<{ filename: string; attrs: unknown }> = [];
      for (const f of files.keys()) {
        if (path.posix.dirname(f) === p) children.push({ filename: path.posix.basename(f), attrs: statObj("file", files.get(f)!.byteLength) });
      }
      for (const d of dirs) {
        if (d !== p && path.posix.dirname(d) === p) children.push({ filename: path.posix.basename(d), attrs: statObj("dir", 0) });
      }
      cb(null, children);
    },
    mkdir(p: string, cb: (err?: unknown) => void) {
      dirs.add(p);
      cb(null);
    },
    exists(p: string, cb: (exists: boolean) => void) {
      cb(typeOf(p) !== undefined);
    },
    readFile(p: string, cb: (err: unknown, data?: Buffer) => void) {
      const data = files.get(p);
      if (data === undefined) return cb(notFound());
      cb(null, data);
    },
    writeFile(p: string, data: string | Buffer, cb: (err?: unknown) => void) {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
      touch(p);
      cb(null);
      fake.afterWriteFile?.(p);
    },
    appendFile(p: string, data: string | Buffer, cb: (err?: unknown) => void) {
      const prev = files.get(p) ?? Buffer.alloc(0);
      files.set(p, Buffer.concat([prev, Buffer.isBuffer(data) ? data : Buffer.from(data)]));
      touch(p);
      cb(null);
    },
    // Only the "wx" shape our EXCL-create path uses; real servers report a generic
    // FAILURE (SFTP v3 has no EEXIST status code).
    open(p: string, flags: string, cb: (err: unknown, handle?: unknown) => void) {
      if (flags.includes("x") && typeOf(p) !== undefined) {
        return cb(Object.assign(new Error("Failure"), { code: 4 }));
      }
      // Read mode must NOT create or truncate — opening a file to read a byte window has to
      // leave it exactly as it was.
      if (flags.startsWith("r")) {
        if (!files.has(p)) return cb(notFound());
        return cb(null, { path: p });
      }
      files.set(p, Buffer.alloc(0));
      touch(p);
      cb(null, { path: p });
    },
    // Mirrors ssh2: reads at most `len` bytes from `pos`, and reports EOF as an error with
    // bytesRead 0 — the shape SshMachine.readBytes has to tolerate.
    read(handle: { path: string }, buf: Buffer, off: number, len: number, pos: number, cb: (err: unknown, bytesRead?: number) => void) {
      const data = files.get(handle.path);
      if (data === undefined) return cb(notFound());
      if (pos >= data.byteLength) return cb(new Error("EOF"), 0);
      const slice = data.subarray(pos, Math.min(data.byteLength, pos + len));
      slice.copy(buf, off);
      cb(null, slice.byteLength);
    },
    write(handle: { path: string }, data: Buffer, off: number, len: number, pos: number, cb: (err?: unknown) => void) {
      const prev = files.get(handle.path) ?? Buffer.alloc(0);
      files.set(handle.path, Buffer.concat([prev.subarray(0, pos), data.subarray(off, off + len)]));
      touch(handle.path);
      cb(null);
    },
    close(_handle: unknown, cb: (err?: unknown) => void) {
      cb(null);
    },
    unlink(p: string, cb: (err?: unknown) => void) {
      if (!files.has(p)) return cb(notFound());
      files.delete(p);
      mtimes.delete(p);
      modes.delete(p);
      cb(null);
    },
    rename(src: string, dst: string, cb: (err?: unknown) => void) {
      if (typeOf(src) === undefined) return cb(notFound());
      if (typeOf(dst) !== undefined) return cb(Object.assign(new Error("Failure"), { code: 4 })); // SFTP v3: no overwrite
      moveEntry(src, dst);
      cb(null);
    },
    ext_openssh_rename(src: string, dst: string, cb: (err?: unknown) => void) {
      // ssh2 throws synchronously when the server lacks the extension — mirror that.
      if (!fake.posixRenameSupported) throw new Error("Server does not support this extended request");
      if (typeOf(src) === undefined) return cb(notFound());
      files.delete(dst);
      moveEntry(src, dst);
      cb(null);
    },
    setstat(p: string, attrs: { mode?: number }, cb: (err?: unknown) => void) {
      if (typeOf(p) === undefined) return cb(notFound());
      if (attrs.mode !== undefined) modes.set(p, attrs.mode);
      cb(null);
    },
    // Emits the file in two chunks to exercise cross-chunk line assembly in the scanner.
    createReadStream(p: string) {
      const data = files.get(p);
      const stream = new PassThrough();
      queueMicrotask(() => {
        if (data === undefined) {
          stream.destroy(notFound());
          return;
        }
        const mid = Math.floor(data.byteLength / 2);
        stream.write(data.subarray(0, mid));
        stream.end(data.subarray(mid));
      });
      return stream;
    },
    end() {},
    _files: files,
    _dirs: dirs,
    _mtimes: mtimes,
    _modes: modes,
  };
  return fake;
}

const FAKE_ENV: Environment = {
  osKind: "Linux",
  osArch: "x86_64",
  osVersion: "6.0",
  shellName: "bash",
  shellPath: "/bin/bash",
};

class FakeChannel extends PassThrough {
  readonly stderr = new PassThrough();
  signalled: string | undefined;
  signal(name: string): void {
    this.signalled = name;
  }
}

async function main(): Promise<void> {
  const env = nonInteractiveShellEnv({ shellPath: "/bin/zsh" });
  check("shell-env: non-interactive overrides", env["NO_COLOR"] === "1" && env["TERM"] === "dumb" && env["SHELL"] === "/bin/zsh" && env["GIT_TERMINAL_PROMPT"] === "0");

  const proxy = proxyEnv({ HTTPS_PROXY: "http://p:8080", NO_PROXY: "localhost", IRRELEVANT: "x" } as NodeJS.ProcessEnv);
  check("shell-env: proxyEnv picks only proxy vars", proxy["HTTPS_PROXY"] === "http://p:8080" && proxy["NO_PROXY"] === "localhost" && !("IRRELEVANT" in proxy));

  const detected = detectEnvironment();
  check("shell-env: detectEnvironment probes host", detected.shellPath.length > 0 && detected.osKind.length > 0 && detected.shellName.length > 0);

  const repoMachine = new LocalMachine(process.cwd());
  const ctx = await collectGitContext(repoMachine, process.cwd());
  check("git-context: detects this repository", ctx.isRepo === true);
  check("git-context: reports a branch", typeof ctx.branch === "string" && ctx.branch!.length > 0);
  check("git-context: collects recent commits", ctx.recentCommits.length > 0);

  const tmp = path.join(os.tmpdir(), `agents-machine-ext-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  try {
    const nonRepo = await collectGitContext(new LocalMachine(tmp), tmp);
    check("git-context: non-repo dir → isRepo false", nonRepo.isRepo === false && nonRepo.recentCommits.length === 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  check("git-context: sanitizeRemoteUrl strips creds + rejects private hosts",
    sanitizeRemoteUrl("https://user:tok@github.com/a/b.git") === "https://github.com/a/b.git" &&
    sanitizeRemoteUrl("git@github.com:a/b.git") === "git@github.com:a/b.git" &&
    sanitizeRemoteUrl("https://git.internal.corp/a/b.git") === null);
  check("git-context: parseProjectName handles scp + nested",
    parseProjectName("git@github.com:owner/repo.git") === "owner/repo" &&
    parseProjectName("https://gitlab.com/grp/sub/repo.git") === "grp/sub/repo");

  check("ssh: buildSshExecCommand cd + args", buildSshExecCommand(["ls", "-la"], "/home/user") === "cd /home/user && ls -la");
  check("ssh: buildSshExecCommand inlines env assignments", buildSshExecCommand(["echo", "hi"], "/w", { FOO: "bar baz" }) === "cd /w && FOO='bar baz' echo hi");
  check("ssh: buildSshExecCommand empty cwd omits cd", buildSshExecCommand(["pwd"], "") === "pwd");
  let threw = false;
  try {
    buildSshExecCommand(["x"], "", { "BAD-NAME": "v" });
  } catch {
    threw = true;
  }
  check("ssh: buildSshExecCommand rejects invalid env name", threw);
  check("ssh: sshShellQuote escapes correctly", sshShellQuote("") === "''" && sshShellQuote("safe.txt") === "safe.txt" && sshShellQuote("a b") === "'a b'" && sshShellQuote("it's") === `'it'"'"'s'`);

  const ch = new FakeChannel();
  const proc = new SshProcess(ch as never);
  ch.write("hello stdout");
  ch.stderr.write("warn stderr");
  ch.end();
  ch.stderr.end();
  ch.emit("exit", 7);
  ch.emit("close", 7);
  const [outText, errText, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()]);
  check("ssh: SshProcess buffers stdout/stderr + exit code", outText === "hello stdout" && errText === "warn stderr" && code === 7);
  await proc.kill("SIGINT");
  check("ssh: SshProcess.kill strips SIG prefix", ch.signalled === "INT");

  const sftp = makeFakeSftp(
    { "/work/a.ts": "aaa", "/work/b.ts": "bbbb", "/work/sub/c.ts": "ccccc", "/work/sub/d.txt": "dd" },
    ["/work", "/work/sub"],
  );
  const fakeClient = { once: () => {}, end: () => {} };
  const machine = SshMachine.fromConnection({ client: fakeClient as never, sftp: sftp as never, home: "/work", osEnv: FAKE_ENV, name: "ssh:test" });

  check("ssh-machine: name + posix path class", machine.name === "ssh:test" && machine.pathClass() === "posix" && machine.gethome() === "/work");

  const infoA = await machine.fileInfo("/work/a.ts");
  check("ssh-machine: fileInfo returns size + file kind", infoA.size === 3 && infoA.kind === "file");

  const readA = await readTextFile(machine, "a.ts"); // relative → resolved against cwd (/work)
  check("ssh-machine: read resolves relative path", readA === "aaa");

  const wrote = await machine.writeText("/work/new.txt", "fresh");
  const readNew = await readTextFile(machine, "/work/new.txt");
  check("ssh-machine: write + read roundtrip", wrote.bytesWritten === 5 && readNew === "fresh");

  await machine.writeText("/work/new.txt", "fresh+more");
  check("ssh-machine: overwrite", (await readTextFile(machine, "/work/new.txt")) === "fresh+more");

  const entries = [...(await machine.listDir("/work"))].toSorted((a, b) => a.name.localeCompare(b.name));
  check("ssh-machine: listDir yields basenames", entries.map((e) => e.name).join(",") === "a.ts,b.ts,new.txt,sub");
  // SFTP readdir carries attrs per entry, so kinds cost no extra round trip.
  check(
    "ssh-machine: listDir yields kinds without extra stats",
    entries.map((e) => `${e.name}:${e.kind}`).join(",") === "a.ts:file,b.ts:file,new.txt:file,sub:dir",
  );

  const scoped = machine.withCwd("/work/sub");
  check("ssh-machine: withCwd re-roots getcwd()", scoped.getcwd() === "/work/sub");
  check("ssh-machine: withCwd shares the connection (reads via new cwd)", (await readTextFile(scoped, "c.ts")) === "ccccc");
  check("ssh-machine: withCwd does not mutate the original machine", machine.getcwd() === "/work");

  await machine.mkdir("/work/x/y/z", { parents: true });
  const infoZ = await machine.fileInfo("/work/x/y/z");
  check("ssh-machine: mkdir parents creates nested dirs", infoZ.kind === "dir");

  let enoent = false;
  try {
    await machine.fileInfo("/work/missing");
  } catch (error) {
    enoent = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  check("ssh-machine: missing file maps to ENOENT", enoent);

  // ── mkdir contract: existOk tolerates a DIRECTORY occupant only (Machine.mkdir doc) ──
  await machine.mkdir("/work/sub", { existOk: true });
  check("ssh-machine: mkdir existOk passes on a dir occupant", true);
  const eexistOf = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST";
    }
  };
  check("ssh-machine: mkdir existOk on a FILE occupant throws EEXIST", await eexistOf(() => machine.mkdir("/work/a.ts", { existOk: true })));
  check("ssh-machine: mkdir parents with a FILE at the final path throws EEXIST", await eexistOf(() => machine.mkdir("/work/a.ts", { parents: true })));
  check("ssh-machine: mkdir parents with a FILE mid-path throws EEXIST", await eexistOf(() => machine.mkdir("/work/a.ts/deeper", { parents: true })));

  // ── readBytes: a real SFTP byte window (open + bounded read at an offset), not a
  //    whole-file transfer that gets sliced — same contract LocalMachine honours ──
  await machine.writeText("/work/lines.txt", "l1\nl2\nl3\nl4\nl5\n");
  check("ssh-machine: readBytes({length}) reads a prefix", (await machine.readBytes("/work/lines.txt", { length: 5 })).toString("utf8") === "l1\nl2");
  check("ssh-machine: readBytes({offset,length}) reads a middle window", (await machine.readBytes("/work/lines.txt", { offset: 3, length: 2 })).toString("utf8") === "l2");
  check("ssh-machine: readBytes({offset}) reads to EOF", (await machine.readBytes("/work/lines.txt", { offset: 9 })).toString("utf8") === "l4\nl5\n");
  check("ssh-machine: readBytes() with no range reads the whole file", (await machine.readBytes("/work/lines.txt")).byteLength === 15);

  // ── writeTextIfUnchanged: SFTP-native CAS (EXCL create + tmp/atomic-rename) ──
  {
    const casPath = "/work/cas.txt";
    const noTmp = () => [...sftp._files.keys()].every((k) => !k.includes(".tmp-"));

    const w1 = await machine.writeTextIfUnchanged(casPath, "v1", { expected: "must-not-exist" });
    check("ssh-cas: must-not-exist creates via EXCL open", w1.bytesWritten === 2 && (await readTextFile(machine, casPath)) === "v1");

    let existsErr = false;
    try {
      await machine.writeTextIfUnchanged(casPath, "clobber", { expected: "must-not-exist" });
    } catch (error) {
      existsErr = error instanceof FileExistsError;
    }
    check("ssh-cas: must-not-exist on an existing file throws FileExistsError", existsErr && (await readTextFile(machine, casPath)) === "v1");

    const w2 = await machine.writeTextIfUnchanged(casPath, "v2", { expected: w1.version });
    check("ssh-cas: version-matched write swaps in via tmp+rename, no residue", (await readTextFile(machine, casPath)) === "v2" && noTmp());
    check("ssh-cas: returned version reflects the new write", w2.version.mtimeMs !== w1.version.mtimeMs);

    let stale = false;
    try {
      await machine.writeTextIfUnchanged(casPath, "v3", { expected: w1.version }); // w1.version is stale now
    } catch (error) {
      stale = error instanceof StaleFileError;
    }
    check("ssh-cas: stale version throws StaleFileError, target untouched", stale && (await readTextFile(machine, casPath)) === "v2" && noTmp());

    // External writer lands between the tmp upload and the pre-swap re-check.
    sftp.afterWriteFile = (p) => {
      if (p.includes(".tmp-")) {
        sftp._mtimes.set(casPath, 9_999);
        sftp.afterWriteFile = undefined;
      }
    };
    let raced = false;
    try {
      await machine.writeTextIfUnchanged(casPath, "v3", { expected: w2.version });
    } catch (error) {
      raced = error instanceof StaleFileError;
    }
    check("ssh-cas: external write between upload and swap → StaleFileError, tmp cleaned", raced && (await readTextFile(machine, casPath)) === "v2" && noTmp());

    // mtime moved but content unchanged (a linter touch) → expectedContent review passes.
    const touchedContent = await readTextFile(machine, casPath);
    const touchedVersion = fileVersionFromInfo(await machine.fileInfo(casPath));
    sftp._mtimes.set(casPath, 12_345);
    const w4 = await machine.writeTextIfUnchanged(casPath, "v4", { expected: touchedVersion, expectedContent: touchedContent });
    check("ssh-cas: mtime moved but expectedContent matches → write proceeds", w4.bytesWritten === 2 && (await readTextFile(machine, casPath)) === "v4");

    // The swap preserves the target's permission bits.
    sftp._modes.set(casPath, S_IFREG | 0o600);
    const w5 = await machine.writeTextIfUnchanged(casPath, "v5", { expected: w4.version });
    check("ssh-cas: swap preserves the target's mode", (sftp._modes.get(casPath)! & 0o7777) === 0o600 && (await readTextFile(machine, casPath)) === "v5");

    // Concurrent same-version writers: the path lock serializes; one wins, one detects it.
    const race = await Promise.allSettled([
      machine.writeTextIfUnchanged(casPath, "winner", { expected: w5.version }),
      machine.writeTextIfUnchanged(casPath, "loser", { expected: w5.version }),
    ]);
    const fulfilled = race.filter((r) => r.status === "fulfilled").length;
    const staleLosers = race.filter((r) => r.status === "rejected" && r.reason instanceof StaleFileError).length;
    check(
      "ssh-cas: concurrent writers serialize — one wins, the other gets StaleFileError",
      fulfilled === 1 && staleLosers === 1 && (await readTextFile(machine, casPath)) === "winner" && noTmp(),
    );

    // Server without posix-rename@openssh.com → unlink+rename fallback.
    sftp.posixRenameSupported = false;
    const cur = fileVersionFromInfo(await machine.fileInfo(casPath));
    await machine.writeTextIfUnchanged(casPath, "fallback", { expected: cur });
    check("ssh-cas: posix-rename unsupported degrades to unlink+rename", (await readTextFile(machine, casPath)) === "fallback" && noTmp());
    sftp.posixRenameSupported = true;
  }

  // ── BaseMachine composition: per-path lock + error taxonomy (in-memory backend) ──
  {
    class InMemMachine extends NullMachine {
      readonly files = new Map<string, Buffer>();
      readonly mtimes = new Map<string, number>();
      withMtime = true;
      private clock = 1;
      seed(p: string, content: string): void {
        this.files.set(p, Buffer.from(content));
        this.mtimes.set(p, ++this.clock);
      }
      override async fileInfo(p: string): Promise<FileInfo> {
        await new Promise((r) => setImmediate(r)); // widen the stat→write gap the lock must cover
        const f = this.files.get(p);
        if (f === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { kind: "file", size: f.byteLength, ...(this.withMtime ? { mtimeMs: this.mtimes.get(p)! * 1000 } : {}) };
      }
      override async readBytes(p: string): Promise<Buffer> {
        const f = this.files.get(p);
        if (f === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return f;
      }
      protected override async writeBytesRaw(p: string, data: Buffer): Promise<void> {
        await new Promise((r) => setImmediate(r));
        this.files.set(p, data);
        this.mtimes.set(p, ++this.clock);
      }
    }

    // Without the base path lock, both writers would pass the version check before
    // either write lands — a silent lost update. With it, the loser sees the winner.
    const mem = new InMemMachine();
    mem.seed("/f.txt", "seed");
    const v0 = { mtimeMs: mem.mtimes.get("/f.txt")! * 1000 };
    const race = await Promise.allSettled([
      mem.writeTextIfUnchanged("/f.txt", "AAAA", { expected: v0 }),
      mem.writeTextIfUnchanged("/f.txt", "BBBB", { expected: v0 }),
    ]);
    const okCount = race.filter((r) => r.status === "fulfilled").length;
    const staleCount = race.filter((r) => r.status === "rejected" && r.reason instanceof StaleFileError).length;
    const winner = race.find((r): r is PromiseFulfilledResult<WriteFileResult> => r.status === "fulfilled");
    check(
      "base-cas: path lock serializes in-process writers — no lost update",
      okCount === 1 && staleCount === 1 && mem.files.get("/f.txt")!.toString() === "AAAA",
    );
    check(
      "base-cas: returned version is the winner's own write (stamped inside the lock)",
      winner !== undefined && winner.value.version.mtimeMs === mem.mtimes.get("/f.txt")! * 1000,
    );

    // An mtime-less backend can never establish "unchanged" from the version alone —
    // no size to fall back on, so the write is REFUSED rather than waved through.
    const memNoM = new InMemMachine();
    memNoM.withMtime = false;
    memNoM.seed("/g.txt", "abcd");
    let refused = false;
    try {
      await memNoM.writeTextIfUnchanged("/g.txt", "next", { expected: {} });
    } catch (error) {
      refused = error instanceof StaleFileError;
    }
    check("base-cas: mtime-less + no expectedContent → StaleFileError (unverifiable is refused)", refused);
    check("base-cas: the refused write left the file untouched", memNoM.files.get("/g.txt")!.toString() === "abcd");

    const okByContent = await memNoM.writeTextIfUnchanged("/g.txt", "next", { expected: {}, expectedContent: "abcd" });
    check(
      "base-cas: mtime-less + matching expectedContent → write proceeds",
      okByContent.bytesWritten === 4 && memNoM.files.get("/g.txt")!.toString() === "next",
    );
  }

  // ── BaseMachine.realpath: a HUNG readlink times out (throws) instead of silently
  //    degrading the path-access symlink guard to string matching. The deadline must fire
  //    PROMPTLY — it is raced outside `run`, so a backend that takes its time stopping the
  //    command cannot hold up the caller that path-access is blocking on. ──
  {
    let aborted = false;
    class HangingRunMachine extends NullMachine {
      protected override realpathTimeoutMs = 50;
      override run(_argv: readonly string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<RunCommandResult>(() => {}); // never settles
      }
    }
    let timedOut = false;
    const startedAt = Date.now();
    try {
      await new HangingRunMachine().realpath("/some/path");
    } catch (error) {
      timedOut = (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    }
    const elapsed = Date.now() - startedAt;
    check("base-machine: hung readlink realpath throws ETIMEDOUT (fail closed, no normpath degrade)", timedOut);
    check("base-machine: the hung readlink run is aborted on timeout", aborted);
    check("base-machine: realpath rejects at its own deadline, not after the backend stops", elapsed < 1_000);
  }

  // ── BaseMachine.run: a process that survives the kill escalation must not hold the call
  //    open forever through pipes it never closes. ──
  {
    class UnkillableMachine extends NullMachine {
      protected override spawn(): Promise<SpawnedProcess> {
        return Promise.resolve({
          stdin: new PassThrough(),
          stdout: new PassThrough(), // never ends on its own
          stderr: new PassThrough(),
          exitCode: null,
          wait: () => new Promise<number>(() => {}),
          kill: async () => {}, // ignores every signal
        });
      }
      // Re-expose the base derivation NullMachine refuses, so this exercises `run` itself.
      override run(argv: readonly string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
        return BaseMachine.prototype.run.call(this, argv, options) as Promise<RunCommandResult>;
      }
      protected override sigtermGraceMs = 10;
    }
    const result = await new UnkillableMachine().run(["sleep", "forever"], { timeoutMs: 20 });
    check("base-machine: run returns even when the killed process never closes its pipes", result.timedOut);
    check("base-machine: an unkillable process is reported as NOT terminated", !result.terminated);
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MACHINE-EXT E2E PASS — shell-env + git-context + SSH (builder/process/SFTP)");
  } else {
    console.log("❌ MACHINE-EXT E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MACHINE-EXT E2E ERROR:", error);
  process.exit(1);
});
