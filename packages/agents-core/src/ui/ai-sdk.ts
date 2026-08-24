import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../events/events.ts";
import type { ToolResult } from "../tool/types.ts";

/**
 * Convert the framework's `AgentEvent` stream into the AI SDK "UI Message Stream"
 * chunk vocabulary that `@ai-sdk/react`'s `useChat` consumes — so a host can pipe
 * a run straight to a browser without writing its own mapper.
 *
 * Design:
 *  - Steps frame the stream: `turn.step.started` → `start-step`, `turn.step.completed` →
 *    `finish-step` (which also closes any open text/reasoning block).
 *  - Text / reasoning are driven by the live-only `assistant.delta` / `thinking.delta`
 *    events (a block opens lazily on its first delta and closes at step end); `content.part`
 *    is the recorded completed part and is not needed for streaming.
 *  - The tool-call part is sourced from `tool.call.started` (the authoritative per-call
 *    signal that pairs 1:1 with `tool.result`), so a result can never arrive without its call.
 *  - The chunk objects are structurally compatible with the AI SDK's `UIMessageChunk`
 *    but typed here independently, so this module adds NO dependency on `ai`.
 *  - The `start` chunk carries an internally generated UUID `messageId` (one per run).
 *  - ALL events are converted, including sub-agent ones (nested `address`); nesting is a
 *    consumer concern applied by mapping over the output chunks.
 */

export type UiMessageChunk =
  | { readonly type: "start"; readonly messageId?: string; readonly messageMetadata?: unknown }
  | { readonly type: "finish"; readonly finishReason?: string; readonly messageMetadata?: unknown }
  | { readonly type: "start-step" }
  | { readonly type: "finish-step" }
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "reasoning-start"; readonly id: string }
  | { readonly type: "reasoning-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "reasoning-end"; readonly id: string }
  | { readonly type: "tool-input-start"; readonly toolCallId: string; readonly toolName: string; readonly dynamic: true }
  | { readonly type: "tool-input-delta"; readonly toolCallId: string; readonly inputTextDelta: string }
  | { readonly type: "tool-input-available"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown; readonly dynamic: true }
  | { readonly type: "tool-output-available"; readonly toolCallId: string; readonly output: unknown; readonly dynamic: true; readonly preliminary?: true }
  | { readonly type: "tool-output-error"; readonly toolCallId: string; readonly errorText: string; readonly dynamic: true }
  | { readonly type: "message-metadata"; readonly messageMetadata: unknown }
  | { readonly type: "error"; readonly errorText: string };

/**
 * Stateful per-run converter. Feed it every `AgentEvent` from one run via `map(event)`
 * and write the returned chunks to the UI stream in order. One instance per run.
 */
export class AgentEventToUiStream {
  private started = false;
  private finished = false;
  private stepIndex = -1;
  /** Whether a text / reasoning block is currently open in the active step. */
  private textOpen = false;
  private reasoningOpen = false;
  /** Tool-call ids already surfaced as a `tool-input-start` (dedupe call vs delta). */
  private readonly startedInputs = new Set<string>();
  private readonly emittedCalls = new Set<string>();
  /** UUID stamped on the `start` chunk — stable for this run (one converter per run). */
  private readonly messageId: string;

  constructor(options: { readonly messageId?: string } = {}) {
    this.messageId = options.messageId ?? randomUUID();
  }

  map(event: AgentEvent): UiMessageChunk[] {
    const out: UiMessageChunk[] = [];
    const push = (chunk: UiMessageChunk): void => void out.push(chunk);

    if (!this.started) {
      this.started = true;
      push({ type: "start", messageId: this.messageId });
    }

    switch (event.type) {
      case "turn.step.started":
        this.stepIndex += 1;
        push({ type: "start-step" });
        break;
      case "turn.step.completed":
        this.closeOpenBlocks(push);
        push({ type: "finish-step" });
        break;
      case "turn.step.reset":
        this.closeOpenBlocks(push);
        push({
          type: "message-metadata",
          messageMetadata: {
            type: "turn.step.reset",
            turnId: event.turnId,
            step: event.step,
            discardedAttempt: event.discardedAttempt,
            nextAttempt: event.nextAttempt,
            reason: event.reason,
          },
        });
        break;

      case "assistant.delta":
        if (!this.textOpen) {
          this.textOpen = true;
          push({ type: "text-start", id: this.textId() });
        }
        push({ type: "text-delta", id: this.textId(), delta: event.delta });
        break;
      case "thinking.delta":
        if (!this.reasoningOpen) {
          this.reasoningOpen = true;
          push({ type: "reasoning-start", id: this.reasoningId() });
        }
        push({ type: "reasoning-delta", id: this.reasoningId(), delta: event.delta });
        break;
      case "content.part":
        // A completed part closes its streaming block (correct ordering vs. the following tool call).
        if (event.part.type === "text" && this.textOpen) {
          push({ type: "text-end", id: this.textId() });
          this.textOpen = false;
        } else if (event.part.type === "thinking" && this.reasoningOpen) {
          push({ type: "reasoning-end", id: this.reasoningId() });
          this.reasoningOpen = false;
        }
        break;

      case "tool.call.delta":
        if (event.toolName !== undefined && !this.startedInputs.has(event.toolCallId)) {
          this.startedInputs.add(event.toolCallId);
          push({ type: "tool-input-start", toolCallId: event.toolCallId, toolName: event.toolName, dynamic: true });
        }
        if (event.argumentsPart.length > 0) {
          push({ type: "tool-input-delta", toolCallId: event.toolCallId, inputTextDelta: event.argumentsPart });
        }
        break;
      case "tool.call.started":
        this.emitToolCall(push, event.toolCallId, event.toolName, event.args);
        break;
      case "tool.progress": {
        const text = typeof event.update.text === "string" && event.update.text.length > 0 ? event.update.text : undefined;
        if (text !== undefined) {
          push({ type: "tool-output-available", toolCallId: event.toolCallId, output: text, dynamic: true, preliminary: true });
        }
        break;
      }
      case "tool.result":
        // Guarantee the call exists before its result (e.g. a stream joined mid-flight).
        this.emitToolCall(push, event.toolCallId, event.toolName, undefined);
        if (event.isError) {
          push({ type: "tool-output-error", toolCallId: event.toolCallId, errorText: resultText(event.result), dynamic: true });
        } else {
          push({ type: "tool-output-available", toolCallId: event.toolCallId, output: resultText(event.result), dynamic: true });
        }
        break;

      case "guardrail.blocked":
        if (event.stage === "output") {
          this.closeOpenBlocks(push);
          push({ type: "finish-step" });
        }
        push({
          type: "message-metadata",
          messageMetadata: {
            type: "guardrail.blocked",
            stage: event.stage,
            guardrail: event.guardrail,
            turnId: event.turnId,
            step: event.step,
            stepId: event.stepId,
            message: event.message,
          },
        });
        break;

      case "error":
        push({ type: "error", errorText: event.message });
        break;
      case "agent.ended":
        // Only the OUTERMOST agent (top-level address, no "/") ending finishes the run — a
        // sub-agent's agent.ended must NOT finish the whole stream early.
        if (!event.address.includes("/") && !this.finished) {
          this.finished = true;
          push({ type: "finish", finishReason: "stop" });
        }
        break;
      default:
        break;
    }

    return out;
  }

  /** Close any open text / reasoning block at a step boundary. */
  private closeOpenBlocks(push: (chunk: UiMessageChunk) => void): void {
    if (this.textOpen) {
      push({ type: "text-end", id: this.textId() });
      this.textOpen = false;
    }
    if (this.reasoningOpen) {
      push({ type: "reasoning-end", id: this.reasoningId() });
      this.reasoningOpen = false;
    }
  }

  private emitToolCall(push: (chunk: UiMessageChunk) => void, toolCallId: string, toolName: string, input: unknown): void {
    if (this.emittedCalls.has(toolCallId)) return;
    this.emittedCalls.add(toolCallId);
    push({ type: "tool-input-available", toolCallId, toolName, input: input ?? {}, dynamic: true });
  }

  private textId(): string {
    return `t${this.stepIndex}`;
  }

  private reasoningId(): string {
    return `r${this.stepIndex}`;
  }
}

/** Convenience: convert a whole `AgentEvent` async stream into UI chunks. */
export async function* toUiMessageChunks(
  events: AsyncIterable<AgentEvent>,
): AsyncIterable<UiMessageChunk> {
  const mapper = new AgentEventToUiStream();
  for await (const event of events) {
    for (const chunk of mapper.map(event)) yield chunk;
  }
}

/** A tool result's text content, joined — generic renderers show text, not a part-array dump. */
function resultText(result: ToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
