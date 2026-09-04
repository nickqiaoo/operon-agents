import type { AgentEvent, EventSink } from "../events/index.ts";
import type { Message, Usage, UserMessage } from "../protocol/index.ts";
import type { PromptOrigin } from "../store/origin.ts";
import type { ToolResult } from "../tool/types.ts";
import type { TracingContentMode, TracingProcessor } from "./processor.ts";
import { Span, Trace, newSpanId, newTraceId, type GenerationUsage, type SpanData } from "./spans.ts";

export interface TracingBridgeOptions {
  readonly now?: () => number;
  /** Overrides `processor.content`. See `TracingContentMode`. */
  readonly content?: TracingContentMode;
}

/**
 * One trace = one run: the root agent's `agent.started` … `agent.ended` (a user prompt and every
 * turn, tool, sub-agent and handoff it triggers). The session id rides along as the trace's
 * `groupId` (→ `gen_ai.conversation.id`), so a viewer lists a conversation's runs by tag.
 *
 * A trace outlives its root when a sub-agent it spawned is still running (a background agent):
 * it lingers until the last agent span closes, then ends. The next root `agent.started` opens a
 * fresh trace regardless.
 */
interface TraceState {
  readonly trace: Trace;
  readonly root: Span;
  rootEnded: boolean;
  /** An `agent.handoff` closed the active root agent; the next root `agent.started` continues THIS trace. */
  handoffPending: boolean;
  readonly agentByAddress: Map<string, Span>;
  readonly turnByAddress: Map<string, Span>;
  /** The generation currently streaming (opened at `turn.step.started`). */
  readonly genByAddress: Map<string, Span>;
  /**
   * A generation whose step has completed (end time fixed) but whose assistant message has not
   * been appended yet — `turn.step.completed` fires BEFORE the message is journaled, and the
   * message is what carries model / usage / output. Reported when it arrives, or at the latest
   * when the next step / the turn / the agent closes.
   */
  readonly settledGenByAddress: Map<string, Span>;
  readonly compactionByAddress: Map<string, Span>;
  readonly toolById: Map<string, Span>;
  /** Run input appended before `agent.started`; becomes message spans under the first turn. */
  pendingPrompts: PendingPrompt[];
}

interface PendingPrompt {
  readonly message: UserMessage;
  readonly origin?: PromptOrigin;
}

/** Input messages a run can carry before its trace opens; more than this is not a prompt. */
const PENDING_PROMPTS_MAX = 8;

/** Cap on the tool-failure text copied into `span.error.message`. */
const TOOL_ERROR_MAX_CHARS = 500;
/** Cap on the prompt snippet that names the root span. */
const PROMPT_NAME_MAX_CHARS = 120;

/**
 * Subscribes to a session's `AgentEvent` stream and drives a `TracingProcessor` with a span tree:
 * agent → turn → generation | tool | message, sub-agents nested by address. With content enabled
 * (processor or option) the spans also carry the prompt, messages, tool args/results — see
 * `TracingContentMode`.
 */
export function eventSinkTracingBridge(sink: EventSink, processor: TracingProcessor, options: TracingBridgeOptions = {}): () => void {
  const now = options.now ?? (() => Date.now());
  const content: TracingContentMode = options.content ?? processor.content ?? "none";
  const withContent = content !== "none";
  /** Per session: the live traces, newest first. Index 0 is the current run while its root is open. */
  const sessions = new Map<string, TraceState[]>();
  /** Per session: user input appended while no run is open — the prompt of the run about to start. */
  const promptsBeforeRun = new Map<string, PendingPrompt[]>();

  const start = (st: TraceState, parent: Span | null, data: SpanData): Span => {
    const span = new Span({ traceId: st.trace.traceId, spanId: newSpanId(now()), parentId: parent?.spanId ?? null, data });
    span.startedAt = now();
    void Promise.resolve(processor.onSpanStart(span)).catch(() => {});
    return span;
  };
  /** Report a span as ended. Keeps an end time already fixed by `settle`. */
  const finish = (span: Span | undefined): void => {
    if (span === undefined) return;
    if (span.endedAt === null) span.endedAt = now();
    void Promise.resolve(processor.onSpanEnd(span)).catch(() => {});
  };
  /** Fix a span's end time now, but report it later (`finish`). */
  const settle = (span: Span): void => {
    if (span.endedAt === null) span.endedAt = now();
  };
  const flushSettledGen = (st: TraceState, address: string): void => {
    const span = st.settledGenByAddress.get(address);
    if (span === undefined) return;
    st.settledGenByAddress.delete(address);
    finish(span);
  };
  const emitPrompt = (st: TraceState, parent: Span | null, pending: PendingPrompt): void => {
    const origin = pending.origin?.kind;
    const span = start(st, parent, {
      type: "message",
      role: "user",
      ...(origin !== undefined ? { origin } : {}),
      content: pending.message.content,
    });
    finish(span);
  };
  const flushPendingPrompts = (st: TraceState, parent: Span | null): void => {
    for (const pending of st.pendingPrompts) emitPrompt(st, parent, pending);
    st.pendingPrompts = [];
  };
  const isRoot = (address: string): boolean => !address.includes("/");
  const parentAddress = (address: string): string => address.split("/").slice(0, -1).join("/");
  const currentParent = (st: TraceState, address: string): Span | null =>
    st.turnByAddress.get(address) ?? st.agentByAddress.get(address) ?? null;

  /** The trace that owns `address`: the one with an open agent span there, else the current run. */
  const traceFor = (sessionId: string, address: string): TraceState | undefined => {
    const traces = sessions.get(sessionId);
    if (traces === undefined) return undefined;
    const owner = traces.find((t) => t.agentByAddress.has(address));
    if (owner !== undefined) return owner;
    const current = traces[0];
    return current !== undefined && !current.rootEnded ? current : undefined;
  };
  const endTraceIfDone = (sessionId: string, st: TraceState): void => {
    if (!st.rootEnded || st.agentByAddress.size > 0) return;
    void Promise.resolve(processor.onTraceEnd(st.trace)).catch(() => {});
    const traces = sessions.get(sessionId);
    if (traces === undefined) return;
    const rest = traces.filter((t) => t !== st);
    if (rest.length === 0) sessions.delete(sessionId);
    else sessions.set(sessionId, rest);
  };

  const handle = (event: AgentEvent): void => {
    const { sessionId, address } = event;
    if (event.type === "agent.started") {
      if (isRoot(address)) {
        const continued = sessions.get(sessionId)?.[0];
        if (continued !== undefined && continued.handoffPending) {
          // Handoff target: same run, same trace, a new top-level agent span.
          continued.handoffPending = false;
          continued.agentByAddress.set(address, start(continued, null, { type: "agent", name: event.agent }));
          return;
        }
        const trace = new Trace({ traceId: newTraceId(now()), name: event.agent, groupId: sessionId });
        // The run's input was appended (and surfaced) before this event — see Runner.run. The
        // first prompt names the root span; the messages become spans once the turn opens.
        const pendingPrompts = withContent ? (promptsBeforeRun.get(sessionId) ?? []) : [];
        promptsBeforeRun.delete(sessionId);
        const prompt = pendingPrompts.map((p) => promptSnippet(p.message.content)).find((text) => text !== undefined);
        const st: TraceState = {
          trace,
          root: new Span({
            traceId: trace.traceId,
            spanId: newSpanId(now()),
            parentId: null,
            data: { type: "agent", name: event.agent, ...(prompt !== undefined ? { prompt } : {}) },
          }),
          rootEnded: false,
          handoffPending: false,
          agentByAddress: new Map(),
          turnByAddress: new Map(),
          genByAddress: new Map(),
          settledGenByAddress: new Map(),
          compactionByAddress: new Map(),
          toolById: new Map(),
          pendingPrompts,
        };
        void Promise.resolve(processor.onTraceStart(trace)).catch(() => {});
        st.root.startedAt = now();
        void Promise.resolve(processor.onSpanStart(st.root)).catch(() => {});
        st.agentByAddress.set(address, st.root);
        sessions.set(sessionId, [st, ...(sessions.get(sessionId) ?? [])]);
        return;
      }
      // A sub-agent nests under whoever owns its parent address — the lingering trace of a
      // finished run when it is that run's background agent spawning its own child.
      const st = traceFor(sessionId, parentAddress(address));
      if (st === undefined) return;
      const parent = st.agentByAddress.get(parentAddress(address)) ?? currentParent(st, parentAddress(address));
      st.agentByAddress.set(address, start(st, parent, { type: "agent", name: event.agent }));
      return;
    }

    const st = traceFor(sessionId, address);
    if (st === undefined) {
      if (withContent && event.type === "message.appended" && event.message.role === "user" && isRoot(address)) {
        const pending = promptsBeforeRun.get(sessionId) ?? [];
        if (pending.length < PENDING_PROMPTS_MAX) pending.push({ message: event.message, ...(event.origin !== undefined ? { origin: event.origin } : {}) });
        promptsBeforeRun.set(sessionId, pending);
      }
      return;
    }
    switch (event.type) {
      case "agent.ended": {
        flushSettledGen(st, address);
        if (isRoot(address)) flushPendingPrompts(st, st.agentByAddress.get(address) ?? null);
        finish(st.agentByAddress.get(address));
        st.agentByAddress.delete(address);
        if (isRoot(address)) st.rootEnded = true;
        endTraceIfDone(sessionId, st);
        break;
      }
      case "turn.started": {
        const turn = start(st, st.agentByAddress.get(address) ?? null, { type: "turn", turnId: event.turnId });
        st.turnByAddress.set(address, turn);
        if (isRoot(address)) flushPendingPrompts(st, turn);
        break;
      }
      case "turn.ended": {
        flushSettledGen(st, address);
        const span = st.turnByAddress.get(address);
        if (span !== undefined && span.data.type === "turn") {
          span.data = { ...span.data, reason: event.reason, ...(event.error !== undefined ? { error: event.error } : {}) };
          if (event.reason === "failed" && span.error === null) span.error = { message: event.error ?? "turn failed" };
        }
        finish(span);
        st.turnByAddress.delete(address);
        break;
      }
      case "turn.step.started": {
        // A model generation = one step. Open the gen span here; `model.request` fills in what
        // was sent, `turn.step.completed` fixes its end, and the assistant `message.appended`
        // (which follows) supplies model/usage/output and reports it.
        flushSettledGen(st, address);
        st.genByAddress.set(address, start(st, currentParent(st, address), { type: "generation" }));
        break;
      }
      case "model.request": {
        if (!withContent) break;
        const span = st.genByAddress.get(address);
        if (span === undefined || span.data.type !== "generation") break;
        const inputMode = content === "full" ? "full" : "delta";
        span.data = {
          ...span.data,
          ...(event.system !== undefined ? { system: event.system } : {}),
          toolNames: event.toolNames,
          ...(event.params !== undefined ? { params: event.params } : {}),
          input: inputMode === "full" ? event.messages : unansweredMessages(event.messages),
          inputMode,
        };
        break;
      }
      case "turn.step.retrying": {
        st.genByAddress.get(address)?.addEvent("retry", now(), {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
        break;
      }
      case "turn.step.reset": {
        st.genByAddress.get(address)?.addEvent("reset", now(), {
          discardedAttempt: event.discardedAttempt,
          nextAttempt: event.nextAttempt,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
        break;
      }
      case "message.appended": {
        const m = event.message;
        if (m.role === "assistant") {
          // The assistant message IS the model generation: report the gen span with its detail.
          const span = st.settledGenByAddress.get(address) ?? st.genByAddress.get(address);
          st.settledGenByAddress.delete(address);
          if (span !== undefined && span.data.type === "generation") {
            span.data = {
              ...span.data,
              model: m.responseModel ?? m.model,
              ...(m.responseId !== undefined ? { responseId: m.responseId } : {}),
              stopReason: m.stopReason,
              usage: generationUsage(m.usage),
              ...(withContent ? { output: m.content } : {}),
            };
            if (m.errorMessage !== undefined) span.error = { message: m.errorMessage };
            finish(span);
          }
          st.genByAddress.delete(address);
        } else if (m.role === "user" && withContent) {
          // A prompt entering the transcript mid-run (a steer, a follow-up drain). Tool results
          // are skipped: the tool span has them.
          emitPrompt(st, currentParent(st, address), { message: m, ...(event.origin !== undefined ? { origin: event.origin } : {}) });
          // A run whose input arrived this way (a wake run) still gets a prompt-named root.
          if (st.root.data.type === "agent" && st.root.data.prompt === undefined && isRoot(address)) {
            const prompt = promptSnippet(m.content);
            if (prompt !== undefined) st.root.data = { ...st.root.data, prompt };
          }
        }
        break;
      }
      case "turn.step.completed": {
        // The model call is over: fix the end time and record what the step itself knows. The
        // assistant message (model, output) is appended right after; report then — or at the
        // next step / turn end if it never comes.
        const span = st.genByAddress.get(address);
        st.genByAddress.delete(address);
        if (span === undefined || span.data.type !== "generation") break;
        settle(span);
        span.data = {
          ...span.data,
          ...(event.usage !== undefined ? { usage: generationUsage(event.usage) } : {}),
          ...(event.finishReason !== undefined && span.data.stopReason === undefined ? { stopReason: event.finishReason } : {}),
        };
        st.settledGenByAddress.set(address, span);
        break;
      }
      case "tool.call.started": {
        st.toolById.set(
          event.toolCallId,
          start(st, currentParent(st, address), {
            type: "tool",
            name: event.toolName,
            toolCallId: event.toolCallId,
            ...(withContent ? { args: event.args } : {}),
          }),
        );
        break;
      }
      case "tool.result": {
        const span = st.toolById.get(event.toolCallId);
        if (span !== undefined && span.data.type === "tool") {
          const isError = event.result.isError === true;
          span.data = { ...span.data, isError, ...(withContent ? { result: event.result } : {}) };
          if (isError) span.error = { message: toolErrorMessage(event.toolName, event.result) };
          finish(span);
        }
        st.toolById.delete(event.toolCallId);
        break;
      }
      case "agent.handoff": {
        // The run continues under the target agent at a new root address: keep the trace, close
        // the source agent span (the target's `agent.started` re-roots under the same trace).
        const span = start(st, currentParent(st, address), { type: "handoff", from: event.from, to: event.to });
        finish(span);
        const fromAddress = event.fromAddress ?? address;
        finish(st.agentByAddress.get(fromAddress));
        st.agentByAddress.delete(fromAddress);
        st.handoffPending = true;
        break;
      }
      case "compaction.started": {
        st.compactionByAddress.set(address, start(st, st.agentByAddress.get(address) ?? null, { type: "compaction", trigger: event.trigger }));
        break;
      }
      case "compaction.completed": {
        const span = st.compactionByAddress.get(address);
        if (span !== undefined) {
          span.data = { type: "compaction", tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter, compactedCount: event.compactedCount };
          finish(span);
        }
        st.compactionByAddress.delete(address);
        break;
      }
      case "error": {
        const target = currentParent(st, address);
        if (target !== null && target.error === null) target.error = { message: event.message };
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

/** Everything after the last assistant message: what the model is being asked to answer now. */
function unansweredMessages(messages: readonly Message[]): readonly Message[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages.slice(i + 1);
  }
  return messages;
}

function generationUsage(usage: Usage): GenerationUsage {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    total_tokens: usage.totalTokens,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
    ...(usage.reasoning !== undefined ? { reasoning_tokens: usage.reasoning } : {}),
    ...(typeof usage.cost?.total === "number" ? { cost_usd: usage.cost.total } : {}),
  };
}

function toolErrorMessage(toolName: string, result: ToolResult): string {
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
  if (text.length === 0) return `Tool ${toolName} failed`;
  return text.length > TOOL_ERROR_MAX_CHARS ? `${text.slice(0, TOOL_ERROR_MAX_CHARS)}…` : text;
}

function promptSnippet(content: UserMessage["content"]): string | undefined {
  const text = (typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join(" "))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return undefined;
  return text.length > PROMPT_NAME_MAX_CHARS ? `${text.slice(0, PROMPT_NAME_MAX_CHARS)}…` : text;
}
