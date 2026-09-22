/**
 * Background task → the two discovery views over it.
 *
 * A background subagent and a background workflow are both rows in the same task ledger; what
 * tells them apart is `kind` plus the fields that kind fills in. These projections live next to
 * the ledger rather than in the session facade, so a caller reading the ledger by any route sees
 * the same rows.
 */
import type { BackgroundTaskInfo, BackgroundTaskStatus } from "./task.ts";
import type { SubagentRecord, SubagentStatus } from "../../agent/subagent.ts";
import type { WorkflowSnapshot, WorkflowSnapshotStatus } from "../../agent/workflow/snapshot.ts";

const SUBAGENT_STATUS_SET: ReadonlySet<string> = new Set<SubagentStatus>([
  "running",
  "completed",
  "error",
  "cancelled",
  "paused",
  "lost",
]);

const WORKFLOW_STATUS_SET: ReadonlySet<string> = new Set<WorkflowSnapshotStatus>([
  "running",
  "completed",
  "failed",
  "aborted",
]);

/** Map a background task status to the finer subagent status, preferring the run's own
 *  `agentStatus` (e.g. "paused") when it reported one. */
function subagentStatusFromTask(status: BackgroundTaskStatus, agentStatus?: string): SubagentStatus {
  if (agentStatus !== undefined && SUBAGENT_STATUS_SET.has(agentStatus)) return agentStatus as SubagentStatus;
  switch (status) {
    case "completed":
      return "completed";
    case "killed":
      return "cancelled";
    case "paused":
      return "paused";
    case "lost":
      return "lost";
    case "running":
      return "running";
    default:
      return "error"; // failed / timed_out
  }
}

/** Map a background task status to the workflow discovery status, preferring the run's own
 *  `runStatus` (e.g. "failed") when it reported one. */
function workflowStatusFromTask(status: BackgroundTaskStatus, runStatus?: string): WorkflowSnapshotStatus {
  if (runStatus !== undefined && WORKFLOW_STATUS_SET.has(runStatus)) return runStatus as WorkflowSnapshotStatus;
  switch (status) {
    case "completed":
      return "completed";
    case "killed":
    case "lost":
      return "aborted";
    case "running":
      return "running";
    default:
      return "failed"; // failed / timed_out
  }
}

/** The subagent view of a task, or undefined when the task is not a backgrounded subagent. */
export function taskToSubagentRecord(info: BackgroundTaskInfo): SubagentRecord | undefined {
  if (info.kind !== "agent" || info.agentId === undefined) return undefined;
  if (info.outputRef?.kind !== "conversation") return undefined;
  const address = info.outputRef.address;
  return {
    agentId: info.agentId,
    type: info.subagentType ?? "unknown",
    address,
    description: info.description,
    background: true,
    taskId: info.taskId,
    createdAt: info.startedAt,
    status: subagentStatusFromTask(info.status, info.agentStatus),
    updatedAt: info.endedAt ?? info.startedAt,
  };
}

/** The workflow view of a task, or undefined when the task is not a backgrounded workflow run. */
export function taskToWorkflowSnapshot(info: BackgroundTaskInfo): WorkflowSnapshot | undefined {
  if (info.kind !== "workflow" || info.runId === undefined) return undefined;
  return {
    runId: info.runId,
    workflowName: info.workflowName ?? "unknown",
    description: info.description,
    status: workflowStatusFromTask(info.status, info.runStatus),
    background: true,
    taskId: info.taskId,
    startedAt: new Date(info.startedAt).toISOString(),
    endedAt: info.endedAt !== null ? new Date(info.endedAt).toISOString() : undefined,
  };
}
