import { errorMessage, isAbortError } from "../../loop/errors.ts";
import type { BackgroundTask, BackgroundTaskInfoBase, BackgroundTaskSink, TaskOutputLocation } from "./task.ts";

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: "agent";
  readonly agentId?: string;
  readonly subagentType?: string;
  /** The subagent run's own terminal status (finer than the task status), once settled. */
  readonly agentStatus?: string;
}

export interface AgentBackgroundTaskOptions {
  readonly timeoutMs?: number;
  readonly abort?: () => void;
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  /** The sub-agent's own conversation shard — every background agent must have one. */
  readonly address: string;
}

/**
 * A sub-agent run as a background task.
 *
 * Holds NO output. The sub-agent's answer is the last assistant message of its shard, written
 * there by its own conversation as the run proceeds — so this task states the address and
 * stops, exactly as {@link CommandBackgroundTask} states a log path. Copying the answer into
 * the sink as well would make a third copy (after the shard and the projection that folds the
 * same events), authoritative in none of them, and — because the copy is only written when the
 * run settles — would leave a reader of a RUNNING agent staring at an empty buffer while the
 * shard already holds every message so far.
 */
export class AgentBackgroundTask implements BackgroundTask {
  readonly kind = "agent" as const;
  readonly idPrefix: string = "agent";
  readonly description: string;
  readonly timeoutMs?: number;
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  readonly outputLocation?: TaskOutputLocation;
  private agentStatus?: string;
  private readonly run: () => Promise<{ agentStatus: string }>;
  private readonly abort?: () => void;

  constructor(
    run: Promise<{ agentStatus: string }> | (() => Promise<{ agentStatus: string }>),
    description: string,
    options: AgentBackgroundTaskOptions,
  ) {
    if (typeof options.address !== "string" || options.address.length === 0) {
      throw new Error("A background Agent requires its durable conversation address.");
    }
    this.run = typeof run === "function" ? run : () => run;
    this.description = description;
    this.timeoutMs = options.timeoutMs;
    this.abort = options.abort;
    this.agentId = options.agentId;
    this.subagentType = options.subagentType;
    this.parentAddress = options.parentAddress;
    this.toolCallId = options.toolCallId;
    this.outputLocation = { kind: "conversation", address: options.address };
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

    const deadlineTimeout: unique symbol = Symbol("background-agent-deadline");
    const raceInputs: Array<Promise<{ agentStatus: string } | typeof deadlineTimeout>> = [this.run()];
    const timeoutMs = this.timeoutMs;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      raceInputs.push(new Promise<typeof deadlineTimeout>((resolve) => {
        timer = setTimeout(() => resolve(deadlineTimeout), timeoutMs);
      }));
    }

    try {
      const outcome = await Promise.race(raceInputs);
      if (outcome === deadlineTimeout) {
        this.abort?.();
        await sink.settle({ status: "timed_out" });
        return;
      }
      this.agentStatus = outcome.agentStatus;
      await sink.settle({ status: taskStatusFromAgent(outcome.agentStatus) });
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

  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: "agent",
      agentId: this.agentId,
      subagentType: this.subagentType,
      agentStatus: this.agentStatus,
    };
  }
}

function taskStatusFromAgent(status: string): "completed" | "failed" | "paused" | "killed" {
  if (status === "completed") return "completed";
  if (status === "paused") return "paused";
  if (status === "cancelled") return "killed";
  return "failed";
}
