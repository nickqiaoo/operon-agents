// A stand-in for the `e2b` SDK's `Sandbox` that runs commands on this host, so the E2B path --
// E2BWorkspace → E2BMachine → the checkout, the marker, the push, pause on close, reconnect on
// the next open -- is exercised end to end without an account. It mimics only what the adapter
// calls (see operon-sandbox's e2b-api.ts): background commands with a pid, streamed output, a
// real kill, and the files API. `stat` is emulated because the adapter speaks GNU stat and
// this host may not.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { E2BCommandHandle, E2BEntryInfo, E2BRunOpts, E2BSandbox, E2BSandboxFactory } from "operon-sandbox";

const STAT = /^stat\s+(-L\s+)?-c\s+(?:'[^']*'|\S+)\s+--\s+(.+)$/s;

function unquote(arg: string): string {
  const trimmed = arg.trim();
  return trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1).replace(/'\\''/g, "'") : trimmed;
}

export class FakeSandbox implements E2BSandbox {
  paused = false;
  killed = false;
  /** How many times `connect` returned this sandbox. */
  connects = 0;
  readonly commandLog: string[] = [];

  constructor(readonly sandboxId: string) {}

  readonly commands = {
    run: async (command: string, opts?: E2BRunOpts): Promise<E2BCommandHandle> => {
      this.commandLog.push(command);
      const stat = STAT.exec(command);
      if (stat) return this.stat(stat[1] !== undefined, unquote(stat[2]!), opts);
      // The adapter's default cwd is the sandbox's home, which does not exist on this host.
      const cwd = opts?.cwd !== undefined && (await this.files.exists(opts.cwd)) ? opts.cwd : "/";
      const child = spawn("/bin/bash", ["-c", command], {
        cwd,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...process.env, ...opts?.envs },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      // A spawn failure must settle the command, not crash the process.
      child.on("error", (err) => {
        stderr += `${err.message}\n`;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        void opts?.onStdout?.(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        void opts?.onStderr?.(chunk.toString("utf8"));
      });
      const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      return {
        pid: child.pid ?? -1,
        wait: async () => ({ stdout, stderr, exitCode: await exited }),
        kill: async () => child.kill("SIGKILL"),
      };
    },
    kill: async (pid: number): Promise<boolean> => {
      try {
        process.kill(pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    },
  };

  private async stat(follow: boolean, path: string, opts?: E2BRunOpts): Promise<E2BCommandHandle> {
    let stdout = "";
    let exitCode = 0;
    try {
      const info = follow ? await fs.stat(path) : await fs.lstat(path);
      const kind = info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symbolic link" : "regular file";
      const seconds = info.mtimeMs / 1000;
      stdout = `${kind}|${info.size}|${Math.floor(seconds)}|${seconds.toFixed(3)}\n`;
    } catch {
      exitCode = 1;
    }
    if (stdout) void opts?.onStdout?.(stdout);
    return { pid: 0, wait: async () => ({ stdout, stderr: "", exitCode }), kill: async () => false };
  }

  readonly files = {
    list: async (path: string): Promise<readonly E2BEntryInfo[]> => {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, path: join(path, entry.name), type: entry.isDirectory() ? "dir" : "file" }));
    },
    read: async (path: string, opts?: { format?: "text" | "bytes" }): Promise<string | Uint8Array> => {
      const data = await fs.readFile(path);
      return opts?.format === "text" ? data.toString("utf8") : new Uint8Array(data);
    },
    write: async (path: string, data: string | ArrayBuffer): Promise<unknown> => {
      await fs.mkdir(join(path, ".."), { recursive: true });
      await fs.writeFile(path, typeof data === "string" ? data : Buffer.from(data));
      return undefined;
    },
    makeDir: async (path: string): Promise<boolean> => {
      try {
        await fs.access(path);
        return false;
      } catch {
        await fs.mkdir(path, { recursive: true });
        return true;
      }
    },
    exists: async (path: string): Promise<boolean> => {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
    remove: async (path: string): Promise<void> => {
      await fs.rm(path, { recursive: true, force: true });
    },
  };

  async pause(): Promise<boolean> {
    this.paused = true;
    return true;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

/** A `Sandbox`-shaped factory whose sandboxes are remembered by id, so `connect` finds them. */
export function fakeE2B(): { factory: E2BSandboxFactory; sandboxes: Map<string, FakeSandbox> } {
  const sandboxes = new Map<string, FakeSandbox>();
  let created = 0;
  const factory: E2BSandboxFactory = {
    create: async () => {
      const sandbox = new FakeSandbox(`sbx_fake_${++created}`);
      sandboxes.set(sandbox.sandboxId, sandbox);
      return sandbox;
    },
    connect: async (sandboxId) => {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox === undefined || sandbox.killed) throw new Error(`sandbox ${sandboxId} not found`);
      sandbox.connects += 1;
      sandbox.paused = false;
      return sandbox;
    },
  };
  return { factory, sandboxes };
}
