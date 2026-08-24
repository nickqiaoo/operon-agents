/**
 * Workflow run discovery types. A BACKGROUND workflow run is a task, so `/workflows` lists
 * runs from the durable task store (see `session.listWorkflows`, which projects task records
 * into `WorkflowSnapshot`). A foreground workflow is a plain `Workflow` tool call — its record
 * is the conversation plus its journal shard. `WorkflowRunDetails` is the structured `details`
 * a Workflow tool result carries as the human/model-facing record.
 */

export type WorkflowSnapshotStatus = "running" | "completed" | "failed" | "aborted";

/** A discovery row for one run — enough to list past runs and pick a runId to resume. */
export interface WorkflowSnapshot {
  readonly runId: string;
  readonly workflowName: string;
  readonly description?: string;
  readonly status: WorkflowSnapshotStatus;
  readonly background: boolean;
  /** The background task handle from the spawn ack (background runs only). */
  readonly taskId?: string;
  /** ISO timestamps (stamped by the host, not inside the deterministic sandbox). */
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outputTokens?: number;
}

/** The structured `details` every Workflow tool result carries — what the fold reads. */
export interface WorkflowRunDetails {
  readonly workflow: string;
  readonly runId: string;
  readonly status: WorkflowSnapshotStatus;
  readonly background?: boolean;
  readonly description?: string;
  readonly taskId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly usage?: unknown;
  readonly outputTokens?: number;
}
