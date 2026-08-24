import { errorMessage, isAbortError } from "../../loop/errors.ts";
import type { BackgroundTask, BackgroundTaskInfoBase, BackgroundTaskSink, TaskOutputLocation } from "./task.ts";

export interface WorkflowBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: "workflow";
  readonly workflowName?: string;
  readonly runId?: string;
  /** The workflow run's own terminal status (finer than the task status), once settled. */
  readonly runStatus?: string;
}

export interface WorkflowBackgroundTaskOptions {
  readonly timeoutMs?: number;
  readonly abort?: () => void;
  readonly workflowName?: string;
  readonly runId?: string;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  /** The run's journal address (`workflow:<runId>`) — every background workflow must have one. */
  readonly address: string;
}

/**
 * A background task that runs a Workflow to completion.
 *
 * Holds no output. Every step the run takes — inputs, each agent starting and returning, the
 * script's `log()` lines, failures, the outcome — is appended to its journal as it happens, so
 * the task names that address and nothing else. The progress this used to mirror into the sink
 * was a strictly worse copy: bounded by a buffer, gone with the process, and — because it was
 * only wired up on the detach path — a different thing depending on whether the run had been
 * backgrounded from the start.
 */
export class WorkflowBackgroundTask implements BackgroundTask {
  readonly kind = "workflow" as const;
  readonly idPrefix: string = "workflow";
  readonly description: string;
  readonly timeoutMs?: number;
  readonly workflowName?: string;
  readonly runId?: string;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  readonly outputLocation?: TaskOutputLocation;
  private runStatus?: string;
  private readonly run: (sink: BackgroundTaskSink) => Promise<{ runStatus: "completed" | "failed" }>;
  private readonly abort?: () => void;

  constructor(
    run: (sink: BackgroundTaskSink) => Promise<{ runStatus: "completed" | "failed" }>,
    description: string,
    options: WorkflowBackgroundTaskOptions,
  ) {
    if (typeof options.address !== "string" || options.address.length === 0) {
      throw new Error("A background Workflow requires its durable journal address.");
    }
    this.run = run;
    this.description = description;
    this.timeoutMs = options.timeoutMs;
    this.abort = options.abort;
    this.workflowName = options.workflowName;
    this.runId = options.runId;
    this.parentAddress = options.parentAddress;
    this.toolCallId = options.toolCallId;
    this.outputLocation = { kind: "workflow-run", address: options.address };
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abort?.();
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener("abort", requestAbort, { once: true });
    }

    const deadlineTimeout: unique symbol = Symbol("background-workflow-deadline");
    const raceInputs: Array<Promise<{ runStatus: "completed" | "failed" } | typeof deadlineTimeout>> = [this.run(sink)];
    const timeoutMs = this.timeoutMs;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      raceInputs.push(
        new Promise<typeof deadlineTimeout>((resolve) => {
          timer = setTimeout(() => resolve(deadlineTimeout), timeoutMs);
        }),
      );
    }

    try {
      const outcome = await Promise.race(raceInputs);
      if (outcome === deadlineTimeout) {
        this.abort?.();
        await sink.settle({ status: "timed_out" });
        return;
      }
      this.runStatus = outcome.runStatus;
      await sink.settle({ status: outcome.runStatus === "completed" ? "completed" : "failed" });
    } catch (error: unknown) {
      if (sink.signal.aborted && isAbortError(error)) {
        await sink.settle({ status: "killed" });
        return;
      }
      await sink.settle({ status: "failed", stopReason: errorMessage(error) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sink.signal.removeEventListener("abort", requestAbort);
    }
  }

  toInfo(base: BackgroundTaskInfoBase): WorkflowBackgroundTaskInfo {
    return {
      ...base,
      kind: "workflow",
      workflowName: this.workflowName,
      runId: this.runId,
      runStatus: this.runStatus,
    };
  }
}
