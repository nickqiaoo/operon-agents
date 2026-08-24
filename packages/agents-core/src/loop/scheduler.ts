import { ToolAccesses } from "../tool/access.ts";
import type { ToolAccesses as Accesses } from "../tool/access.ts";

interface ControlledPromise<T> extends Promise<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as ControlledPromise<T>;
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
}

export interface ToolCallTask<Result> {
  readonly accesses: Accesses;
  readonly start: () => Promise<{ readonly result: Promise<Result> }>;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly result: ControlledPromise<Result>;
}

export class ToolScheduler<Result> {
  private readonly activeTasks: Array<ScheduledToolCallTask<Result>> = [];
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];

  add(task: ToolCallTask<Result>): Promise<Result> {
    const result = createControlledPromise<Result>();
    void result.catch(() => undefined);

    const scheduledTask: ScheduledToolCallTask<Result> = { ...task, result };
    if (this.isBlocked(task, this.queuedTasks)) {
      this.queuedTasks.push(scheduledTask);
    } else {
      this.start(scheduledTask);
    }

    return result;
  }

  private isBlocked(task: ToolCallTask<Result>, queuedBefore: readonly ToolCallTask<Result>[]): boolean {
    return this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore);
  }

  private conflictsWithAny(task: ToolCallTask<Result>, candidates: readonly ToolCallTask<Result>[]): boolean {
    return candidates.some((candidate) => ToolAccesses.conflict(task.accesses, candidate.accesses));
  }

  private start(task: ScheduledToolCallTask<Result>): void {
    this.activeTasks.push(task);
    let started: Promise<{ readonly result: Promise<Result> }>;
    try {
      started = task.start();
    } catch (error) {
      task.result.reject(error);
      this.finish(task);
      return;
    }

    void started
      .then(({ result }) => result)
      .then(task.result.resolve, task.result.reject)
      .finally(() => {
        this.finish(task);
      });
  }

  private finish(task: ScheduledToolCallTask<Result>): void {
    const index = this.activeTasks.indexOf(task);
    if (index >= 0) this.activeTasks.splice(index, 1);
    this.startQueuedTasks();
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (this.isBlocked(task, stillQueued)) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}
