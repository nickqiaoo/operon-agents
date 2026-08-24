import type { Machine } from "operon-agents-core";

/**
 * A sandbox the HOST owns: created here, disposed of here, and handed to the agent
 * framework only as a {@link Machine}.
 *
 * This layer exists because sandbox lifetime and agent-session lifetime are different
 * things. A sandbox is normally scoped to a user or a workspace and outlives any single
 * session — new, resumed and forked sessions all run inside the same one. Wire it in with
 * `machine: workspace.machine`; the framework then only ever operates the
 * machine, and closing a session cannot take the workspace down with it.
 *
 * Every method states an INTENT and answers honestly about whether the backend could
 * deliver it — `undefined`/`false` rather than a throw or a pretend success. That is why
 * there is no capability-flags object here: a flag is a claim made in advance (and vendors
 * do get it wrong — E2B's own `supportsPty()` is a runtime probe), whereas a return value
 * is what actually happened. Callers write one path and read the result.
 */
export interface SandboxWorkspace {
  /** The agent-facing handle. Stays valid across {@link restore}, which may swap the sandbox. */
  readonly machine: Machine;
  /** Vendor id of the live sandbox. Changes when `restore` replaces it. */
  readonly id: string;

  /**
   * Capture the workspace for later reuse. `undefined` when this backend/plan has no
   * snapshot mechanism — the caller then knows to fall back rather than assume it worked.
   */
  snapshot(): Promise<string | undefined>;

  /** Replace the workspace's contents with a snapshot. `machine` keeps working across it. */
  restore(snapshotId: string): Promise<void>;

  /**
   * Suspend the sandbox, keeping its filesystem, so reopening is cheaper than a cold start.
   * `false` means the backend cannot suspend and the sandbox is STILL RUNNING — the caller
   * has to decide between paying for it and killing it.
   */
  pause(): Promise<boolean>;

  /** Destroy the sandbox. Terminal: the machine is unusable afterwards. */
  kill(): Promise<void>;
}
