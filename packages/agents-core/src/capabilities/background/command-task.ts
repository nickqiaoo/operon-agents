import { stopOutputSubscription } from '../../tool/environment-output.ts';
import { errorMessage } from "../../loop/errors.ts";
import type { CommandStarter, ProcessSpawnOptions } from "../../tool/background.ts";
import type { Environment, CommandHandle } from "../../tool/environment.ts";
import type { BackgroundTask, BackgroundTaskInfoBase, BackgroundTaskSink, TaskOutputLocation } from "./task.ts";
import type { MonitorTaskInfo } from "./monitor-task.ts";

/** Why a command task that was asked to stop settled as failed rather than killed. */
export const COMMAND_NOT_STOPPED_REASON =
  "a stop was requested, but the command could not be confirmed stopped and may still be running";

export interface CommandBackgroundTaskInfo extends BackgroundTaskInfoBase {
  /** Wire value kept as "process" — persisted task records use it. */
  readonly kind: "process";
  readonly process?: { readonly pid: number; readonly sandboxId: string };
  readonly command: string;
  readonly exitCode: number | null;
  /** Present on a Monitor's task: its stdout is an event stream, not a result. */
  readonly monitor?: MonitorTaskInfo;
}

/** A durable command task. The starter exposes its handle before waiting; identity is
 * persisted immediately and the environment owns log capture and process termination. */
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
  private handle?: CommandHandle;
  async disconnectOutput(): Promise<void> {
    // SDK disconnect also abandons wait(); retain lifecycle ownership until settlement.
    if (this.handle) await stopOutputSubscription(this.handle);
  }
  private processValue?: { readonly pid: number; readonly sandboxId: string };
  private outputListeners = new Set<(data: string) => void>();
  subscribeOutput(listener: (data: string) => void): () => void { this.outputListeners.add(listener); return () => { this.outputListeners.delete(listener); }; }
  private exitCodeValue: number | null = null;
  private stopUnconfirmedValue = false;

  constructor(start: CommandStarter, command: string, description: string, options: ProcessSpawnOptions = {}) {
    this.start_ = start;
    this.command = command;
    this.description = description;
    this.parentAddress = options.parentAddress;
    this.toolCallId = options.toolCallId;
    const { logPath, environment } = options;
    if (logPath !== undefined && environment !== undefined) this.outputLocation = { kind: "file", environment, path: logPath };
  }

  /** Latest known exit status; null until the command settles, or when it reported none. */
  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  /** A stop was requested and the backend could not confirm the command ended — it may still
   *  be running. Only meaningful once the task has settled. */
  get stopUnconfirmed(): boolean {
    return this.stopUnconfirmedValue;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    // The sink's signal is the manager's stop switch; forward it to the command. Its own
    // controller keeps the two decoupled, so a future internal stop reason stays possible.
    const controller = new AbortController();
    const requestStop = (): void => controller.abort();
    if (sink.signal.aborted) requestStop();
    else sink.signal.addEventListener("abort", requestStop, { once: true });

    // The command's output was redirected ON THE ENVIRONMENT before this starts. That file IS the
    // output; readers open a window on it only when somebody asks. No pipe tap or in-memory
    // mirror exists on the background path.
    try {
      // `run` resolves only after both streams are fully drained, so — unlike the raw-pipe
      // shape this replaced — there is no trailing output to race a drain timer against.
      const result = await this.start_({
        signal: controller.signal,
        onStart: async handle => {
          this.handle = handle;
          const location = this.outputLocation;
          if (location?.kind === 'file') this.processValue = { pid: handle.pid, sandboxId: location.environment.sandbox.id };
          await sink.update?.();
        },
        onOutput: this.outputListeners.size ? data => { for (const cb of this.outputListeners) cb(data); } : undefined,
      });
      this.exitCodeValue = result.exitCode ?? null;
      if (sink.signal.aborted && !result.terminated) {
        // The backend walked away rather than stopped it. "killed" would tell the model and the
        // user the command is gone when it may well still be running.
        this.stopUnconfirmedValue = true;
        await sink.settle({ status: "failed", stopReason: COMMAND_NOT_STOPPED_REASON });
        return;
      }
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
      process: this.processValue,
      exitCode: this.exitCodeValue,
    };
  }
}
