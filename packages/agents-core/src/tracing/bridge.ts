import type { AgentEvent, EventSink } from "../events/index.ts";
import type { TracingProcessor } from "./processor.ts";
import { Span, Trace, newSpanId, newTraceId, type SpanData, type SpanError } from "./spans.ts";

export interface TracingBridgeOptions {
  readonly now?: () => number;
}

interface SessionTrace {
  readonly trace: Trace;
  readonly agentByAddress: Map<string, Span>;
  readonly turnByAddress: Map<string, Span>;
  readonly genByAddress: Map<string, Span>;
  readonly compactionByAddress: Map<string, Span>;
  readonly toolById: Map<string, Span>;
}

export function eventSinkTracingBridge(sink: EventSink, processor: TracingProcessor, options: TracingBridgeOptions = {}): () => void {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, SessionTrace>();

  const start = (st: SessionTrace, address: string, parent: Span | null, data: SpanData): Span => {
    const span = new Span({ traceId: st.trace.traceId, spanId: newSpanId(now()), parentId: parent?.spanId ?? null, data });
    span.startedAt = now();
    void Promise.resolve(processor.onSpanStart(span)).catch(() => {});
    return span;
  };
  const finish = (span: Span | undefined): void => {
    if (span === undefined || span.endedAt !== null) return;
    span.endedAt = now();
    void Promise.resolve(processor.onSpanEnd(span)).catch(() => {});
  };
  const parentAddress = (address: string): string => address.split("/").slice(0, -1).join("/");
  const currentParent = (st: SessionTrace, address: string): Span | null =>
    st.turnByAddress.get(address) ?? st.agentByAddress.get(address) ?? null;

  const handle = (event: AgentEvent): void => {
    const { sessionId, address } = event;
    let st = sessions.get(sessionId);

    switch (event.type) {
      case "agent.started": {
        if (st === undefined) {
          const trace = new Trace({ traceId: newTraceId(now()), name: event.agent, groupId: sessionId });
          st = {
            trace,
            agentByAddress: new Map(),
            turnByAddress: new Map(),
            genByAddress: new Map(),
            compactionByAddress: new Map(),
            toolById: new Map(),
          };
          sessions.set(sessionId, st);
          void Promise.resolve(processor.onTraceStart(trace)).catch(() => {});
        }
        const parent = st.agentByAddress.get(parentAddress(address)) ?? null;
        st.agentByAddress.set(address, start(st, address, parent, { type: "agent", name: event.agent }));
        break;
      }
      case "agent.ended": {
        if (st === undefined) break;
        finish(st.agentByAddress.get(address));
        st.agentByAddress.delete(address);
        if (!address.includes("/")) {
          void Promise.resolve(processor.onTraceEnd(st.trace)).catch(() => {});
          sessions.delete(sessionId);
        }
        break;
      }
      case "turn.started": {
        if (st === undefined) break;
        st.turnByAddress.set(address, start(st, address, st.agentByAddress.get(address) ?? null, { type: "turn", turnId: event.turnId }));
        break;
      }
      case "turn.ended": {
        if (st === undefined) break;
        finish(st.turnByAddress.get(address));
        st.turnByAddress.delete(address);
        break;
      }
      case "turn.step.started": {
        // A model generation = one step. Open the gen span here; `message.appended` (assistant)
        // enriches + finishes it with the model/usage detail.
        if (st === undefined) break;
        st.genByAddress.set(address, start(st, address, currentParent(st, address), { type: "generation" }));
        break;
      }
      case "message.appended": {
        // Only the assistant message is the model generation; user/toolResult signals are
        // transcript-only. (Also narrows `message` to AssistantMessage.)
        if (st === undefined || event.message.role !== "assistant") break;
        const span = st.genByAddress.get(address);
        if (span !== undefined) {
          const m = event.message;
          span.data = {
            type: "generation",
            model: m.responseModel ?? m.model,
            responseId: m.responseId,
            stopReason: m.stopReason,
            usage: { input_tokens: m.usage.input, output_tokens: m.usage.output, total_tokens: m.usage.totalTokens },
          };
          if (m.errorMessage !== undefined) span.error = { message: m.errorMessage };
          finish(span);
        }
        st.genByAddress.delete(address);
        break;
      }
      case "turn.step.completed": {
        // Safety net: finish the gen span if no assistant `message.appended` closed it.
        if (st === undefined) break;
        finish(st.genByAddress.get(address));
        st.genByAddress.delete(address);
        break;
      }
      case "tool.call.started": {
        if (st === undefined) break;
        st.toolById.set(event.toolCallId, start(st, address, currentParent(st, address), { type: "tool", name: event.toolName, toolCallId: event.toolCallId }));
        break;
      }
      case "tool.result": {
        if (st === undefined) break;
        const span = st.toolById.get(event.toolCallId);
        if (span !== undefined) {
          const isError = event.result.isError === true;
          span.data = { type: "tool", name: event.toolName, toolCallId: event.toolCallId, isError };
          if (isError) span.error = { message: `Tool ${event.toolName} failed` };
          finish(span);
        }
        st.toolById.delete(event.toolCallId);
        break;
      }
      case "agent.handoff": {
        if (st === undefined) break;
        const span = start(st, address, currentParent(st, address), { type: "handoff", from: event.from, to: event.to });
        finish(span);
        const fromAddress = event.fromAddress ?? address;
        finish(st.agentByAddress.get(fromAddress));
        st.agentByAddress.delete(fromAddress);
        break;
      }
      case "compaction.started": {
        if (st === undefined) break;
        st.compactionByAddress.set(address, start(st, address, st.agentByAddress.get(address) ?? null, { type: "compaction", trigger: event.trigger }));
        break;
      }
      case "compaction.completed": {
        if (st === undefined) break;
        const span = st.compactionByAddress.get(address);
        if (span !== undefined) {
          span.data = { type: "compaction", tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter, compactedCount: event.compactedCount };
          finish(span);
        }
        st.compactionByAddress.delete(address);
        break;
      }
      case "error": {
        if (st === undefined) break;
        const target = currentParent(st, address);
        if (target !== null && target.error === null) target.error = { message: event.message } satisfies SpanError;
        break;
      }
      default:
        break; // non-span events (usage/goal/plan/skill/cron/background/warning/…) ignored
    }
  };

  return sink.subscribe((event) => {
    try {
      handle(event);
    } catch {
      /* tracing must never break the event bus */
    }
  });
}
