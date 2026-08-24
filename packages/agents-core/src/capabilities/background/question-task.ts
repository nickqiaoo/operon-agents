import { errorMessage, isAbortError } from "../../loop/errors.ts";
import type { ToolResult } from "../../tool/types.ts";
import type { BackgroundTask, BackgroundTaskInfoBase, BackgroundTaskSink } from "./task.ts";

export interface QuestionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: "question";
  readonly questionCount: number;
  /**
   * What the user answered, once they have. Held on the task rather than pushed through the
   * sink because it is not output in the streaming sense — it arrives whole, exactly once, and
   * its one consumer is the settle notification that carries it into the conversation. (It has
   * to be carried: an answer is the user speaking, reproducible from nowhere.)
   */
  readonly answer?: string;
}

export interface QuestionBackgroundTaskOptions {
  readonly questionCount: number;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
}

export class QuestionBackgroundTask implements BackgroundTask {
  readonly kind = "question" as const;
  readonly idPrefix = "question";
  readonly description: string;
  readonly questionCount: number;
  readonly parentAddress?: string;
  readonly toolCallId?: string;
  private readonly run: (signal: AbortSignal) => Promise<ToolResult>;
  private answerText?: string;

  constructor(
    run: (signal: AbortSignal) => Promise<ToolResult>,
    description: string,
    options: QuestionBackgroundTaskOptions,
  ) {
    this.run = run;
    this.description = description;
    this.questionCount = options.questionCount;
    this.parentAddress = options.parentAddress;
    this.toolCallId = options.toolCallId;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    try {
      const result = await this.run(sink.signal);
      const output = serializeToolResult(result).trim();
      if (output.length > 0) this.answerText = output;
      await sink.settle({
        status: result.isError === true ? "failed" : "completed",
        stopReason: result.isError === true ? errorStopReason(result) : undefined,
      });
    } catch (error: unknown) {
      if (sink.signal.aborted && isAbortError(error)) {
        await sink.settle({ status: "killed" });
        return;
      }
      await sink.settle({ status: "failed", stopReason: errorMessage(error) });
    }
  }

  toInfo(base: BackgroundTaskInfoBase): QuestionBackgroundTaskInfo {
    return {
      ...base,
      kind: "question",
      questionCount: this.questionCount,
      answer: this.answerText,
    };
  }
}

function serializeToolResult(result: ToolResult): string {
  return result.content
    .filter((part): part is import("../../protocol/index.ts").TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function errorStopReason(result: ToolResult): string | undefined {
  const trimmed = serializeToolResult(result).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
