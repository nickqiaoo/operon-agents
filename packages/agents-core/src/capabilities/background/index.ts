import type { SessionStore } from "../../store/index.ts";
import type { Capability, SessionContext } from "../capability.ts";
import { BackgroundManager } from "./manager.ts";
import type { BackgroundTaskPersistence } from "./persist.ts";
import { StoreBackgroundTaskPersistence } from "./persist.ts";
import { DiskBackgroundTaskPersistence } from "./persist-disk.ts";
import { backgroundListTool, backgroundOutputTool, backgroundStopTool } from "./tools.ts";

export { BackgroundManager } from "./manager.ts";
export type {
  BackgroundManagerOptions,
  BackgroundManagerRuntime,
  BackgroundTaskOutputDelta,
  BackgroundTaskOutputSnapshot,
} from "./manager.ts";
export { CommandBackgroundTask } from "./command-task.ts";
export type { CommandBackgroundTaskInfo } from "./command-task.ts";
export { AgentBackgroundTask } from "./agent-task.ts";
export type { AgentBackgroundTaskInfo, AgentBackgroundTaskOptions } from "./agent-task.ts";
export { QuestionBackgroundTask } from "./question-task.ts";
export type { QuestionBackgroundTaskInfo, QuestionBackgroundTaskOptions } from "./question-task.ts";
export { WorkflowBackgroundTask } from "./workflow-task.ts";
export type { WorkflowBackgroundTaskInfo, WorkflowBackgroundTaskOptions } from "./workflow-task.ts";
export { StoreBackgroundTaskPersistence, isPersistedTaskTerminal, isValidPersistedTask } from "./persist.ts";
export type { BackgroundTaskPersistence, PersistedTask } from "./persist.ts";
export { DiskBackgroundTaskPersistence } from "./persist-disk.ts";
export { backgroundListTool, backgroundOutputTool, backgroundStopTool } from "./tools.ts";
export {
  TERMINAL_STATUSES,
  isBackgroundTaskTerminal,
} from "./task.ts";
export type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
  BackgroundTaskSettlement,
  BackgroundTaskSettlementStatus,
  BackgroundTaskStatus,
  TaskOutputRef,
  TaskOutputLocation,
} from "./task.ts";

export function backgroundCapability(manager: BackgroundManager = new BackgroundManager()): Capability {
  return {
    name: "background",
    // Enumeration stays a host API (`session.listBackgroundTasks()`). The model already owns
    // every task id it successfully spawned, while cold recovery injects ids whose ack was lost;
    // exposing an unbounded list invites unrelated historical tasks into the reasoning path.
    tools: [backgroundOutputTool(manager), backgroundStopTool(manager)],
    service: manager,

    openSession: async (ctx: SessionContext) => {
      // Each task's status is now durably recorded in a dedicated per-task store (disk
      // sessions get the `<sessionDir>/tasks/<id>/` layout; other backends use KV state),
      // so a task orphaned by a dead process can be reconciled to `lost` on reopen. Loading
      // + reconcile happen in the store-cutover step; here we attach the persistence so live
      // spawns start recording. Without a durable store the manager stays purely in memory.
      manager.attach({
        steer: ctx.steer,
        events: ctx.events,
        sessionId: ctx.sessionId,
        persistence: makeTaskPersistence(ctx.store),
        // Shard-backed output (a sub-agent's conversation) is read back from here rather than
        // copied into the task, so the manager needs the log itself, not just the task store.
        ...(ctx.store !== undefined ? { store: ctx.store } : {}),
      });
      // Load prior-process task records so reconcile (triggered on first run via
      // session.reconcileSubagents) can reclassify any that were left non-terminal.
      await manager.loadFromDisk();
    },

    // Only releases the event subscription taken in `openSession`. Running tasks are
    // deliberately NOT stopped here: closing a session releases resources, it does not cancel
    // work, and `attach` is last-writer-wins anyway.
    closeSession: () => {
      manager.detachRuntime();
    },
  };
}

/** Disk sessions co-locate the task store under their home dir; every other
 *  backend persists task status through KV state. No store → no persistence (in-memory only). */
function makeTaskPersistence(store: SessionStore | undefined): BackgroundTaskPersistence | undefined {
  if (store === undefined) return undefined;
  const dir = store.storageDir?.();
  return dir !== undefined ? new DiskBackgroundTaskPersistence(dir) : new StoreBackgroundTaskPersistence(store);
}
