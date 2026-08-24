import type { SandboxWorkspace } from "../types.ts";
import type { E2BSandbox } from "./e2b-api.ts";
import { E2BMachine, type E2BMachineOptions } from "./machine.ts";

/**
 * The bits of the `Sandbox` class we call. Structural, so `e2b` stays an optional peer and
 * tests can inject a fake factory.
 */
export interface E2BSandboxFactory {
  create(opts?: Record<string, unknown>): Promise<E2BSandbox>;
  connect?(sandboxId: string, opts?: Record<string, unknown>): Promise<E2BSandbox>;
}

/** Persisted between sessions so a reopen reconnects instead of starting a fresh sandbox. */
export interface E2BMachineState {
  readonly sandboxId: string;
  /** Snapshot the sandbox was last restored from, if any. */
  readonly snapshotId?: string;
}

export interface E2BWorkspaceOptions extends E2BMachineOptions {
  /** Usually the `Sandbox` class from the `e2b` package. */
  readonly sandbox: E2BSandboxFactory;
  /** Template/base image id for a fresh sandbox. */
  readonly template?: string;
  readonly envs?: Record<string, string>;
  /** Sandbox-level inactivity timeout (distinct from a command's timeout). */
  readonly timeoutMs?: number;
  /** Prepare a fresh workspace (clone a repo, drop config files). Runs only on creation. */
  readonly prepare?: (machine: E2BMachine) => Promise<void>;
}

/**
 * Lifecycle for a directly-driven E2B sandbox: create or reconnect on open, snapshot on
 * demand, restore by replacing the instance.
 *
 * Restore is the subtle part. E2B restores a snapshot by starting a NEW sandbox from it, so
 * the old instance is dead afterwards. Everything therefore reads the sandbox through a
 * mutable cell rather than capturing it — `E2BMachine` holds `() => current`, so a restore
 * is transparent to every tool already holding the machine.
 */
export class E2BWorkspace implements SandboxWorkspace {
  private current: E2BSandbox;
  private readonly factory: E2BSandboxFactory;
  private readonly options: E2BWorkspaceOptions;
  readonly machine: E2BMachine;

  private constructor(sandbox: E2BSandbox, options: E2BWorkspaceOptions) {
    this.current = sandbox;
    this.factory = options.sandbox;
    this.options = options;
    this.machine = new E2BMachine(() => this.current, options);
  }

  static async open(options: E2BWorkspaceOptions, state?: E2BMachineState): Promise<E2BWorkspace> {
    const sandbox = await openSandbox(options, state);
    const workspace = new E2BWorkspace(sandbox, options);
    if (state === undefined && options.prepare !== undefined) await options.prepare(workspace.machine);
    return workspace;
  }

  get id(): string {
    return this.current.sandboxId;
  }

  state(): E2BMachineState {
    return { sandboxId: this.current.sandboxId };
  }

  /** Capture the workspace. Returns undefined when the plan/template has no snapshot support. */
  async snapshot(): Promise<string | undefined> {
    if (this.current.createSnapshot === undefined) return undefined;
    const { snapshotId } = await this.current.createSnapshot();
    return snapshotId;
  }

  /**
   * Restore a snapshot by starting a replacement sandbox from it and retiring the old one.
   * The machine keeps working because it reads `current` through a closure.
   */
  async restore(snapshotId: string): Promise<void> {
    const replacement = await this.factory.create({
      template: snapshotId,
      ...(this.options.envs !== undefined ? { envs: this.options.envs } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    const previous = this.current;
    this.current = replacement;
    // Retire the old sandbox after the swap: a failure to clean up must not cost us the
    // restored workspace we already hold.
    await previous.kill().catch(() => undefined);
  }

  /** Fork the workspace: snapshot, then start an independent sandbox from that snapshot. */
  async fork(): Promise<{ machine: E2BMachine; dispose: () => Promise<void> } | undefined> {
    const snapshotId = await this.snapshot();
    if (snapshotId === undefined) return undefined;
    const clone = await this.factory.create({
      template: snapshotId,
      ...(this.options.envs !== undefined ? { envs: this.options.envs } : {}),
    });
    return {
      machine: new E2BMachine(() => clone, this.options),
      dispose: async () => void (await clone.kill().catch(() => undefined)),
    };
  }

  /** E2B supports pause on some plans only; `false` means the sandbox is still running. */
  async pause(): Promise<boolean> {
    if (this.current.pause === undefined) return false;
    return await this.current.pause().catch(() => false);
  }

  async kill(): Promise<void> {
    await this.current.kill().catch(() => undefined);
  }
}

async function openSandbox(options: E2BWorkspaceOptions, state?: E2BMachineState): Promise<E2BSandbox> {
  if (state !== undefined && options.sandbox.connect !== undefined) {
    try {
      return await options.sandbox.connect(state.sandboxId, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    } catch {
      // Sandbox is gone (expired/deleted) — fall through and start a fresh one rather than
      // failing the session open.
    }
  }
  return await options.sandbox.create({
    ...(options.template !== undefined ? { template: options.template } : {}),
    ...(options.envs !== undefined ? { envs: options.envs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/**
 * No `e2bMachineFactory` here on purpose.
 *
 * A factory that created a sandbox per session, stored its id in the session's state and
 * killed it on session close got three things wrong at once: every new session started a
 * fresh sandbox (so one user ended up with N), closing any session pulled the sandbox out
 * from under the others, and forking a session copied the sandbox id — silently giving two
 * "independent" sessions one shared filesystem.
 *
 * A sandbox is a user- or workspace-scoped resource. So the host owns it:
 *
 *   const workspace = await E2BWorkspace.open({ sandbox: Sandbox, template: "node20" });
 *   await materializeWorkspace(workspace.machine, spec);          // prepare it once
 *   const harness = new Harness({ machine: workspace.machine });
 *   // ...every session — new, resumed, forked — runs in that one sandbox, and the host
 *   // calls workspace.close() when the USER is done, not when a session is.
 *
 * Persisting `workspace.state().sandboxId` for a later reconnect is the host's call too;
 * pass it back to `E2BWorkspace.open` as the second argument.
 */
