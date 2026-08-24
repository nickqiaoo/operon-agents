import { errorMessage } from "../../loop/errors.ts";
import type { CommandStarter, ProcessSpawnOptions } from "../../tool/background.ts";
import type { Machine } from "../../tool/machine.ts";
import type { BackgroundTask, BackgroundTaskInfoBase, BackgroundTaskSink, TaskOutputLocation } from "./task.ts";

export interface CommandBackgroundTaskInfo extends BackgroundTaskInfoBase {
  /** Wire value kept as "process" — persisted task records use it. */
  readonly kind: "process";
  readonly command: string;
  readonly exitCode: number | null;
}

/**
 * A shell command running as a background task.
 *
 * Driven by a {@link CommandStarter}, NOT by a process handle. The distinction is the whole
 * point: a background task needs to stream output, be stopped, and report how it ended —
 * all three of which are `run`'s intent fields, and all three of which every backend can
 * deliver natively. Requiring a live process handle instead would demand a capability that
 * sandbox transports cannot provide honestly, which is what used to force a fake handle
 * whose `kill()` did nothing.
 *
 * No `forceStop`: SIGTERM → grace → SIGKILL escalation belongs to the Machine layer, which
 * is where killing is real. Aborting the signal is the whole stop protocol.
 */
export class CommandBackgroundTask implements BackgroundTask {
  readonly kind = "process" as const;
  readonly idPrefix = "bash";
  readonly command: string;
  readonly description: string;
  /**
   * Where this command's output actually lives. A FACT, not a behaviour: the task states the
   * location and nothing else, and whoever wants to look owns every decision about how much
   * to read. BackgroundManager rejects process tasks without this file.
   */
  readonly outputLocation?: TaskOutputLocation;
  private readonly start_: CommandStarter;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  private exitCodeValue: number | null = null;

  constructor(start: CommandStarter, command: string, description: string, options: ProcessSpawnOptions = {}) {
    this.start_ = start;
    this.command = command;
    this.description = description;
    this.parentAddress = options.parentAddress;
    this.toolCallId = options.toolCallId;
    const { logPath, machine } = options;
    if (logPath !== undefined && machine !== undefined) this.outputLocation = { kind: "file", machine, path: logPath };
  }

  /** Latest known exit status; null until the command settles, or when it reported none. */
  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    // The sink's signal is the manager's stop switch; forward it to the command. Its own
    // controller keeps the two decoupled, so a future internal stop reason stays possible.
    const controller = new AbortController();
    const requestStop = (): void => controller.abort();
    if (sink.signal.aborted) requestStop();
    else sink.signal.addEventListener("abort", requestStop, { once: true });

    // The command's output was redirected ON THE MACHINE before this starts. That file IS the
    // output; readers open a window on it only when somebody asks. No pipe tap or in-memory
    // mirror exists on the background path.
    try {
      // `run` resolves only after both streams are fully drained, so — unlike the raw-pipe
      // shape this replaced — there is no trailing output to race a drain timer against.
      const result = await this.start_({
        signal: controller.signal,
      });
      this.exitCodeValue = result.exitCode ?? null;
      await sink.settle({
        status: sink.signal.aborted ? "killed" : result.exitCode === 0 ? "completed" : "failed",
      });
    } catch (error: unknown) {
      await sink.settle({
        status: sink.signal.aborted ? "killed" : "failed",
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      });
    } finally {
      sink.signal.removeEventListener("abort", requestStop);
    }
  }

  toInfo(base: BackgroundTaskInfoBase): CommandBackgroundTaskInfo {
    return {
      ...base,
      kind: "process",
      command: this.command,
      exitCode: this.exitCodeValue,
    };
  }
}
