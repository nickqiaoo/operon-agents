import { errorMessage, isAbortError } from "../../loop/errors.ts";
import type { Machine } from "../../tool/machine.ts";
import type { BackgroundTask, BackgroundTaskInfoBase, BackgroundTaskSink, TaskOutputLocation } from "./task.ts";

export interface CodeBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: "code";
  /** The model's one-line description of the program. */
  readonly program: string;
}

export interface CodeBackgroundTaskOptions {
  readonly timeoutMs?: number;
  readonly abort?: () => void;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  /** The log file on the machine the program writes its output to. Every background program must have one. */
  readonly logPath: string;
  readonly machine: Machine;
}

/**
 * A background task that runs a Code Mode program (`RunCode`) to completion.
 *
 * Holds no output of its own: the program's owner writes its console lines, each nested tool
 * call's outcome and the final result to a log file on the machine as they happen, the same
 * place a background command's bytes go, and this task names that file. `BackgroundOutput`
 * reads it like any other file-backed task; a detached program's progress is the same thing
 * an attached one's was, in the same place.
 */
export class CodeBackgroundTask implements BackgroundTask {
  readonly kind = "code" as const;
  readonly idPrefix: string = "code";
  readonly description: string;
  readonly timeoutMs?: number;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  readonly outputLocation: TaskOutputLocation;
  private readonly run: (sink: BackgroundTaskSink) => Promise<{ ok: boolean; stopReason?: string }>;
  private readonly abort?: () => void;

  constructor(
    run: (sink: BackgroundTaskSink) => Promise<{ ok: boolean; stopReason?: string }>,
    description: string,
    options: CodeBackgroundTaskOptions,
  ) {
    if (typeof options.logPath !== "string" || options.logPath.length === 0) {
      throw new Error("A background program requires its durable output log.");
    }
    this.run = run;
    this.description = description;
    this.timeoutMs = options.timeoutMs;
    this.abort = options.abort;
    this.parentAddress = options.parentAddress;
    this.toolCallId = options.toolCallId;
    this.outputLocation = { kind: "file", machine: options.machine, path: options.logPath };
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abort?.();
    };
    if (sink.signal.aborted) requestAbort();
    else sink.signal.addEventListener("abort", requestAbort, { once: true });

    const deadline: unique symbol = Symbol("background-code-deadline");
    const races: Array<Promise<{ ok: boolean; stopReason?: string } | typeof deadline>> = [this.run(sink)];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs !== undefined && this.timeoutMs > 0) {
      races.push(new Promise<typeof deadline>((resolve) => {
        timer = setTimeout(() => resolve(deadline), this.timeoutMs);
      }));
    }
    try {
      const outcome = await Promise.race(races);
      if (outcome === deadline) {
        this.abort?.();
        await sink.settle({ status: "timed_out" });
        return;
      }
      await sink.settle(outcome.ok ? { status: "completed" } : { status: "failed", ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}) });
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

  toInfo(base: BackgroundTaskInfoBase): CodeBackgroundTaskInfo {
    return { ...base, kind: "code", program: this.description };
  }
}
