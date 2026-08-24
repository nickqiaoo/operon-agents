/**
 * Runtime-frame support: the free functions every engine collaborator (the turn loop,
 * the handoff executor, the durable pause, the toolset, the hook builder) shares. They
 * take the frame (`RunState`) or plain messages as input and hold no state of their own,
 * so collaborators import THESE instead of reaching back into the Engine. Only TYPES are
 * imported from `runner.ts`, so there is no value-level import cycle.
 */
import type { AssistantMessage, Message } from "../protocol/index.ts";
import type { ModelSettings, ThinkingLevel } from "../llm/model.ts";
import type { AgentEventBody, AgentEventInput, EventSink } from "../events/index.ts";
import { emptyUsage } from "../loop/usage.ts";
import { newInterruptionId } from "../loop/interruption.ts";
import type { ConversationContext, HistoryChangeListener } from "../loop/context.ts";
import { customMessage, DEFAULT_ADDRESS } from "../store/store.ts";
import { systemReminder } from "../capabilities/injection.ts";
import { estimateTokens } from "../capabilities/compaction/tokens.ts";
import type { AgentRunContext } from "./agent.ts";
import type { DeriveOptions, RunState, RunStatus } from "./runner.ts";
import type { TurnStopReason } from "../loop/types.ts";

/**
 * This frame's flat directory id — what peers address it by.
 *
 * A child frame always carries `parentFrameId` (set unconditionally by `deriveChild`), so its
 * absence identifies the root frame. The root IS the session for addressing purposes; every
 * child is its own agent instance. Deliberately derived rather than stored: one less field to
 * keep in sync across derive/resume, and no magic `"root"` string comparison.
 */
export function selfAgentId<TContext>(state: RunState<TContext>): string {
  return state.parentFrameId === undefined ? state.sessionId : state.agentInstanceId;
}

/** Stamp the frame envelope (address/sessionId) onto an event body and emit it. */
export function emitRunEvent<TContext>(state: RunState<TContext>, body: AgentEventBody): void | Promise<void> {
  const event = { ...body, address: state.address, sessionId: state.sessionId } as AgentEventInput;
  return state.events.emit(event);
}

/**
 * The single translation from a journaled history record to its event. Hand this to a
 * `ConversationContext` as `onHistoryChange` and every history mutation broadcasts itself —
 * no call site has to remember to emit next to its mutation, which is the mistake that
 * silently dropped `replaceHistory` from the stream entirely.
 *
 * The address comes from the RECORD, not from the frame: it names the shard the message
 * actually landed in, which is what a consumer routing by address needs. (These coincide for
 * every frame today; a handoff opening a fresh shard is where they would not.)
 *
 * Exhaustive over history-bearing record types, so adding a fourth one fails compilation here
 * rather than silently skipping the stream.
 */
export function historyChangeEmitter(events: EventSink, sessionId: string): HistoryChangeListener {
  return (record) => {
    const address = record.address ?? DEFAULT_ADDRESS;
    switch (record.type) {
      case "context.append_message":
        void events.emit({ type: "message.appended", message: record.message, origin: record.origin, address, sessionId });
        return;
      case "custom_message":
        void events.emit({
          type: "message.appended",
          message: customMessage(record.content, record.time),
          origin: record.origin,
          address,
          sessionId,
        });
        return;
      case "context.replace":
        void events.emit({ type: "history.replaced", messages: record.messages, origins: record.origins, address, sessionId });
        return;
      case "context.apply_compaction":
        void events.emit({
          type: "history.compacted",
          cutoff: record.cutoff,
          summary: record.summary,
          summaryTimestamp: record.summaryTimestamp,
          address,
          sessionId,
        });
        return;
      default:
        // Audit / bookkeeping records (usage, approvals, config, custom, …) carry no history
        // change. They are journaled through the same door but have their own events already.
        return;
    }
  };
}

/**
 * Fold the agent profile's static `modelSettings` and the session's runtime overrides into the
 * params one request carries.
 *
 * Precedence, lowest to highest: `ModelSpec.requestOptions` (model instance defaults, applied
 * down in `toOptions`) < `agent.modelSettings` < session runtime (`setThinkingLevel()`) <
 * `LlmRequest.providerOptions` (the extension escape hatch). The session tier outranks the
 * profile because it is a live user decision: a level picked mid-session must not be overruled
 * by static config.
 *
 * Returns `undefined` when nothing is set, so requests from agents with no `modelSettings`
 * stay exactly as they were.
 */
export function resolveModelParams(
  settings: ModelSettings | undefined,
  sessionThinking: ThinkingLevel | undefined,
): ModelSettings | undefined {
  const thinking = sessionThinking ?? settings?.thinking;
  const params: ModelSettings = {
    ...(settings?.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings?.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(settings?.thinkingBudgets !== undefined ? { thinkingBudgets: settings.thinkingBudgets } : {}),
  };
  return Object.keys(params).length > 0 ? params : undefined;
}

/** The run context handed to agent-facing callbacks (instructions/guardrails/onHandoff). */
export function runCtxFor<TContext>(state: RunState<TContext>): AgentRunContext<TContext> {
  return {
    sessionId: state.sessionId,
    address: state.address,
    signal: state.signal,
    context: state.context,
    machine: state.machine,
    resolveSystemPromptContext: () => state.session.resolveSystemPromptContext(state.machine),
  };
}

/**
 * Fork a child runtime for a spawned sub-agent: fresh usage/turns ledger and a new
 * `address` shard, inheriting the parent's shared machine (session/store/permission/…)
 * unless an override is given. This is the single place child frames are minted — the
 * subagent, Agent, and Workflow tools all go through it.
 */
export function deriveChild<TContext>(parent: RunState<TContext>, opts: DeriveOptions): RunState<TContext> {
  const frame = opts.resumeFrame;
  return {
    ...parent,
    frameId: frame?.frameId ?? newInterruptionId("frame"),
    agentInstanceId: frame?.agentInstanceId ?? opts.agentInstanceId ?? addressTail(opts.address),
    parentFrameId: parent.frameId,
    usage: frame?.execution.usage ?? emptyUsage(),
    turns: frame?.execution.turns ?? 0,
    maxTurns: frame?.execution.maxTurns ?? parent.maxTurns,
    answers: frame ? { ...frame.decisions } : undefined,
    inputAnswers: frame?.inputAnswers,
    address: frame?.address ?? opts.address,
    currentTurnId: frame?.turnId,
    parentToolCallId: opts.parentToolCallId,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.machine ? { machine: opts.machine } : {}),
    ...(opts.steer ? { steer: opts.steer } : {}),
  };
}

/** Runs the turn-boundary injectors, appending their reminders to `context`, and returns each
 *  injector's token estimate so the context breakdown can break the framing out of `messages`. */
export function injectAtTurnBoundary<TContext>(state: RunState<TContext>, context: ConversationContext): Map<string, number> {
  const injectionTokens = new Map<string, number>();
  state.capabilities.injection.runAtTurnBoundary(
    {
      history: context.messages,
      sessionId: state.sessionId,
      address: state.address,
      originOf: (message) => context.originOf(message),
    },
    (result, injectorId) => {
      const text = systemReminder(result.text);
      const message: Message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
      injectionTokens.set(injectorId, (injectionTokens.get(injectorId) ?? 0) + estimateTokens(text));
      const origin = {
        kind: "injection" as const,
        injectorId,
        variant: result.variant ?? injectorId,
      };
      // `message.appended` fires for EVERY journaled history message (its documented
      // contract). This call site once broke that by appending without emitting; it can no
      // longer, because the journal itself broadcasts (`historyChangeEmitter`).
      context.appendMessage(message, origin);
    },
  );
  return injectionTokens;
}

// ── Pure message helpers ─────────────────────────────────────────────────────────────────

export function lastAssistant(messages: readonly Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return m;
  }
  return undefined;
}

export function finalText(messages: readonly Message[]): string {
  const assistant = lastAssistant(messages);
  if (!assistant) return "";
  return assistant.content
    .filter((p): p is import("../protocol/index.ts").TextContent => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function mapTerminalStatus(stop: TurnStopReason): RunStatus {
  switch (stop) {
    case "end_turn":
    case "max_tokens":
      return "completed";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "handoff":
    case "interrupt":
      // Unreachable: handled before this maps; kept exhaustive.
      return "error";
  }
}

export interface ParsedOutput {
  /** The parsed value; absent when the schema rejected the text (see `error`). */
  readonly value?: unknown;
  /** Set when an outputType schema was present and rejected the final text. Distinguishes
   *  "parse failed" from "no schema configured" — both used to surface as a bare
   *  `outputParsed: undefined`, with the schema's rejection reason swallowed. */
  readonly error?: string;
}

export function tryParseOutput(schema: unknown, text: string): ParsedOutput {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* not JSON — pass the raw text to the schema */
  }
  if (schema && typeof schema === "object" && "parse" in schema && typeof (schema as { parse: unknown }).parse === "function") {
    try {
      return { value: (schema as { parse: (v: unknown) => unknown }).parse(value) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { value };
}

export function addressTail(address: string): string {
  const parts = address.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "agent";
}
