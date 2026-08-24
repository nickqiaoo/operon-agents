import type { SessionStore } from "../../store/index.ts";
import type { Capability, SessionContext } from "../capability.ts";
import { TaskListInjector } from "./injector.ts";
import { StoreTaskListPersistence, type TaskListPersistence } from "./persist.ts";
import { DiskTaskListPersistence } from "./persist-disk.ts";
import { TaskStore } from "./task-store.ts";
import { taskCreateTool, taskGetTool, taskListTool, taskUpdateTool } from "./tools.ts";

export { TaskStore } from "./task-store.ts";
export type { Task, TaskStatus, TaskCreateInput, TaskScalarUpdate } from "./task-store.ts";
export { TASK_STATUSES } from "./task-store.ts";
export { TaskListInjector } from "./injector.ts";
export { StoreTaskListPersistence, isValidTask } from "./persist.ts";
export type { TaskListPersistence } from "./persist.ts";
export { DiskTaskListPersistence } from "./persist-disk.ts";
export {
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  taskGetTool,
  renderTaskList,
  TASK_CREATE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_GET_TOOL_NAME,
} from "./tools.ts";

/**
 * Structured task list capability (TaskCreate/Update/List/Get) —
 * a richer replacement for the flat TodoList: per-task records with status, dependencies, owner,
 * and metadata, kept in a dedicated per-task store (disk sessions write one JSON file per task;
 * other backends use KV state) rather than folded from the conversation.
 */
export function taskCapability(store: TaskStore = new TaskStore()): Capability {
  return {
    name: "task",
    tools: [taskCreateTool(store), taskUpdateTool(store), taskListTool(store), taskGetTool(store)],
    service: store,
    injectors: [new TaskListInjector(store)],
    openSession: async (ctx: SessionContext) => {
      store.attach(makeTaskListPersistence(ctx.store));
      await store.load();
    },
  };
}

/** Disk sessions keep the task list under `<sessionDir>/tasklist/` (one JSON per task);
 *  every other backend persists task records through KV state. No store → in-memory only. */
export function makeTaskListPersistence(store: SessionStore | undefined): TaskListPersistence | undefined {
  if (store === undefined) return undefined;
  const dir = store.storageDir?.();
  return dir !== undefined ? new DiskTaskListPersistence(dir) : new StoreTaskListPersistence(store);
}
