/**
 * Runtime events → managed session events. The only place the two vocabularies meet, and it
 * runs on the worker: what is recorded in a session's history and broadcast to its streams is
 * already in the managed vocabulary.
 *
 * Only the root conversation (`main`) is translated. Subagent frames are the runtime's own
 * structure; their outcome reaches the root as the tool result of the call that delegated.
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, PendingRunInterrupt } from "operon-agents";
import type { ManagedEventResource, ManagedModelUsage, ManagedOutputEvent, ManagedStreamEvent, TextBlock } from "../protocol/types.ts";

/**
 * The id of the `agent.tool_use` / `agent.custom_tool_use` event a paused call blocks on.
 * Derived from the interrupt, so any worker — including one that reopened the session after
 * a crash — names the same call the same way, and a `user.tool_confirmation` for it resolves.
 */
export function blockingEventId(pending: Pick<PendingRunInterrupt, "approvalId">): string {
  return `sevt_${pending.approvalId}`;
}

export class ManagedEventTranslator {
  /** toolCallId → id of the `agent.tool_use` event that announced it. */
  private readonly toolUses = new Map<string, string>();
  private turnOpen = false;
  /** A failed turn whose reason has not arrived yet: its idle waits for the `error` event. */
  private failedIdle: ManagedEventResource | undefined;
  /**
   * The `agent.message` being previewed: its id is chosen at the first delta, because the
   * preview has to name the event before the message exists. `index` is the text block the
   * deltas are filling, counted the way `agent.message.content` counts (non-empty text only).
   */
  private preview: { readonly id: string; index: number } | undefined;
  /**
   * The model request in flight: the id of its `span.model_request_start`. One per attempt — a
   * step retried inside the same step (`turn.step.retrying`) is a new request.
   */
  private span: string | undefined;
  /** A retry ended the last request; the next model activity opens the next one. */
  private restart = false;
  /**
   * A request that succeeded ends after the message it produced, as in Claude — but the runtime
   * reports the step complete first, so its end waits for the message (or whatever comes next).
   */
  private heldEnd: ManagedEventResource | undefined;

  /** A session reopened while paused: its calls were announced by a previous worker. */
  seed(pending: readonly PendingRunInterrupt[]): void {
    for (const item of pending) this.toolUses.set(item.toolCallId, blockingEventId(item));
  }

  /**
   * Persisted events come back with `processed_at: null`; previews (`event_start` /
   * `event_delta`) come back too, in order, and are the caller's to keep out of the history.
   */
  translate(event: AgentEvent): ManagedStreamEvent[] {
    if (event.address !== undefined && event.address !== "main") return [];
    const out: ManagedStreamEvent[] = [];
    const emit = (id: string, body: ManagedOutputEvent): void => {
      out.push({ ...body, id, processed_at: null } as ManagedEventResource);
    };
    const openSpan = (id: string): void => {
      this.span = id;
      this.restart = false;
      emit(id, { type: "span.model_request_start" });
    };
    const endSpan = (isError: boolean, usage: ManagedModelUsage | null): ManagedEventResource | undefined => {
      const start = this.span;
      this.span = undefined;
      if (start === undefined) return undefined;
      return { type: "span.model_request_end", id: `${start}_end`, processed_at: null, model_request_start_id: start, is_error: isError, model_usage: usage };
    };
    const closeSpan = (): void => {
      const end = endSpan(true, null);
      if (end !== undefined) out.push(end);
    };
    const releaseEnd = (): void => {
      if (this.heldEnd !== undefined) out.push(this.heldEnd);
      this.heldEnd = undefined;
    };
    // ── Model requests: `span.model_request_start` / `span.model_request_end` ──
    const assistantMessage = event.type === "message.appended" && event.message.role === "assistant";
    // Anything but the message means the message is not coming: the held end goes out first.
    if (!assistantMessage) releaseEnd();
    switch (event.type) {
      case "turn.step.started":
        closeSpan();
        openSpan(event.eventId);
        break;
      case "assistant.delta":
      case "thinking.delta":
      case "tool.call.delta":
      case "turn.step.completed":
        if (this.span === undefined && this.restart) openSpan(`sevt_${randomUUID().replaceAll("-", "")}`);
        break;
      case "turn.step.retrying":
        // The request failed; another follows — in this step, or in a re-run that starts anew.
        closeSpan();
        this.restart = true;
        break;
      case "turn.step.interrupted":
      case "turn.ended":
      case "turn.paused":
        closeSpan();
        this.restart = false;
        break;
      default:
        break;
    }
    if (event.type === "turn.step.completed") {
      this.heldEnd = endSpan(event.finishReason === "error", usageOf(event.usage));
    }
    switch (event.type) {
      case "assistant.delta": {
        if (event.delta === "") break;
        if (this.preview === undefined) {
          this.preview = { id: `sevt_${randomUUID().replaceAll("-", "")}`, index: 0 };
          out.push({ type: "event_start", event: { type: "agent.message", id: this.preview.id } });
        }
        out.push({
          type: "event_delta",
          event_id: this.preview.id,
          delta: { type: "content_delta", index: this.preview.index, content: { type: "text", text: event.delta } },
        });
        break;
      }
      case "content.part":
        // A text block closed; the next deltas fill the next one. Empty blocks are not in the
        // message's content, so they do not take an index.
        if (this.preview !== undefined && event.part.type === "text" && event.part.text !== "") this.preview.index += 1;
        break;
      case "turn.step.reset":
        // The attempt that produced the preview was discarded; its text is not a prefix of what
        // comes next. The retry previews under a new id, and this one is never reconciled.
        this.preview = undefined;
        break;
      case "turn.started":
        this.turnOpen = true;
        this.preview = undefined;
        emit(event.eventId, { type: "session.status_running" });
        break;
      case "turn.ended":
        this.turnOpen = false;
        this.preview = undefined;
        out.push(...this.takeFailedIdle());
        if (event.reason === "failed" && event.error === undefined) {
          // The reason follows as a live `error` event; report it before saying idle.
          this.failedIdle = { type: "session.status_idle", stop_reason: { type: "end_turn" }, id: event.eventId, processed_at: null };
          break;
        }
        if (event.reason === "failed") {
          emit(`${event.eventId}_error`, { type: "session.error", error: { type: "execution_error", message: event.error! } });
        }
        emit(event.eventId, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
        break;
      case "turn.paused": {
        this.turnOpen = false;
        this.preview = undefined;
        const blocking: string[] = [];
        for (const item of event.pending) {
          const id = blockingEventId(item);
          blocking.push(id);
          this.toolUses.set(item.toolCallId, id);
          if (item.kind === "approval") {
            emit(id, { type: "agent.tool_use", name: item.toolName, input: item.display ?? null, evaluated_permission: "ask" });
          } else {
            emit(id, { type: "agent.custom_tool_use", name: item.toolName, input: item.request });
          }
        }
        emit(event.eventId, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: blocking } });
        break;
      }
      case "message.appended": {
        if (event.message.role !== "assistant") break;
        const content = (event.message.content as readonly { type: string; text?: string }[])
          .filter((part): part is TextBlock => part.type === "text" && typeof part.text === "string" && part.text !== "")
          .map((part) => ({ type: "text" as const, text: part.text }));
        // A previewed message keeps the id its preview announced.
        const id = this.preview?.id ?? event.eventId;
        this.preview = undefined;
        if (content.length > 0) emit(id, { type: "agent.message", content });
        releaseEnd();
        break;
      }
      case "tool.call.started":
        // An approved call starting after a pause was announced when the session paused.
        if (this.toolUses.has(event.toolCallId)) break;
        this.toolUses.set(event.toolCallId, event.eventId);
        emit(event.eventId, { type: "agent.tool_use", name: event.toolName, input: event.args, evaluated_permission: "allow" });
        break;
      case "tool.result":
        emit(event.eventId, {
          type: "agent.tool_result",
          tool_use_id: this.toolUses.get(event.toolCallId) ?? event.toolCallId,
          content: event.result.content,
          is_error: event.isError,
        });
        this.toolUses.delete(event.toolCallId);
        break;
      case "error":
        // Inside a turn the failure is reported when the turn ends. Here: the reason for a
        // failed turn that ended without one, or a run that never opened a turn at all.
        if (this.turnOpen) break;
        emit(event.eventId, { type: "session.error", error: { type: "execution_error", message: event.message } });
        if (this.failedIdle !== undefined) out.push(...this.takeFailedIdle());
        break;
      default:
        break;
    }
    // Output that is not the reason means none is coming: the held idle goes out ahead of it.
    if (this.failedIdle !== undefined && out.length > 0 && event.type !== "error") out.unshift(...this.takeFailedIdle());
    return out;
  }

  private takeFailedIdle(): ManagedEventResource[] {
    const held = this.failedIdle;
    this.failedIdle = undefined;
    return held === undefined ? [] : [held];
  }

  /** Events held back waiting for something that did not come; call when the run settles. */
  flush(): ManagedEventResource[] {
    const held = [this.heldEnd, this.failedIdle].filter((event): event is ManagedEventResource => event !== undefined);
    this.heldEnd = undefined;
    this.failedIdle = undefined;
    return held;
  }
}

function usageOf(usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | undefined): ManagedModelUsage | null {
  if (usage === undefined) return null;
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  };
}
