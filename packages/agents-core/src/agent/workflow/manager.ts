/**
 * WorkflowManager — the external, runner-decoupled handle for the Workflow feature
 * (the service exposed as `session.workflow`, the way `session.background` exposes
 * the BackgroundManager). It binds the resume journals to a SessionStore; EXECUTION
 * stays in the Runner (it needs runLoop), which reaches this manager through the
 * session to get a run's journal.
 *
 * Run DISCOVERY is no longer here: a background workflow run is a task, so past runs
 * are listed from the durable task store via `session.listWorkflows()`. A foreground
 * workflow is a plain `Workflow` tool call — its record is the conversation plus its
 * journal shard. This manager only owns the resume journal (`newJournal(runId)`).
 *
 * Without a durable store the manager runs on an in-memory store: resume works within
 * the process lifetime and nothing is written anywhere — matching how the other
 * bookkeeping capabilities degrade.
 */
import { MemoryStore, type SessionStore } from "../../store/index.ts";
import { WorkflowJournal } from "./journal.ts";

export class WorkflowManager {
  private store: SessionStore;

  constructor(store?: SessionStore) {
    this.store = store ?? new MemoryStore();
  }

  /** Rebind resume journals to a session's store (called by the capability at openSession). */
  attachStore(store: SessionStore): void {
    this.store = store;
  }

  /** A resume journal for a run, bound to the configured store. */
  newJournal(runId: string, parentToolCallId?: string): WorkflowJournal {
    return new WorkflowJournal(runId, this.store, parentToolCallId);
  }
}
