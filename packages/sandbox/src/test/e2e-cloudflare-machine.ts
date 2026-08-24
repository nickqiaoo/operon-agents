/**
 * E2E for the Cloudflare adapter against a fake SandboxClient that mimics the route
 * transport's contract.
 *
 * The point is the two-path `run()`: a plain run takes the cheap one-round-trip
 * `commands.execute`, while anything asking for cancellation, incremental output or an
 * output cap takes the `startProcess` + SSE-logs + `killProcess` path — where a timeout
 * really kills, a cap really stops the command, and an exit code admits when it is unknown.
 */
import { materializeWorkspace } from "operon-agents-core";
import { CloudflareMachine } from "../cloudflare/machine.ts";
import { CloudflareWorkspace } from "../cloudflare/lifecycle.ts";
import type {
  CloudflareExecOptions,
  CloudflareFileEntry,
  CloudflareSandboxClient,
} from "../cloudflare/cf-api.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
}

interface FakeProcess {
  /** Chunks streamed before the process settles. */
  readonly chunks: ReadonlyArray<{ stream: "stdout" | "stderr"; data: string }>;
  /** Never emits `exit` and never ends on its own — only a kill stops it. */
  readonly hangs?: boolean;
  readonly exitCode?: number;
}

class FakeClient implements CloudflareSandboxClient {
  readonly executed: string[] = [];
  readonly started: string[] = [];
  readonly killed: string[] = [];
  readonly archives: Array<{ dir: string; path: string }> = [];
  readonly written = new Map<string, Buffer>();
  readonly dirs = new Set<string>(["/workspace"]);
  readonly clones: Array<{ repo: string; depth?: number; branch?: string }> = [];
  lastExecOptions: CloudflareExecOptions | undefined;

  private seq = 0;
  private readonly live = new Map<string, { proc: FakeProcess; kill: () => void }>();
  private readonly plan: (command: string) => FakeProcess;

  constructor(plan: (command: string) => FakeProcess) {
    this.plan = plan;
  }

  readonly commands = {
    execute: async (command: string, _sessionId: string, options?: CloudflareExecOptions) => {
      this.executed.push(command);
      this.lastExecOptions = options;
      const proc = this.plan(command);
      return {
        stdout: proc.chunks.filter((c) => c.stream === "stdout").map((c) => c.data).join(""),
        stderr: proc.chunks.filter((c) => c.stream === "stderr").map((c) => c.data).join(""),
        exitCode: proc.exitCode ?? 0,
      };
    },
  };

  readonly processes = {
    startProcess: async (command: string, _sessionId: string, options?: CloudflareExecOptions) => {
      this.started.push(command);
      this.lastExecOptions = options;
      const processId = `proc-${String(++this.seq)}`;
      this.live.set(processId, { proc: this.plan(command), kill: () => {} });
      return { processId };
    },
    getProcess: async (processId: string) => ({
      process: { id: processId, status: "completed", exitCode: this.live.get(processId)?.proc.exitCode ?? 0 },
    }),
    killProcess: async (processId: string) => {
      this.killed.push(processId);
      this.live.get(processId)?.kill();
      return { success: true };
    },
    killAllProcesses: async () => ({ success: true }),
    streamProcessLogs: async (processId: string) => {
      const entry = this.live.get(processId)!;
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          const encoder = new TextEncoder();
          const frame = (event: unknown): void =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          let closed = false;
          const close = (): void => {
            if (closed) return;
            closed = true;
            controller.close();
          };
          // A kill ends the log stream at once — the real contract, and what makes the
          // `terminated` bookkeeping in run() observable.
          entry.kill = close;
          let i = 0;
          const pump = (): void => {
            if (closed) return;
            if (i < entry.proc.chunks.length) {
              const chunk = entry.proc.chunks[i++]!;
              frame({ type: chunk.stream, data: chunk.data, processId });
              setTimeout(pump, 1);
              return;
            }
            if (entry.proc.hangs === true) return; // waits for a kill
            frame({ type: "exit", exitCode: entry.proc.exitCode ?? 0, processId, data: "" });
            close();
          };
          setTimeout(pump, 1);
        },
      });
    },
  };

  readonly files = {
    mkdir: async (path: string) => {
      this.dirs.add(path);
      return { success: true };
    },
    writeFile: async (path: string, content: string, _s: string, options?: { encoding?: string }) => {
      this.written.set(path, Buffer.from(content, options?.encoding === "base64" ? "base64" : "utf8"));
      return { success: true };
    },
    readFile: async (path: string) => {
      const bytes = this.written.get(path);
      if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
      return { content: bytes.toString("base64") };
    },
    listFiles: async (path: string) => {
      const files: CloudflareFileEntry[] = [
        { name: "src", isDirectory: true },
        { name: "readme.md", isDirectory: false },
        { name: "link", type: "file" },
      ];
      return { files: path === "/workspace" ? files : [] };
    },
  };

  readonly git = {
    checkout: async (repoUrl: string, _s: string, options?: { branch?: string; depth?: number }) => {
      this.clones.push({ repo: repoUrl, ...options });
      return { success: true };
    },
  };

  readonly backup = {
    createArchive: async (dir: string, archivePath: string) => {
      this.archives.push({ dir, path: archivePath });
      return { success: true };
    },
    restoreArchive: async () => ({ success: true }),
  };
}

const ok = (chunks: FakeProcess["chunks"], exitCode = 0): FakeProcess => ({ chunks, exitCode });

async function testCheapPath(): Promise<void> {
  const client = new FakeClient(() => ok([{ stream: "stdout", data: "hi\n" }]));
  const machine = new CloudflareMachine(client, { cwd: "/workspace" });

  const result = await machine.run(["echo", "hi"]);
  check("cheap path: plain run uses commands.execute (one round trip)", client.executed.length === 1 && client.started.length === 0);
  check("cheap path: stdout returned", result.stdout === "hi\n");
  check("cheap path: exit code reported", result.exitCode === 0);
  check("cheap path: argv is quoted into one command string", client.executed[0] === "echo hi");
  check("cheap path: cwd passed to the vendor", client.lastExecOptions?.cwd === "/workspace");

  await machine.run(["sleep", "9"], { timeoutMs: 4_000 });
  check("cheap path: timeout handed to the vendor natively", client.lastExecOptions?.timeoutMs === 4_000);
}

async function testStreamingAndCap(): Promise<void> {
  const client = new FakeClient(() =>
    ok([
      { stream: "stdout", data: "one" },
      { stream: "stderr", data: "warn" },
      { stream: "stdout", data: "two" },
    ]),
  );
  const machine = new CloudflareMachine(client, { cwd: "/workspace" });

  const seen: string[] = [];
  const streamed = await machine.run(["build"], { onOutput: (c) => seen.push(`${c.stream}:${c.data}`) });
  check("stream: onOutput takes the process path, not execute", client.started.length === 1 && client.executed.length === 0);
  check("stream: output arrives incrementally, in order", seen.join("|") === "stdout:one|stderr:warn|stdout:two");
  check("stream: streams stay separated", streamed.stdout === "onetwo" && streamed.stderr === "warn");
  check("stream: exit code read from the exit event", streamed.exitCode === 0);

  const capped = await machine.run(["build"], { maxOutputBytes: 4 });
  check("cap: output cut at the limit", capped.stdout === "one" && capped.truncated);
  check("cap: the command is actually killed, not just trimmed", client.killed.length === 1);
  check("cap: a killed run reports no exit code", capped.exitCode === undefined && capped.terminated);
}

async function testTimeoutAndAbort(): Promise<void> {
  const hanging = (): FakeProcess => ({ chunks: [{ stream: "stdout", data: "partial" }], hangs: true });

  const timeoutClient = new FakeClient(hanging);
  const timeoutMachine = new CloudflareMachine(timeoutClient, { cwd: "/workspace" });
  const timedOut = await timeoutMachine.run(["sleep", "60"], { timeoutMs: 40, onOutput: () => {} });
  check("timeout: reported as timed out", timedOut.timedOut);
  check("timeout: the process was really killed", timedOut.terminated && timeoutClient.killed.length === 1);
  check("timeout: partial output is kept", timedOut.stdout === "partial");
  check("timeout: exit code is undefined, not a fabricated 0", timedOut.exitCode === undefined);

  const abortClient = new FakeClient(hanging);
  const abortMachine = new CloudflareMachine(abortClient, { cwd: "/workspace" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const aborted = await abortMachine.run(["sleep", "60"], { signal: controller.signal });
  check("abort: the process was really killed", aborted.terminated && abortClient.killed.length === 1);
  check("abort: exit code is undefined", aborted.exitCode === undefined);
}

async function testFilesAndListing(): Promise<void> {
  const client = new FakeClient(() => ok([{ stream: "stdout", data: "regular file|11|1700000000\n" }]));
  const machine = new CloudflareMachine(client, { cwd: "/workspace" });

  // Binary round trip: base64 is the only byte-safe route over this transport.
  const payload = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  await machine.writeBytes("/workspace/blob.bin", payload);
  const read = await machine.readBytes("/workspace/blob.bin");
  check("files: binary survives the base64 round trip", read.equals(payload));

  await machine.writeText("/workspace/note.txt", "hello");
  check("files: text write lands in the sandbox", client.written.get("/workspace/note.txt")?.toString("utf8") === "hello");

  const entries = await machine.listDir("/workspace");
  check("listDir: one round trip carries kinds", entries.length === 3);
  check("listDir: directory flag mapped", entries[0]?.kind === "dir" && entries[0]?.name === "src");
  check("listDir: plain file mapped", entries[1]?.kind === "file");

  const info = await machine.fileInfo("/workspace/note.txt");
  check("fileInfo: kind/size/mtime parsed from one stat", info.kind === "file" && info.size === 11 && info.mtimeMs === 1_700_000_000_000);

  check("ports: exposedPortUrl is honestly undefined on this transport", (await machine.exposedPortUrl()) === undefined);
}

async function testWorkspaceLifecycle(): Promise<void> {
  const client = new FakeClient(() => ok([{ stream: "stdout", data: "" }]));
  const workspace = await CloudflareWorkspace.open({ client, cwd: "/workspace", sessionId: "user-42" });

  check("workspace: id is the vendor session id", workspace.id === "user-42");
  check("workspace: pause is honestly unsupported (sandbox still running)", (await workspace.pause()) === false);

  const snapshotId = await workspace.snapshot();
  check("workspace: snapshot writes a squashfs archive of the root", snapshotId !== undefined && client.archives[0]?.dir === "/workspace");
  check("workspace: snapshot ids are distinct", (await workspace.snapshot()) !== snapshotId);

  await workspace.restore(snapshotId!);
  check("workspace: machine stays usable across restore (no instance swap)", (await workspace.machine.run(["true"])).exitCode === 0);

  const cloned = await workspace.checkout("https://example.com/app.git", { branch: "main" });
  check("workspace: native git checkout used, shallow by default", cloned && client.clones[0]?.depth === 1 && client.clones[0]?.branch === "main");
}

async function testWorkspaceSpec(): Promise<void> {
  const client = new FakeClient(() => ok([{ stream: "stdout", data: "" }]));
  const machine = new CloudflareMachine(client, { cwd: "/workspace" });

  await materializeWorkspace(machine, {
    root: "/workspace",
    entries: {
      repo: { type: "git_repo", repo: "https://example.com/app.git", ref: "main" },
      ".npmrc": { type: "file", content: "registry=https://example.com\n" },
    },
  });
  check("workspace-spec: git_repo cloned shallow at the requested ref",
    client.executed.some((c) => c.includes("git clone") && c.includes("--depth 1") && c.includes("--branch main")));
  check("workspace-spec: inline file written", client.written.get("/workspace/.npmrc")?.toString("utf8").startsWith("registry=") === true);
}

await testCheapPath();
await testStreamingAndCap();
await testTimeoutAndAbort();
await testFilesAndListing();
await testWorkspaceLifecycle();
await testWorkspaceSpec();

console.log(failures === 0 ? "\n✅ CLOUDFLARE MACHINE E2E PASS" : `\n❌ ${String(failures)} FAILED`);
if (failures > 0) process.exit(1);
