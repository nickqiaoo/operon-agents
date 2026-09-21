/**
 * E2E for the E2B adapter against a fake sandbox that mimics the SDK's contract.
 *
 * The point is to prove the intent-shaped `run()` actually delivers what the machinery-shaped
 * a fabricated process handle could not on this backend: a timeout that really kills, an output cap that stops
 * accumulation, incremental output, and an exit code that admits when it is unknown.
 */
import { materializeWorkspace } from "operon-agents-core";
import type { E2BCommandHandle, E2BEntryInfo, E2BRunOpts, E2BSandbox } from "../e2b/e2b-api.ts";
import { E2BEnvironment } from "../e2b/environment.ts";
import { E2BWorkspace } from "../e2b/lifecycle.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
}

interface FakeCommand {
  /** Chunks streamed before the command settles. */
  readonly chunks?: readonly { stream: "stdout" | "stderr"; data: string }[];
  readonly exitCode?: number | null;
  /** Never settles on its own — only a kill ends it. */
  readonly hang?: boolean;
  readonly delayMs?: number;
  /** Reads stdin to EOF before exiting, like `cat` or a hook piping its input through `jq`. */
  readonly readsStdin?: boolean;
}

/** The SDK's `CommandExitError`: what `wait()` rejects with for every nonzero exit. */
function commandExitError(result: { exitCode: number; error?: string }): Error {
  return Object.assign(new Error(result.error ?? `exit status ${String(result.exitCode)}`), {
    name: "CommandExitError",
    result: { stdout: "", stderr: "", ...result },
  });
}

class FakeSandbox implements E2BSandbox {
  sandboxId = "sbx_fake";
  killed = false;
  readonly commandLog: string[] = [];
  readonly killedPids: number[] = [];
  readonly stdinLog: { pid: number; data: string }[] = [];
  lastRunOpts: E2BRunOpts | undefined;
  readonly closedStdinPids: number[] = [];
  /**
   * The deadline the SDK applies when `timeoutMs` is omitted — 60 000 in the real SDK, scaled
   * down here. When it passes, the event stream fails and `wait()` rejects; nothing is killed.
   */
  sdkDefaultTimeoutMs = 60_000;
  private readonly stdinClosers = new Map<number, () => void>();
  private nextPid = 100;
  private readonly script: (cmd: string) => FakeCommand;
  private readonly tree: Map<string, readonly E2BEntryInfo[]>;
  private readonly fileData = new Map<string, Buffer>();

  constructor(script: (cmd: string) => FakeCommand, tree: Map<string, readonly E2BEntryInfo[]> = new Map()) {
    this.script = script;
    this.tree = tree;
  }

  readonly commands = {
    run: async (command: string, opts?: E2BRunOpts): Promise<E2BCommandHandle> => {
      this.commandLog.push(command);
      this.lastRunOpts = opts;
      const spec = this.script(command);
      const pid = this.nextPid++;
      type Ending = { exitCode: number; error?: string } | { streamError: Error };
      let settle!: (ending: Ending) => void;
      let ended = false;
      const settled = new Promise<Ending>((resolve) => (settle = resolve));
      const end = (ending: Ending): void => {
        if (ended) return;
        ended = true;
        settle(ending);
      };

      // `timeoutMs` omitted = the SDK default deadline; `0` = none (connect-web drops it).
      const deadline = opts?.timeoutMs === undefined ? this.sdkDefaultTimeoutMs : opts.timeoutMs;
      if (deadline > 0) {
        setTimeout(() => end({ streamError: new Error("[deadline_exceeded] the operation timed out") }), deadline).unref();
      }
      const stdinClosed =
        spec.readsStdin === true && opts?.stdin === true
          ? new Promise<void>((resolve) => this.stdinClosers.set(pid, resolve))
          : Promise.resolve();

      void (async () => {
        for (const chunk of spec.chunks ?? []) {
          if (ended) return;
          if (chunk.stream === "stdout") await opts?.onStdout?.(chunk.data);
          else await opts?.onStderr?.(chunk.data);
        }
        if (spec.hang === true) return; // only a kill can end it
        await stdinClosed;
        if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
        end({ exitCode: spec.exitCode ?? 0 });
      })();

      return {
        pid,
        wait: async () => {
          const ending = await settled;
          if ("streamError" in ending) throw ending.streamError;
          if (ending.exitCode !== 0) throw commandExitError(ending);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        kill: async () => {
          this.killedPids.push(pid);
          // SIGKILL: the process ends with -1 and "signal: killed", which wait() rejects on.
          end({ exitCode: -1, error: "signal: killed" });
          return true;
        },
      };
    },
    kill: async (pid: number): Promise<boolean> => {
      this.killedPids.push(pid);
      return true;
    },
    sendStdin: async (pid: number, data: string): Promise<void> => {
      this.stdinLog.push({ pid, data });
    },
    closeStdin: async (pid: number): Promise<void> => {
      this.closedStdinPids.push(pid);
      this.stdinClosers.get(pid)?.();
    },
  };

  readWholeFileCount = 0;
  getInfoCount = 0;
  private clock = 1_700_000_000_000;
  private readonly mtimes = new Map<string, Date>();
  private readonly dirs = new Set<string>();
  private readonly symlinks = new Map<string, string>();

  /** Seed a file so a whole-file read has something to return (fallback-path tests). */
  seedFile(path: string, data: Buffer): void {
    this.fileData.set(path, data);
    this.mtimes.set(path, new Date((this.clock += 7)));
  }

  seedSymlink(path: string, target: string): void {
    this.symlinks.set(path, target);
  }

  /** The SDK's FileNotFoundError: a name, no errno code. */
  private notFound(path: string): Error {
    return Object.assign(new Error(`path '${path}' does not exist`), { name: "FileNotFoundError" });
  }

  writtenPaths(): readonly string[] {
    return [...this.fileData.keys()];
  }

  readonly files = {
    list: async (path: string): Promise<readonly E2BEntryInfo[]> => this.tree.get(path) ?? [],
    read: async (path: string): Promise<Uint8Array> => {
      this.readWholeFileCount++;
      const data = this.fileData.get(path);
      if (data === undefined) throw this.notFound(path);
      return data;
    },
    getInfo: async (path: string): Promise<E2BEntryInfo> => {
      this.getInfoCount++;
      const name = path.split("/").pop() ?? path;
      const link = this.symlinks.get(path);
      if (link !== undefined) return { name, path, type: "file", size: 999, modifiedTime: new Date(1), symlinkTarget: link };
      const data = this.fileData.get(path);
      if (data !== undefined) return { name, path, type: "file", size: data.byteLength, modifiedTime: this.mtimes.get(path)! };
      if (this.dirs.has(path) || this.tree.has(path)) return { name, path, type: "dir", size: 4096, modifiedTime: new Date(this.clock) };
      throw this.notFound(path);
    },
    // Mirrors the SDK exactly: it accepts `string | ArrayBuffer | Blob | ReadableStream` and
    // NOT a Uint8Array. Rejecting one here is the point — a Buffer handed straight through
    // would typecheck against a looser fake while failing against the real backend.
    write: async (path: string, data: string | ArrayBuffer): Promise<unknown> => {
      if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
        throw new TypeError(`E2B files.write takes string | ArrayBuffer, got ${Object.prototype.toString.call(data)}`);
      }
      this.fileData.set(path, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
      this.mtimes.set(path, new Date((this.clock += 7)));
      return undefined;
    },
    // Like the SDK: creates the parents too, and reports an existing path as `false`.
    makeDir: async (path: string): Promise<boolean> => {
      if (this.dirs.has(path) || this.fileData.has(path)) return false;
      this.dirs.add(path);
      return true;
    },
  };

  written(path: string): string | undefined {
    return this.fileData.get(path)?.toString("utf8");
  }

  async createSnapshot(): Promise<{ snapshotId?: string }> {
    return { snapshotId: `snap_of_${this.sandboxId}` };
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
}

async function testRunIntents(): Promise<void> {
  const sandbox = new FakeSandbox((cmd) => {
    if (cmd.startsWith("hang")) return { hang: true, chunks: [{ stream: "stdout", data: "partial" }] };
    if (cmd.startsWith("noisy")) {
      return { chunks: Array.from({ length: 10 }, () => ({ stream: "stdout" as const, data: "0123456789" })) };
    }
    if (cmd.startsWith("fail")) return { chunks: [{ stream: "stderr", data: "boom" }], exitCode: 3 };
    if (cmd.startsWith("slow")) return { chunks: [{ stream: "stdout", data: "built\n" }], delayMs: 150 };
    if (cmd.startsWith("cat")) return { readsStdin: true };
    return { chunks: [{ stream: "stdout", data: "hello\n" }], exitCode: 0 };
  });
  sandbox.sdkDefaultTimeoutMs = 60; // the SDK's 60 s default, scaled to test time
  const environment = new E2BEnvironment(() => sandbox, { cwd: "/work" });

  const ok = await environment.run(["echo", "hello"]);
  check("run: stdout captured, exit 0", ok.stdout === "hello\n" && ok.exitCode === 0);
  check("run: not timed out / not truncated", !ok.timedOut && !ok.truncated);

  // The SDK rejects wait() for a nonzero exit; for run() that is an outcome, not an error.
  const failed = await environment.run(["fail"]);
  check("run: nonzero exit surfaced", failed.exitCode === 3 && failed.stderr === "boom");

  // No caller timeout = no deadline. Left to the SDK default, a command outliving it failed.
  const slow = await environment.run(["slow"]);
  check("run: a command outliving the SDK's default deadline still completes", slow.exitCode === 0 && slow.stdout === "built\n");
  check("run: the SDK deadline is disabled — ours is enforced with a real kill", sandbox.lastRunOpts?.timeoutMs === 0);
  const slowCapped = await new E2BEnvironment(() => sandbox, { cwd: "/work", defaultTimeoutMs: 40 }).run(["slow"]);
  check("run: defaultTimeoutMs is enforced by our own timer", slowCapped.timedOut && slowCapped.terminated);

  // Incremental delivery — the thing a buffered backend cannot do.
  const seen: string[] = [];
  await environment.run(["echo", "hello"], { onOutput: (c) => seen.push(c.data) });
  check("run: onOutput received chunks incrementally", seen.length === 1 && seen[0] === "hello\n");

  // Timeout must actually kill and must NOT report a fabricated exit code.
  const killsBefore = sandbox.killedPids.length;
  const timed = await environment.run(["hang"], { timeoutMs: 50 });
  check("run: timeout reported", timed.timedOut);
  check("run: timeout actually terminated the process", timed.terminated && sandbox.killedPids.length === killsBefore + 1);
  check("run: exitCode is undefined, not a fabricated 0", timed.exitCode === undefined);
  check("run: partial output before the kill is kept", timed.stdout === "partial");

  // Output cap stops accumulation (10 chunks x 10 bytes, capped at 25).
  const capped = await environment.run(["noisy"], { maxOutputBytes: 25 });
  check("run: truncated flag set", capped.truncated);
  check("run: output stopped at the cap", capped.stdout.length === 25);

  // Abort signal cancels a running command.
  const controller = new AbortController();
  const pending = environment.run(["hang"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const aborted = await pending;
  check("run: abort terminated the command", aborted.terminated);

  const preAborted = await environment.run(["echo"], { signal: AbortSignal.abort() });
  check("run: pre-aborted signal short-circuits", preAborted.exitCode === undefined && preAborted.stdout === "");

  // stdin rides the vendor's sendStdin channel. The regression this locks: it used to be
  // dropped in silence, so a hook fed input saw EOF and "succeeded" on empty data.
  await environment.run(["cat"], { stdin: "fed-in" });
  check("run: stdin opened the vendor's stdin channel", sandbox.lastRunOpts?.stdin === true);
  check("run: stdin payload reached sendStdin", sandbox.stdinLog.length === 1 && sandbox.stdinLog[0]?.data === "fed-in");
  // `cat` exits only at EOF — this run returning at all is the proof stdin was closed.
  check("run: stdin is closed after the payload, so a reader sees EOF", sandbox.closedStdinPids.length === 1);

  // An SDK build without sendStdin must REFUSE, not silently drop the input.
  const noStdin = new FakeSandbox(() => ({ exitCode: 0 }));
  delete (noStdin.commands as { sendStdin?: unknown }).sendStdin;
  let refused = false;
  try {
    await new E2BEnvironment(noStdin, { cwd: "/work" }).run(["cat"], { stdin: "x" });
  } catch {
    refused = true;
  }
  check("run: stdin on a backend without sendStdin throws instead of dropping it", refused);
}

async function testFilesAndListing(): Promise<void> {
  const tree = new Map<string, readonly E2BEntryInfo[]>([
    ["/work", [
      { name: "src", path: "/work/src", type: "dir" },
      { name: "a.ts", path: "/work/a.ts", type: "file" },
      { name: "weird", path: "/work/weird" }, // type absent → "other"
    ]],
  ]);
  const sandbox = new FakeSandbox(() => ({ exitCode: 0 }), tree);
  const environment = new E2BEnvironment(() => sandbox, { cwd: "/work" });

  const entries = [...(await environment.listDir("/work"))];
  check("listDir: single round trip carries kinds", sandbox.commandLog.length === 0);
  check(
    "listDir: kinds mapped (absent type → other)",
    entries.map((e) => `${e.name}:${e.kind}`).join(",") === "src:dir,a.ts:file,weird:other",
  );

  await environment.writeText("/work/out.txt", "content");
  check("writeText: reached the sandbox filesystem", sandbox.written("/work/out.txt") === "content");

  const relative = environment.withCwd("/work/src");
  check("withCwd: re-roots without mutating the original", relative.getcwd() === "/work/src" && environment.getcwd() === "/work");
}

/**
 * `readBytes(path, n)` must take the prefix ON THE FAR SIDE. Slicing a whole-file read would
 * satisfy the signature while pulling the entire file over HTTP — which is what the Read
 * tool's media sniff would then pay for every image in the sandbox, however large.
 */
async function testPrefixReadPushdown(): Promise<void> {
  const payload = Buffer.concat([Buffer.from("\x89PNG\r\n"), Buffer.alloc(64, 0xff)]);
  const sandbox = new FakeSandbox((cmd) =>
    cmd.includes("head -c")
      ? { chunks: [{ stream: "stdout", data: `${payload.subarray(0, 6).toString("base64")}\n` }], exitCode: 0 }
      : { exitCode: 0 },
  );
  const environment = new E2BEnvironment(() => sandbox, { cwd: "/work" });

  const head = await environment.readBytes("/work/img.png", { length: 6 });
  check("readBytes(range): cut the window on the far side, not by slicing a whole-file read", sandbox.commandLog.some((c) => c.includes("tail -c +1") && c.includes("head -c 6")));
  check("readBytes(range): binary survives the base64 round trip", head.equals(payload.subarray(0, 6)));
  check("readBytes(range): never touched the whole-file API", sandbox.readWholeFileCount === 0);

  // No `head`/`base64` in the image → fall back to the whole-file read rather than fail.
  const bare = new FakeSandbox(() => ({ exitCode: 127 }));
  bare.seedFile("/work/img.png", payload);
  const fallback = await new E2BEnvironment(() => bare, { cwd: "/work" }).readBytes("/work/img.png", { length: 6 });
  check("readBytes(range): degrades to a whole-file read when the shell tools are missing", fallback.equals(payload.subarray(0, 6)));
}

/**
 * Writes go STRAIGHT to the target: one vendor call, no temp path and no `mv`. The swap
 * this replaced bought atomicity that only mattered to the CAS write, and charged two
 * extra round trips for it on every write.
 */
async function testDirectWrite(): Promise<void> {
  const sandbox = new FakeSandbox(() => ({ exitCode: 0 }));
  const environment = new E2BEnvironment(() => sandbox, { cwd: "/work" });

  await environment.writeText("/work/f.txt", "new");
  check("write: lands on the target itself", sandbox.written("/work/f.txt") === "new");
  check("write: no temp path is staged", [...sandbox.writtenPaths()].every((p) => !p.includes(".tmp")));
  check("write: no shell command — a write is one vendor call", sandbox.commandLog.length === 0);
}

/**
 * `stat` is asked for the mtime twice: `%Y` (whole seconds, universally supported) and
 * `%.3Y` (with the millisecond fraction). Whole seconds are too coarse to decide freshness
 * — a linter rewriting a file in the same second the agent read it leaves the mtime
 * unchanged, and the stale write sails through — so the fraction is used when the image's
 * `stat` produced one, and ignored, not trusted, when it did not.
 */
async function testStatParsing(): Promise<void> {
  // The `stat(1)` path, as taken by an SDK build without getInfo (and by symlinks, and Cloudflare).
  const statting = (line: string): FakeSandbox => {
    const sandbox = new FakeSandbox((cmd) =>
      cmd.includes("stat") ? { chunks: [{ stream: "stdout", data: `${line}\n` }], exitCode: 0 } : { exitCode: 1 },
    );
    delete (sandbox.files as { getInfo?: unknown }).getInfo;
    return sandbox;
  };
  const infoFrom = async (line: string) => await new E2BEnvironment(() => statting(line), { cwd: "/work" }).fileInfo("/work/a.ts");

  const precise = await infoFrom("regular file|1234|1700000000|1700000000.456");
  check(
    "fileInfo: kind/size parsed from one stat",
    precise.kind === "file" && precise.size === 1234,
  );
  check("fileInfo: sub-second mtime is kept (same-second edits stay distinguishable)", precise.mtimeMs === 1700000000456);

  // BusyBox understands `%Y` but not the precision specifier, and echoes it back verbatim.
  const busybox = await infoFrom("regular file|1234|1700000000|%.3Y");
  check("fileInfo: unsupported %.3Y degrades to whole seconds, not to NaN", busybox.mtimeMs === 1700000000000);

  // An older image whose stat drops the field entirely rather than echoing it.
  const missing = await infoFrom("regular file|1234|1700000000");
  check("fileInfo: absent fraction degrades to whole seconds", missing.mtimeMs === 1700000000000);

  // A fraction that disagrees with its own whole-second field did not come from this stat.
  const mismatched = await infoFrom("regular file|1234|1700000000|9999999999.999");
  check("fileInfo: fraction inconsistent with %Y is discarded", mismatched.mtimeMs === 1700000000000);

  // mtime 0 means the backend has no clock for this file — report it as absent so the
  // freshness check falls back to content comparison instead of trusting 1970.
  const clockless = await infoFrom("regular file|1234|0|0");
  check("fileInfo: mtime 0 is reported as absent, not as 1970", clockless.mtimeMs === undefined);
}

async function testSnapshotSwap(): Promise<void> {
  const first = new FakeSandbox(() => ({ chunks: [{ stream: "stdout", data: "first" }], exitCode: 0 }));
  const second = new FakeSandbox(() => ({ chunks: [{ stream: "stdout", data: "second" }], exitCode: 0 }));
  second.sandboxId = "sbx_restored";
  let created = 0;

  const workspace = await E2BWorkspace.open({
    sandbox: {
      create: async () => (created++ === 0 ? first : second),
    },
  });
  const environment = workspace.environment; // captured BEFORE the restore, as a tool would hold it

  check("workspace: initial sandbox in use", (await environment.run(["x"])).stdout === "first");

  const snapshotId = await workspace.snapshot();
  check("workspace: snapshot id returned", snapshotId === "snap_of_sbx_fake");

  await workspace.restore(snapshotId!);
  // The critical property: an environment handed out earlier keeps working after the swap.
  check("restore: previously-handed-out environment follows the swap", (await environment.run(["x"])).stdout === "second");
  check("restore: old sandbox retired", first.killed);
  check("restore: state reports the new sandbox id", workspace.state().sandboxId === "sbx_restored");
}

async function testWorkspaceSpec(): Promise<void> {
  const sandbox = new FakeSandbox((cmd) => (cmd.startsWith("git clone") ? { exitCode: 0 } : { exitCode: 0 }));
  const environment = new E2BEnvironment(() => sandbox, { cwd: "/work" });

  await materializeWorkspace(environment, {
    root: "/work",
    entries: {
      "repo": { type: "git_repo", repo: "https://example.com/app.git", ref: "main" },
      ".npmrc": { type: "file", content: "registry=https://example.com\n" },
      "cfg": { type: "dir", children: { "app.json": { type: "file", content: "{}" } } },
    },
  });

  check("workspace-spec: git_repo cloned shallow at the requested ref",
    sandbox.commandLog.some((c) => c.includes("git clone") && c.includes("--depth 1") && c.includes("--branch main")));
  check("workspace-spec: inline file written", sandbox.written("/work/.npmrc")?.startsWith("registry=") === true);
  check("workspace-spec: nested child written", sandbox.written("/work/cfg/app.json") === "{}");

  let escaped = false;
  try {
    await materializeWorkspace(environment, { root: "/work", entries: { "../escape": { type: "file", content: "x" } } });
  } catch {
    escaped = true;
  }
  check("workspace-spec: path escaping the root is refused", escaped);
}

/**
 * File metadata is one envd RPC, not a command. Every Read, Edit and Write stats its file, and
 * each `stat(1)` used to be a whole process start through a login shell — the largest per-call
 * cost on this backend. A write reports the version it produced, so the read-state record keeps
 * its mtime fast path instead of re-downloading the file to compare contents.
 */
async function testNativeMetadata(): Promise<void> {
  const sandbox = new FakeSandbox(() => ({ exitCode: 1 }));
  const environment = new E2BEnvironment(() => sandbox, { cwd: "/work" });
  sandbox.seedFile("/work/a.ts", Buffer.from("hello"));

  const info = await environment.fileInfo("/work/a.ts");
  check("fileInfo: kind, size and mtime from getInfo", info.kind === "file" && info.size === 5 && typeof info.mtimeMs === "number");
  check("fileInfo: no command was started", sandbox.commandLog.length === 0);

  let missingCode: unknown;
  try {
    await environment.fileInfo("/work/nope.ts");
  } catch (error) {
    missingCode = (error as NodeJS.ErrnoException).code;
  }
  check("fileInfo: a missing path is ENOENT, still without a command", missingCode === "ENOENT" && sandbox.commandLog.length === 0);

  let readCode: unknown;
  try {
    await environment.readBytes("/work/nope.ts");
  } catch (error) {
    readCode = (error as NodeJS.ErrnoException).code;
  }
  check("readBytes: a missing file is ENOENT (append-to-new-file depends on it)", readCode === "ENOENT");

  const written = await environment.writeText("/work/a.ts", "changed");
  const after = await environment.fileInfo("/work/a.ts");
  check("writeText: reports the version it produced", written.version?.mtimeMs !== undefined && written.version.mtimeMs === after.mtimeMs);
  check("writeText: and that version moved", written.version?.mtimeMs !== info.mtimeMs);

  sandbox.seedSymlink("/work/link.ts", "/work/a.ts");
  const statsBefore = sandbox.commandLog.filter((c) => c.includes("stat")).length;
  await environment.fileInfo("/work/link.ts").catch(() => undefined);
  check("fileInfo: a symlink goes to stat(1), whose follow semantics are exact", sandbox.commandLog.filter((c) => c.includes("stat")).length === statsBefore + 1);
  const linkWrite = await environment.writeText("/work/link.ts", "via link");
  check("writeText: through a symlink reports no version (a different source than its fileInfo)", linkWrite.version === undefined);

  await environment.mkdir("/work/deep/nested/dir", { parents: true });
  await environment.mkdir("/work/deep/nested/dir", { parents: true });
  check("mkdir -p: native makeDir, no command, idempotent", sandbox.commandLog.filter((c) => c.includes("mkdir")).length === 0);
  let fileInTheWay: unknown;
  try {
    await environment.mkdir("/work/a.ts", { parents: true });
  } catch (error) {
    fileInTheWay = (error as NodeJS.ErrnoException).code;
  }
  check("mkdir -p: a file in the way is still an error", fileInTheWay === "EEXIST");

  const listing = new FakeSandbox(() => ({ exitCode: 0 }), new Map([["/work", [
    { name: "real.ts", path: "/work/real.ts", type: "file" as const },
    { name: "alias.ts", path: "/work/alias.ts", type: "file" as const, symlinkTarget: "/work/real.ts" },
  ]]]));
  const kinds = (await new E2BEnvironment(() => listing, { cwd: "/work" }).listDir("/work")).map((e) => `${e.name}:${e.kind}`).join(",");
  check("listDir: a symlink is reported as a symlink (lstat semantics)", kinds === "real.ts:file,alias.ts:symlink");
}

await testRunIntents();
await testFilesAndListing();
await testNativeMetadata();
await testStatParsing();
await testPrefixReadPushdown();
await testDirectWrite();
await testSnapshotSwap();
await testWorkspaceSpec();

console.log(failures === 0 ? "\n✅ E2B ENVIRONMENT E2E PASS" : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
