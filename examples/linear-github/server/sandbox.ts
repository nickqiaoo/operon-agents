// Sessions in E2B sandboxes: one sandbox per session, opened when the session opens, paused
// when it closes, reconnected -- and resumed -- the next time a message arrives.
//
// The framework deliberately owns no sandbox lifecycle (see operon-sandbox's E2BWorkspace): a
// sandbox is the host's resource, and this file is the host's side of the deal for this
// example. What it keeps on disk is one file per session, `<work>/<session>/sandbox.json`, with
// the sandbox id; the clone, the marker and the agent's work live inside the sandbox.
//
// Why pause on close, not kill: a Linear session waits on people for hours or days. Pausing
// keeps the filesystem (the branch, uncommitted edits) for a fraction of the running cost, and
// `Sandbox.connect` resumes a paused sandbox transparently. A plan without pause support gets
// `false` back and the sandbox keeps running until its timeout; `lifecycle.onTimeout: "pause"`
// on creation is the backstop so a timeout also pauses rather than kills.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Environment } from "operon-agents";
import { E2BWorkspace, type E2BEnvironmentState, type E2BSandboxFactory } from "operon-sandbox";
import { ensureCheckout } from "./checkout.ts";
import type { GitHubApi, RepoRef } from "./github.ts";

export interface E2BCheckoutOptions {
  /** The `Sandbox` class from the `e2b` package, or anything with its `create` / `connect`. */
  readonly sandbox: E2BSandboxFactory;
  /** Template for a fresh sandbox; the default image has git. */
  readonly template?: string;
  /** Sandbox inactivity timeout while a session holds it open. */
  readonly timeoutMs?: number;
  /** Where sessions live inside the sandbox. Default `/home/user/work`. */
  readonly workRoot?: string;
}

const DEFAULT_WORK_ROOT = "/home/user/work";

/** Per-session E2B sandboxes with the checkout inside. */
export class E2BCheckouts {
  private readonly open = new Map<string, E2BWorkspace>();

  constructor(
    private readonly options: E2BCheckoutOptions,
    private readonly github: GitHubApi,
    /** Host directory for the per-session state files. */
    private readonly work: string,
  ) {}

  private stateFile(sessionId: string): string {
    return join(this.work, sessionId, "sandbox.json");
  }

  private readState(sessionId: string): E2BEnvironmentState | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile(sessionId), "utf8")) as Partial<E2BEnvironmentState>;
      return typeof raw.sandboxId === "string" ? { sandboxId: raw.sandboxId } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The session's environment, rooted in its clone of `repo` inside its sandbox. */
  async openSession(sessionId: string, repo: RepoRef): Promise<Environment> {
    const previous = this.readState(sessionId);
    const workspace = await E2BWorkspace.open(
      {
        sandbox: this.options.sandbox,
        ...(this.options.template !== undefined ? { template: this.options.template } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      },
      previous,
    );
    if (previous?.sandboxId !== workspace.id) {
      mkdirSync(join(this.work, sessionId), { recursive: true });
      writeFileSync(this.stateFile(sessionId), JSON.stringify(workspace.state(), null, 2));
      if (previous !== undefined) console.warn(`[sandbox] ${sessionId}: sandbox ${previous.sandboxId} is gone; started ${workspace.id} (work since the last push is lost)`);
    }
    this.open.set(sessionId, workspace);
    const root = posix.join(this.options.workRoot ?? DEFAULT_WORK_ROOT, sessionId);
    return ensureCheckout(workspace.environment, root, sessionId, repo, this.github);
  }

  /** The session closed: pause its sandbox. False when the plan cannot pause (still running). */
  async releaseSession(sessionId: string): Promise<boolean> {
    const workspace = this.open.get(sessionId);
    if (workspace === undefined) return false;
    this.open.delete(sessionId);
    return workspace.pause();
  }

  /** Sandbox ids of the sessions currently open, for the operator. */
  get running(): ReadonlyMap<string, string> {
    return new Map([...this.open].map(([sessionId, workspace]) => [sessionId, workspace.id]));
  }
}

/** Wrap the real `Sandbox` class so fresh sandboxes pause -- not die -- at their timeout. */
export function pausingSandboxFactory(sandbox: E2BSandboxFactory): E2BSandboxFactory {
  return {
    create: (opts) => sandbox.create({ ...opts, lifecycle: { onTimeout: "pause" } }),
    ...(sandbox.connect !== undefined ? { connect: sandbox.connect.bind(sandbox) } : {}),
  };
}
