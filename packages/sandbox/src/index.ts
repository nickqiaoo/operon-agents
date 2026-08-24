/**
 * Host-side sandbox lifecycle for operon-agents.
 *
 * Two halves, deliberately split:
 *
 * - **Lifecycle** (`SandboxWorkspace`) — create, snapshot, pause, destroy. Lives HERE, on the
 *   host's side of the line, because a sandbox is a user- or workspace-scoped resource that
 *   outlives any single agent session.
 * - **Operation** (`Machine`) — commands and file I/O, driven by each vendor's SDK directly,
 *   so a per-command timeout, incremental output and a real kill actually take effect.
 *
 * Wire the two together by handing the machine in:
 *
 *   const workspace = await E2BWorkspace.open({ sandbox: Sandbox, template: "node20" });
 *   await materializeWorkspace(workspace.machine, spec);
 *   const harness = new Harness({ machine: workspace.machine });
 *   // ...and the host calls workspace.pause()/kill() when the USER is done, not when a
 *   // session is.
 *
 * Vendor SDKs are optional peers: install `e2b` or `@cloudflare/sandbox` for the ones you use.
 */
export type { SandboxWorkspace } from "./types.ts";

export { E2BMachine, shellJoin, type E2BMachineOptions } from "./e2b/machine.ts";
export {
  E2BWorkspace,
  type E2BWorkspaceOptions,
  type E2BMachineState,
  type E2BSandboxFactory,
} from "./e2b/lifecycle.ts";
export type {
  E2BCommandHandle,
  E2BCommandResult,
  E2BCommandsApi,
  E2BEntryInfo,
  E2BFilesystemApi,
  E2BFileType,
  E2BRunOpts,
  E2BSandbox,
  SandboxRef,
} from "./e2b/e2b-api.ts";

export { CloudflareMachine, type CloudflareMachineOptions } from "./cloudflare/machine.ts";
export { CloudflareWorkspace, type CloudflareWorkspaceOptions } from "./cloudflare/lifecycle.ts";
export type {
  CloudflareBackupApi,
  CloudflareClientRef,
  CloudflareCommandsApi,
  CloudflareFileEntry,
  CloudflareFilesApi,
  CloudflareGitApi,
  CloudflareLogEvent,
  CloudflareProcessesApi,
  CloudflareSandboxClient,
} from "./cloudflare/cf-api.ts";
