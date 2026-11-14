import { errorMessage } from "../../loop/errors.ts";
import type { CommandStarter, MonitorSpawnOptions, MonitorTiming } from "../../tool/background.ts";
import type { Environment } from "../../tool/environment.ts";
import { COMMAND_NOT_STOPPED_REASON, type CommandBackgroundTaskInfo } from "./command-task.ts";
import type { BackgroundTask, BackgroundTaskInfoBase, BackgroundTaskSink, TaskOutputLocation } from "./task.ts";

/**
 * A command whose stdout is an event stream: every line it prints reaches the model as it
 * happens, at the next step boundary, instead of once when the command ends.
 *
 * This is the Monitor tool's task. A background Bash command answers "tell me when it is done"
 * (one settle); a monitor answers "tell me every time X happens" (one notice per occurrence,
 * then a settle when the stream ends). The constants and wording follow Claude Code's Monitor
 * so a model trained on one reads the other the same way.
 *
 * Output lives where every command's does — in files on the Environment. stdout goes to the
 * task's log (its {@link TaskOutputLocation}) and stderr to a sibling file; the monitor receives
 * stdout through the command handle. The complete file remains available for Read after
 * the observation ends.
 */
export interface MonitorTaskInfo {
  /** Notices that reached the conversation (event batches, not lines). */
  readonly eventsDelivered: number;
  /** Batches dropped by the rate limit. */
  readonly eventsSuppressed: number;
  /** Where the command's stderr went. stderr never becomes an event. */
  readonly stderrPath: string;
  /** The deadline the watch was armed with. */
  readonly timeoutMs: number;
  /** Why the watch ended, when the monitor ended it rather than the command. */
  readonly endedBy?: "expired" | "too_much_output";
}

/** How a notice reaches the conversation. `housekeeping` marks the monitor's own notices
 *  (suppression, expiry) as opposed to the command's output. */
export type MonitorNotify = (text: string, options: { readonly housekeeping: boolean }) => void;

/** Claude Code's values (Monitor, 2.1.321). */
const DEFAULT_TIMING: Required<MonitorTiming> = {
  batchMs: 200,
  bucketCapacity: 10,
  bucketRefillMs: 2_000,
  sustainedSuppressionMs: 30_000,
};
/** A single line longer than this is cut. */
const MAX_LINE_CHARS = 500;
/** A batch (one notice) longer than this is cut. */
const MAX_BATCH_CHARS = 3_000;
/** An unterminated line is never buffered past this; its head is dropped. */
const MAX_PENDING_CHARS = 1_048_576;
/** Bytes read per poll. More than this waiting means the rate limit will drop most of it anyway. */

export class MonitorBackgroundTask implements BackgroundTask {
  readonly kind = "process" as const;
  readonly idPrefix = "monitor";
  readonly command: string;
  readonly description: string;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  readonly timeoutMs: number;
  readonly outputLocation: TaskOutputLocation;
  private readonly environment: Environment;
  private readonly logPath: string;
  private readonly stderrPath: string;
  private readonly start_: CommandStarter;
  private readonly timing: Required<MonitorTiming>;
  private readonly now: () => number;
  private processValue?: { readonly pid: number; readonly sandboxId: string };
  private exitCodeValue: number | null = null;
  private delivered = 0;
  private suppressed = 0;
  private endedBy: MonitorTaskInfo["endedBy"];

  constructor(start: CommandStarter, command: string, description: string, options: MonitorSpawnOptions) {
    this.start_ = start;
    this.command = command;
    this.description = description;
    this.environment = options.environment;
    this.logPath = options.logPath;
    this.stderrPath = options.stderrPath;
    this.timeoutMs = options.timeoutMs;
    this.parentAddress = options.parentAddress;
    this.toolCallId = options.toolCallId;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.outputLocation = { kind: "file", environment: options.environment, path: options.logPath };
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    const notify: MonitorNotify = (text, options) => sink.notify?.(text, options);
    const controller = new AbortController();
    const requestStop = (): void => controller.abort();
    if (sink.signal.aborted) requestStop();
    else sink.signal.addEventListener("abort", requestStop, { once: true });

    const limiter = new EventLimiter(this.timing, this.now, {
      deliver: (text) => {
        this.delivered += 1;
        notify(text, { housekeeping: false });
      },
      notice: (text) => notify(text, { housekeeping: true }),
      onSuppressed: () => {
        this.suppressed += 1;
      },
      tooMuch: (count, overMs) => {
        if (this.endedBy !== undefined) return;
        this.endedBy = "too_much_output";
        notify(
          `[Monitor stopped — too much output (${String(count)} events suppressed over ${String(Math.round(overMs / 1000))}s). Restart with a more selective filter.]`,
          { housekeeping: true },
        );
        controller.abort();
      },
    });
    const batcher = new LineBatcher(this.timing.batchMs, (text) => limiter.offer(text));


    const deadline = setTimeout(() => {
      if (this.endedBy !== undefined) return;
      this.endedBy = "expired";
      controller.abort();
    }, this.timeoutMs);

    try {
      const result = await this.start_({ signal: controller.signal, onOutput: chunk => batcher.push(chunk),
        onStart: async handle => { this.processValue = { pid: handle.pid, sandboxId: this.environment.sandbox.id }; await sink.update?.(); } });
      this.exitCodeValue = result.exitCode ?? null;
      batcher.flush(true);
      if (controller.signal.aborted && !result.terminated) {
        await sink.settle({ status: "failed", stopReason: COMMAND_NOT_STOPPED_REASON });
        return;
      }
      if (this.endedBy === "expired") {
        await sink.settle({ status: "timed_out" });
        return;
      }
      if (this.endedBy === "too_much_output") {
        await sink.settle({ status: "killed", stopReason: "too much output" });
        return;
      }
      await sink.settle({
        status: sink.signal.aborted ? "killed" : result.exitCode === 0 ? "completed" : "failed",
      });
    } catch (error: unknown) {

      batcher.flush(true);
      await sink.settle({
        status: sink.signal.aborted ? "killed" : "failed",
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      });
    } finally {
      clearTimeout(deadline);
      batcher.dispose();
      sink.signal.removeEventListener("abort", requestStop);
    }
  }

  toInfo(base: BackgroundTaskInfoBase): CommandBackgroundTaskInfo {
    const monitor: MonitorTaskInfo = {
      eventsDelivered: this.delivered,
      eventsSuppressed: this.suppressed,
      stderrPath: this.stderrPath,
      timeoutMs: this.timeoutMs,
      ...(this.endedBy !== undefined ? { endedBy: this.endedBy } : {}),
    };
    return { ...base, kind: "process", command: this.command, exitCode: this.exitCodeValue, monitor, process: this.processValue };
  }
}

/** The settle notice for a monitor: Claude Code's wording, plus where the logs are. */
export function monitorTerminalHead(info: CommandBackgroundTaskInfo & { readonly monitor: MonitorTaskInfo }): string {
  const name = `Monitor "${info.description}"`;
  const exit = info.exitCode !== null ? ` (exit ${String(info.exitCode)})` : "";
  const { eventsDelivered, timeoutMs, endedBy } = info.monitor;
  if (info.status === "timed_out" || endedBy === "expired") {
    const after = formatDuration(timeoutMs);
    return eventsDelivered === 0
      ? `[Monitor expired after ${after} with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`
      : `[Monitor expired after ${after} with ${String(eventsDelivered)} ${eventsDelivered === 1 ? "event" : "events"} delivered. Re-arm it if you still need the watch.]`;
  }
  switch (info.status) {
    case "completed":
      return eventsDelivered === 0 ? `${name} ended without producing output${exit}` : `${name} stream ended`;
    case "failed":
      return info.stopReason !== undefined ? `${name} script failed${exit}: ${info.stopReason}` : `${name} script failed${exit}`;
    case "killed":
      return info.stopReason !== undefined ? `${name} stopped: ${info.stopReason}` : `${name} stopped`;
    default:
      return `${name} ${info.status}`;
  }
}

export function isMonitorInfo(info: { readonly kind: string }): info is CommandBackgroundTaskInfo & { readonly monitor: MonitorTaskInfo } {
  return info.kind === "process" && (info as { monitor?: unknown }).monitor !== undefined;
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${String(ms / 60_000)}m`;
  if (ms % 1_000 === 0) return `${String(ms / 1_000)}s`;
  return `${String(ms)}ms`;
}

/**
 * Lines → notices. A line is trimmed, a blank one dropped, a long one cut; lines that arrive
 * within `batchMs` of the first are joined into one notice, so a multi-line event (a stack
 * trace, a test summary) lands as one message instead of a burst.
 */
export class LineBatcher {
  private pending = "";
  private lines: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly batchMs: number;
  private readonly emit: (text: string) => void;

  constructor(batchMs: number, emit: (text: string) => void) {
    this.batchMs = batchMs;
    this.emit = emit;
  }

  push(text: string): void {
    if (text.length === 0) return;
    this.pending += text;
    if (this.pending.length > MAX_PENDING_CHARS) this.pending = this.pending.slice(-MAX_PENDING_CHARS);
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) !== -1) {
      this.add(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
    if (this.lines.length > 0 && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush(false);
      }, this.batchMs);
    }
  }

  /** `final` also takes the unterminated tail as a line: the stream is over. */
  flush(final: boolean): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (final) {
      this.add(this.pending);
      this.pending = "";
    }
    if (this.lines.length === 0) return;
    let text = this.lines.join("\n");
    this.lines = [];
    if (text.length > MAX_BATCH_CHARS) text = `${text.slice(0, MAX_BATCH_CHARS)}\n...(truncated)`;
    this.emit(text);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private add(raw: string): void {
    let line = raw.trim();
    if (line.length === 0) return;
    if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}...(truncated)`;
    this.lines.push(line);
  }
}

/**
 * The rate limit: a token bucket per monitor. A dropped batch is counted, and the next one
 * that gets through is preceded by a notice saying how many were dropped. Suppression that
 * never lets up for `sustainedSuppressionMs` stops the monitor — a filter that lets everything
 * through is not going to start filtering by itself.
 */
interface LimiterOutput {
  readonly deliver: (text: string) => void;
  readonly notice: (text: string) => void;
  readonly onSuppressed: () => void;
  readonly tooMuch: (suppressed: number, overMs: number) => void;
}

export class EventLimiter {
  private tokens: number;
  private refilledAt: number;
  private suppressedSinceNotice = 0;
  private suppressingSince: number | undefined;
  private lastSuppressedAt: number | undefined;
  private readonly timing: Required<MonitorTiming>;
  private readonly now: () => number;
  private readonly out: LimiterOutput;

  constructor(timing: Required<MonitorTiming>, now: () => number, out: LimiterOutput) {
    this.timing = timing;
    this.now = now;
    this.out = out;
    this.tokens = timing.bucketCapacity;
    this.refilledAt = now();
  }

  offer(text: string): void {
    if (!this.take()) {
      this.suppressedSinceNotice += 1;
      this.out.onSuppressed();
      const at = this.now();
      this.lastSuppressedAt = at;
      this.suppressingSince ??= at;
      if (at - this.suppressingSince > this.timing.sustainedSuppressionMs) {
        this.out.tooMuch(this.suppressedSinceNotice, at - this.suppressingSince);
      }
      return;
    }
    if (this.suppressedSinceNotice > 0) {
      this.out.notice(
        `[${String(this.suppressedSinceNotice)} events suppressed — output rate too high. Consider using BackgroundStop to restart this monitor with a more selective filter.]`,
      );
      this.suppressedSinceNotice = 0;
    }
    // A stretch of suppression is over once nothing has been dropped for a few refills. Checked
    // on every delivery, not only the first after a drop: that one usually comes moments after
    // the last drop, and a stale start would make one later drop look like 30s of firehose.
    if (this.lastSuppressedAt !== undefined && this.now() - this.lastSuppressedAt > this.timing.bucketRefillMs * 3) {
      this.suppressingSince = undefined;
      this.lastSuppressedAt = undefined;
    }
    this.out.deliver(text);
  }

  private take(): boolean {
    const at = this.now();
    const earned = Math.floor((at - this.refilledAt) / this.timing.bucketRefillMs);
    if (earned > 0) {
      this.tokens = Math.min(this.timing.bucketCapacity, this.tokens + earned);
      this.refilledAt += earned * this.timing.bucketRefillMs;
    }
    if (this.tokens <= 0) return false;
    this.tokens -= 1;
    return true;
  }
}

export { DEFAULT_TIMING as MONITOR_DEFAULT_TIMING };
