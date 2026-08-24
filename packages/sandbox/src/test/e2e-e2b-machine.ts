/**
 * E2E for the E2B adapter against a fake sandbox that mimics the SDK's contract.
 *
 * The point is to prove the intent-shaped `run()` actually delivers what the machinery-shaped
 * a fabricated process handle could not on this backend: a timeout that really kills, an output cap that stops
 * accumulation, incremental output, and an exit code that admits when it is unknown.
 */
import { materializeWorkspace } from "operon-agents-core";
import type { E2BCommandHandle, E2BEntryInfo, E2BRunOpts, E2BSandbox } from "../e2b/e2b-api.ts";
import { E2BMachine } from "../e2b/machine.ts";
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
}

class FakeSandbox implements E2BSandbox {
  sandboxId = "sbx_fake";
  killed = false;
  readonly commandLog: string[] = [];
  readonly killedPids: number[] = [];
  readonly stdinLog: { pid: number; data: string }[] = [];
  lastRunOpts: E2BRunOpts | undefined;
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
      let settle!: (r: { exitCode: number | null }) => void;
      const settled = new Promise<{ exitCode: number | null }>((resolve) => (settle = resolve));
      const killedFlag = { value: false };

      void (async () => {
        for (const chunk of spec.chunks ?? []) {
          if (killedFlag.value) return;
          if (chunk.stream === "stdout") await opts?.onStdout?.(chunk.data);
          else await opts?.onStderr?.(chunk.data);
        }
        if (spec.hang === true) return; // only a kill can end it
        if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
        if (!killedFlag.value) settle({ exitCode: spec.exitCode ?? 0 });
      })();

      return {
        pid,
        wait: () => settled,
        kill: async () => {
          killedFlag.value = true;
          this.killedPids.push(pid);
          settle({ exitCode: null });
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
  };

  readWholeFileCount = 0;

  /** Seed a file so a whole-file read has something to return (fallback-path tests). */
  seedFile(path: string, data: Buffer): void {
    this.fileData.set(path, data);
  }

  writtenPaths(): readonly string[] {
    return [...this.fileData.keys()];
  }

  readonly files = {
    list: async (path: string): Promise<readonly E2BEntryInfo[]> => this.tree.get(path) ?? [],
    read: async (path: string): Promise<Uint8Array> => {
      this.readWholeFileCount++;
      return this.fileData.get(path) ?? Buffer.alloc(0);
    },
    // Mirrors the SDK exactly: it accepts `string | ArrayBuffer | Blob | ReadableStream` and
    // NOT a Uint8Array. Rejecting one here is the point — a Buffer handed straight through
    // would typecheck against a looser fake while failing against the real backend.
    write: async (path: string, data: string | ArrayBuffer): Promise<unknown> => {
      if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
        throw new TypeError(`E2B files.write takes string | ArrayBuffer, got ${Object.prototype.toString.call(data)}`);
      }
      this.fileData.set(path, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
      return undefined;
    },
    makeDir: async (): Promise<boolean> => true,
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
    return { chunks: [{ stream: "stdout", data: "hello\n" }], exitCode: 0 };
  });
  const machine = new E2BMachine(() => sandbox, { cwd: "/work" });

  const ok = await machine.run(["echo", "hello"]);
  check("run: stdout captured, exit 0", ok.stdout === "hello\n" && ok.exitCode === 0);
  check("run: not timed out / not truncated", !ok.timedOut && !ok.truncated);

  const failed = await machine.run(["fail"]);
  check("run: nonzero exit surfaced", failed.exitCode === 3 && failed.stderr === "boom");

  // Incremental delivery — the thing a buffered backend cannot do.
  const seen: string[] = [];
  await machine.run(["echo", "hello"], { onOutput: (c) => seen.push(c.data) });
  check("run: onOutput received chunks incrementally", seen.length === 1 && seen[0] === "hello\n");

  // Timeout must actually kill and must NOT report a fabricated exit code.
  const timed = await machine.run(["hang"], { timeoutMs: 50 });
  check("run: timeout reported", timed.timedOut);
  check("run: timeout actually terminated the process", timed.terminated && sandbox.killedPids.length === 1);
  check("run: exitCode is undefined, not a fabricated 0", timed.exitCode === undefined);
  check("run: partial output before the kill is kept", timed.stdout === "partial");

  // Output cap stops accumulation (10 chunks x 10 bytes, capped at 25).
  const capped = await machine.run(["noisy"], { maxOutputBytes: 25 });
  check("run: truncated flag set", capped.truncated);
  check("run: output stopped at the cap", capped.stdout.length === 25);

  // Abort signal cancels a running command.
  const controller = new AbortController();
  const pending = machine.run(["hang"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const aborted = await pending;
  check("run: abort terminated the command", aborted.terminated);

  const preAborted = await machine.run(["echo"], { signal: AbortSignal.abort() });
  check("run: pre-aborted signal short-circuits", preAborted.exitCode === undefined && preAborted.stdout === "");

  // stdin rides the vendor's sendStdin channel. The regression this locks: it used to be
  // dropped in silence, so a hook fed input saw EOF and "succeeded" on empty data.
  await machine.run(["cat"], { stdin: "fed-in" });
  check("run: stdin opened the vendor's stdin channel", sandbox.lastRunOpts?.stdin === true);
  check("run: stdin payload reached sendStdin", sandbox.stdinLog.length === 1 && sandbox.stdinLog[0]?.data === "fed-in");

  // An SDK build without sendStdin must REFUSE, not silently drop the input.
  const noStdin = new FakeSandbox(() => ({ exitCode: 0 }));
  delete (noStdin.commands as { sendStdin?: unknown }).sendStdin;
  let refused = false;
  try {
    await new E2BMachine(noStdin, { cwd: "/work" }).run(["cat"], { stdin: "x" });
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
  const machine = new E2BMachine(() => sandbox, { cwd: "/work" });

  const entries = [...(await machine.listDir("/work"))];
  check("listDir: single round trip carries kinds", sandbox.commandLog.length === 0);
  check(
    "listDir: kinds mapped (absent type → other)",
    entries.map((e) => `${e.name}:${e.kind}`).join(",") === "src:dir,a.ts:file,weird:other",
  );

  await machine.writeText("/work/out.txt", "content");
  check("writeText: reached the sandbox filesystem", sandbox.written("/work/out.txt") === "content");

  const relative = machine.withCwd("/work/src");
  check("withCwd: re-roots without mutating the original", relative.getcwd() === "/work/src" && machine.getcwd() === "/work");
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
  const machine = new E2BMachine(() => sandbox, { cwd: "/work" });

  const head = await machine.readBytes("/work/img.png", { length: 6 });
  check("readBytes(range): cut the window on the far side, not by slicing a whole-file read", sandbox.commandLog.some((c) => c.includes("tail -c +1") && c.includes("head -c 6")));
  check("readBytes(range): binary survives the base64 round trip", head.equals(payload.subarray(0, 6)));
  check("readBytes(range): never touched the whole-file API", sandbox.readWholeFileCount === 0);

  // No `head`/`base64` in the image → fall back to the whole-file read rather than fail.
  const bare = new FakeSandbox(() => ({ exitCode: 127 }));
  bare.seedFile("/work/img.png", payload);
  const fallback = await new E2BMachine(() => bare, { cwd: "/work" }).readBytes("/work/img.png", { length: 6 });
  check("readBytes(range): degrades to a whole-file read when the shell tools are missing", fallback.equals(payload.subarray(0, 6)));
}

/**
 * The CAS write must land all-or-nothing. `files.write` alone cannot promise that, so the
 * bytes go to a sibling temp path and `mv` swaps them in — the rename is the atomic step.
 */
async function testAtomicCasSwap(): Promise<void> {
  const sandbox = new FakeSandbox((cmd) =>
    cmd.includes("stat")
      ? { chunks: [{ stream: "stdout", data: "regular file|3|1700000000\n" }], exitCode: 0 }
      : { exitCode: 0 },
  );
  const machine = new E2BMachine(() => sandbox, { cwd: "/work" });

  await machine.writeTextIfUnchanged("/work/f.txt", "new", { expected: { mtimeMs: 1700000000000 } });
  const tempWrite = [...sandbox.writtenPaths()].find((p) => p.includes(".tmp"));
  check("CAS write: bytes went to a temp path first", tempWrite !== undefined);
  check("CAS write: temp file is a SIBLING (a cross-device mv would not be atomic)", tempWrite?.startsWith("/work/") === true);
  check("CAS write: swapped in with mv", sandbox.commandLog.some((c) => c.includes("mv") && c.includes(".tmp")));

  // Unconditional writes stay a single round trip — the temp+swap cost is only for CAS.
  const plain = new FakeSandbox(() => ({ exitCode: 0 }));
  await new E2BMachine(() => plain, { cwd: "/work" }).writeText("/work/g.txt", "x");
  check("plain writeText: no temp file, no mv", plain.commandLog.length === 0 && plain.written("/work/g.txt") === "x");
}

/**
 * `stat` is asked for the mtime twice: `%Y` (whole seconds, universally supported) and
 * `%.3Y` (with the millisecond fraction). Whole seconds are too coarse to decide freshness
 * — a linter rewriting a file in the same second the agent read it leaves the mtime
 * unchanged, and the stale write sails through — so the fraction is used when the image's
 * `stat` produced one, and ignored, not trusted, when it did not.
 */
async function testStatParsing(): Promise<void> {
  const statting = (line: string): FakeSandbox =>
    new FakeSandbox((cmd) =>
      cmd.includes("stat") ? { chunks: [{ stream: "stdout", data: `${line}\n` }], exitCode: 0 } : { exitCode: 1 },
    );
  const infoFrom = async (line: string) => await new E2BMachine(() => statting(line), { cwd: "/work" }).fileInfo("/work/a.ts");

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
  const machine = workspace.machine; // captured BEFORE the restore, as a tool would hold it

  check("workspace: initial sandbox in use", (await machine.run(["x"])).stdout === "first");

  const snapshotId = await workspace.snapshot();
  check("workspace: snapshot id returned", snapshotId === "snap_of_sbx_fake");

  await workspace.restore(snapshotId!);
  // The critical property: a machine handed out earlier keeps working after the swap.
  check("restore: previously-handed-out machine follows the swap", (await machine.run(["x"])).stdout === "second");
  check("restore: old sandbox retired", first.killed);
  check("restore: state reports the new sandbox id", workspace.state().sandboxId === "sbx_restored");
}

async function testWorkspaceSpec(): Promise<void> {
  const sandbox = new FakeSandbox((cmd) => (cmd.startsWith("git clone") ? { exitCode: 0 } : { exitCode: 0 }));
  const machine = new E2BMachine(() => sandbox, { cwd: "/work" });

  await materializeWorkspace(machine, {
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
    await materializeWorkspace(machine, { root: "/work", entries: { "../escape": { type: "file", content: "x" } } });
  } catch {
    escaped = true;
  }
  check("workspace-spec: path escaping the root is refused", escaped);
}

await testRunIntents();
await testFilesAndListing();
await testStatParsing();
await testPrefixReadPushdown();
await testAtomicCasSwap();
await testSnapshotSwap();
await testWorkspaceSpec();

console.log(failures === 0 ? "\n✅ E2B MACHINE E2E PASS" : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
