import type { BackgroundTask, BackgroundTaskInfo } from "./task.ts";

/**
 * The subset of a BackgroundManager a tool needs to register + peek at a detached task.
 * A `BackgroundSpawner` may or may not be one; `asTaskRegistrar` narrows it structurally
 * so the Agent and Workflow tools can offer `run_in_background` only when it's available.
 */
export interface BackgroundTaskRegistrar {
  registerTask(task: BackgroundTask): string;
  getTask(taskId: string): BackgroundTaskInfo | undefined;
}

export function asTaskRegistrar(value: unknown): BackgroundTaskRegistrar | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { registerTask?: unknown; getTask?: unknown };
  return typeof candidate.registerTask === "function" && typeof candidate.getTask === "function"
    ? (value as BackgroundTaskRegistrar)
    : undefined;
}
