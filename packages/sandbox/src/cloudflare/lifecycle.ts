import type { SandboxWorkspace } from "../types.ts";
import type { CloudflareSandboxClient } from "./cf-api.ts";
import { CloudflareMachine, type CloudflareMachineOptions } from "./machine.ts";

/** Where squashfs archives live inside the sandbox when no explicit path is given. */
const SNAPSHOT_DIR = "/tmp/operon-snapshots";

export interface CloudflareWorkspaceOptions extends CloudflareMachineOptions {
  /**
   * A `SandboxClient` from `@cloudflare/sandbox`, constructed against YOUR Worker:
   * `new SandboxClient({ baseUrl })`. The Worker must expose the SDK's routes (wrap your
   * handlers with `bridge()` from `@cloudflare/sandbox/bridge`).
   */
  readonly client: CloudflareSandboxClient;
  /** Workspace root that snapshots capture and restore. Defaults to the machine's cwd. */
  readonly root?: string;
  /** Prepare a fresh workspace (clone a repo, drop config files). Runs only on creation. */
  readonly prepare?: (machine: CloudflareMachine) => Promise<void>;
}

/**
 * Host-side lifecycle for a Cloudflare sandbox.
 *
 * Two things differ from a VM-style vendor and are worth knowing before you pick this one:
 *
 * 1. **Snapshots are archives, not sandbox images.** Cloudflare has no "clone the whole
 *    sandbox" primitive, so `snapshot()` writes a squashfs archive of the workspace root and
 *    `restore()` unpacks it back over that root. The sandbox instance never changes — which
 *    makes `restore` cheaper than E2B's (no replacement instance, no dead handles), but the
 *    snapshot only covers the workspace tree, not installed packages outside it.
 * 2. **There is no pause.** `pause()` returns `false`; the sandbox keeps running until the
 *    container's own idle policy retires it or you `kill()` it.
 */
export class CloudflareWorkspace implements SandboxWorkspace {
  readonly machine: CloudflareMachine;
  private readonly options: CloudflareWorkspaceOptions;
  private readonly root: string;
  private snapshotSeq = 0;

  private constructor(options: CloudflareWorkspaceOptions) {
    this.options = options;
    this.machine = new CloudflareMachine(options.client, options);
    this.root = options.root ?? this.machine.getcwd();
  }

  static async open(options: CloudflareWorkspaceOptions): Promise<CloudflareWorkspace> {
    const workspace = new CloudflareWorkspace(options);
    await workspace.machine.mkdir(workspace.root, { parents: true });
    if (options.prepare !== undefined) await options.prepare(workspace.machine);
    return workspace;
  }

  /** The session id every vendor call is scoped to — Cloudflare's unit of sandbox identity. */
  get id(): string {
    return this.options.sessionId ?? "default";
  }

  /**
   * Clone a repo through the vendor's native git support when available, which is both faster
   * and more precise than spawning `git` (it takes `depth` and `branch` directly).
   * Returns false when this deployment exposes no git client, so the caller can fall back to
   * `materializeWorkspace`'s `git_repo` entry rather than assume it worked.
   */
  async checkout(repoUrl: string, options: { branch?: string; targetDir?: string; depth?: number } = {}): Promise<boolean> {
    if (this.options.client.git === undefined) return false;
    await this.options.client.git.checkout(repoUrl, this.id, {
      depth: 1,
      ...options,
    });
    return true;
  }

  /**
   * Archive the workspace root. `undefined` when the deployment exposes no backup client —
   * the caller then knows to fall back instead of believing a snapshot exists.
   */
  async snapshot(): Promise<string | undefined> {
    const backup = this.options.client.backup;
    if (backup === undefined) return undefined;
    // Sequence rather than a timestamp: deterministic, and two snapshots in the same
    // millisecond cannot collide onto one archive.
    this.snapshotSeq += 1;
    const archivePath = `${SNAPSHOT_DIR}/snap-${String(this.snapshotSeq)}.sqfs`;
    await this.machine.mkdir(SNAPSHOT_DIR, { parents: true });
    await backup.createArchive(this.root, archivePath, this.id, { gitignore: false });
    return archivePath;
  }

  /** Unpack an archive back over the workspace root. The machine stays valid throughout. */
  async restore(snapshotId: string): Promise<void> {
    const backup = this.options.client.backup;
    if (backup === undefined) throw new Error("This Cloudflare deployment exposes no backup client to restore from.");
    await backup.restoreArchive(this.root, snapshotId, this.id);
  }

  /** Cloudflare containers have no suspend primitive — the sandbox is still running. */
  async pause(): Promise<boolean> {
    return false;
  }

  /**
   * Kill everything running in the sandbox. The container itself is owned by the Durable
   * Object and retires on its own idle policy, so this stops the work, not the deployment.
   */
  async kill(): Promise<void> {
    await this.options.client.processes.killAllProcesses?.().catch(() => undefined);
  }
}
