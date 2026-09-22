/**
 * Workflow capability — exposes the WorkflowManager as a session service
 * (`session.workflow`, i.e. `Tokens.Workflow`), mirroring how `background` exposes the
 * BackgroundManager.
 *
 * It contributes NO tools: the `Workflow` tool is built by the Runner (it needs
 * runLoop to spawn subagents), and reaches this service through the session to read
 * its configured directories and persist run snapshots. The capability's job is
 * purely to make the management/read environment available to upper layers and the
 * `/workflows` command. A session opened WITHOUT this capability still has a
 * `Tokens.Workflow`: `Session.open` provides an in-memory fallback.
 */
import { provision, type Capability } from "../capability.ts";
import { optional } from "../needs.ts";
import { Tokens } from "../../scope/tokens.ts";
import { WorkflowManager } from "../../agent/workflow/manager.ts";

export { WorkflowManager } from "../../agent/workflow/manager.ts";
export type { WorkflowSnapshot, WorkflowSnapshotStatus } from "../../agent/workflow/snapshot.ts";

export function workflowCapability(manager: WorkflowManager = new WorkflowManager()): Capability {
  return {
    name: "workflow",
    provides: [
      provision({
        token: Tokens.Workflow,
        needs: { store: optional(Tokens.Store) },
        create: ({ store }) => {
          // Bookkeeping goes through the SessionStore, never the Environment: without a
          // durable store the manager stays on its in-memory store for the session's lifetime.
          if (store !== undefined) manager.attachStore(store);
          return manager;
        },
      }),
    ],
  };
}
