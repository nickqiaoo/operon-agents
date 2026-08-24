import { createHash, randomBytes } from "node:crypto";
import type { ApprovalResponse } from "../permission/types.ts";
import type { AssistantMessage, Message, ToolCall, Usage } from "../protocol/index.ts";
import type { ToolInputRequest } from "../tool/types.ts";
import type { PendingInterrupt } from "./types.ts";

export const INTERRUPTION_STATE_KEY = "interrupt" as const;
export const INTERRUPTION_STATE_VERSION = 1 as const;

/** Stable identity of an agent definition. Instance identity lives on the frame. */
export interface AgentDefinitionReference {
  readonly key: string;
  readonly name: string;
}

/** Locates and validates the assistant batch whose execution is being continued. */
export interface InterruptionAnchor {
  readonly toolCallId: string;
  readonly assistantDigest: string;
}

export interface InterruptionExecution {
  readonly turns: number;
  readonly maxTurns: number;
  readonly usage: Usage;
}

export interface InterruptionFrame {
  readonly frameId: string;
  readonly agentInstanceId: string;
  readonly address: string;
  readonly agent: AgentDefinitionReference;
  readonly turnId: string;
  readonly execution: InterruptionExecution;
  readonly anchor: InterruptionAnchor;
  readonly pending: readonly PendingInterrupt[];
  /** Approval answers, replayed through the authorize hook on every re-run of the batch. */
  readonly decisions: Readonly<Record<string, ApprovalResponse>>;
  /** Input answers for suspended tool calls (toolCallId → data). One-shot: consumed by the
   *  re-run; dropped when the same call suspends again. */
  readonly inputAnswers?: Readonly<Record<string, unknown>>;
  /** Parent toolCallId -> child frameId. */
  readonly children: Readonly<Record<string, string>>;
}

/** A caller's answer to one pending interrupt, routed by `kind` to the matching pending entry. */
export type InterruptAnswer =
  | ({ readonly kind: "approval" } & ApprovalResponse)
  | { readonly kind: "input"; readonly data: unknown };

/**
 * Lifecycle of a persisted interruption: `waiting` (paused, answers pending) →
 * `resuming` (a resume is executing) → back to `waiting` on the next pause, or deleted on
 * a terminal result. `recovery_required` is stamped when a resume THREW mid-flight — it is
 * not a dead end: `applyInterruptionAnswers` unconditionally returns `phase: "resuming"`,
 * so the exit is simply to re-read the persisted state (its `revision` was bumped along
 * with the phase) and call `Runner.resume` with it again. Callers holding a pre-crash
 * copy get a "stale interruption state" error — that error is the re-fetch signal.
 */
export type InterruptionPhase = "waiting" | "resuming" | "recovery_required";

/**
 * Bounded control state for a paused foreground agent tree. Conversation data remains in
 * the per-address append logs and is reconstructed with replayContext.
 */
export interface InterruptionState {
  readonly version: typeof INTERRUPTION_STATE_VERSION;
  readonly runId: string;
  readonly interruptionId: string;
  readonly phase: InterruptionPhase;
  readonly revision: number;
  readonly rootFrameId: string;
  readonly frames: Readonly<Record<string, InterruptionFrame>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Pending interrupt surfaced to callers (internal continuation state stripped).
 *  approvalId stays unique across parallel agent frames. */
export type PendingRunInterrupt = PendingInterrupt & {
  readonly approvalId: string;
  readonly frameId: string;
  readonly address: string;
  readonly agent: AgentDefinitionReference;
};

/** A child Agent tool call that reached a durable foreground interruption. */
export interface ToolCallSuspension {
  readonly toolCallId: string;
  readonly state: InterruptionState;
}

export function newInterruptionId(prefix: "run" | "interrupt" | "frame" | "agent" | "handoff" = "interrupt"): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

export function interruptionAnchor(message: AssistantMessage, preferredToolCallId?: string): InterruptionAnchor {
  const calls = assistantToolCalls(message);
  if (calls.length === 0) throw new Error("Cannot interrupt: assistant message contains no tool calls.");
  const toolCallId = preferredToolCallId ?? calls[0]!.id;
  if (!calls.some((call) => call.id === toolCallId)) {
    throw new Error(`Cannot interrupt: tool call "${toolCallId}" is not present in the assistant batch.`);
  }
  return { toolCallId, assistantDigest: digestAssistantToolCalls(message) };
}

export function digestAssistantToolCalls(message: AssistantMessage): string {
  const canonical = stableStringify(
    assistantToolCalls(message).map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** Finds the exact assistant batch in a replayed shard and rejects stale/mismatched logs. */
export function findAnchoredAssistant(messages: readonly Message[], anchor: InterruptionAnchor): AssistantMessage {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (!assistantToolCalls(message).some((call) => call.id === anchor.toolCallId)) continue;
    const digest = digestAssistantToolCalls(message);
    if (digest !== anchor.assistantDigest) {
      throw new Error(
        `Cannot resume: assistant batch for tool call "${anchor.toolCallId}" changed (digest mismatch).`,
      );
    }
    return message;
  }
  throw new Error(`Cannot resume: tool call "${anchor.toolCallId}" was not found in the replayed log.`);
}

export function parseInterruptionState(raw: unknown): InterruptionState {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!isRecord(value) || value.version !== INTERRUPTION_STATE_VERSION) {
    const version = isRecord(value) ? String(value.version) : "missing";
    throw new Error(
      `Unsupported interruption state version ${version} (expected ${INTERRUPTION_STATE_VERSION}).`,
    );
  }
  if (
    typeof value.runId !== "string" ||
    typeof value.interruptionId !== "string" ||
    typeof value.rootFrameId !== "string" ||
    typeof value.revision !== "number" ||
    !isRecord(value.frames) ||
    !isRecord(value.frames[value.rootFrameId])
  ) {
    throw new Error("Invalid interruption state: missing run, root frame, revision, or frame table.");
  }
  if (value.phase !== "waiting" && value.phase !== "resuming" && value.phase !== "recovery_required") {
    throw new Error(`Invalid interruption state phase "${String(value.phase)}".`);
  }
  return value as unknown as InterruptionState;
}

export function flattenPendingInterrupts(state: InterruptionState): PendingRunInterrupt[] {
  const out: PendingRunInterrupt[] = [];
  const visit = (frameId: string): void => {
    const frame = state.frames[frameId];
    if (!frame) throw new Error(`Invalid interruption state: frame "${frameId}" is missing.`);
    for (const pending of frame.pending) {
      // The tool's continuation state is private to the frame — never surfaced to callers.
      const publicPending = pending.kind === "input" ? (({ state: _state, ...rest }) => rest)(pending) : pending;
      out.push({
        ...publicPending,
        approvalId: approvalId(frame.frameId, pending.toolCallId),
        frameId: frame.frameId,
        address: frame.address,
        agent: frame.agent,
      });
    }
    for (const childId of Object.values(frame.children)) visit(childId);
  };
  visit(state.rootFrameId);
  return out;
}

/**
 * Merge caller answers into their owning frames — approval answers into `decisions`,
 * input answers into `inputAnswers`, each validated against its pending entry's kind.
 * Composite approvalId is authoritative; a raw toolCallId remains accepted when it is
 * unambiguous in the paused tree.
 */
export function applyInterruptionAnswers(
  state: InterruptionState,
  answers: Readonly<Record<string, InterruptAnswer>>,
): InterruptionState {
  const pending = flattenPendingInterrupts(state);
  const byApprovalId = new Map(pending.map((item) => [item.approvalId, item]));
  const byToolCallId = new Map<string, PendingRunInterrupt[]>();
  for (const item of pending) {
    const group = byToolCallId.get(item.toolCallId) ?? [];
    group.push(item);
    byToolCallId.set(item.toolCallId, group);
  }

  const decisionAdditions = new Map<string, Record<string, ApprovalResponse>>();
  const inputAdditions = new Map<string, Record<string, unknown>>();
  for (const [key, answer] of Object.entries(answers)) {
    let target = byApprovalId.get(key);
    if (!target) {
      const matches = byToolCallId.get(key) ?? [];
      if (matches.length > 1) {
        throw new Error(`Answer key "${key}" is ambiguous across agent frames; use approvalId instead.`);
      }
      target = matches[0];
    }
    if (!target) throw new Error(`Answer key "${key}" is not pending on interruption "${state.interruptionId}".`);
    if (answer.kind !== target.kind) {
      throw new Error(
        `Answer for "${key}" has kind "${answer.kind}" but the pending interrupt expects "${target.kind}".`,
      );
    }
    if (answer.kind === "input") {
      const frameAnswers = inputAdditions.get(target.frameId) ?? {};
      frameAnswers[target.toolCallId] = answer.data;
      inputAdditions.set(target.frameId, frameAnswers);
    } else {
      const { kind: _kind, ...response } = answer;
      const frameAnswers = decisionAdditions.get(target.frameId) ?? {};
      frameAnswers[target.toolCallId] = response;
      decisionAdditions.set(target.frameId, frameAnswers);
    }
  }

  const frames: Record<string, InterruptionFrame> = {};
  for (const [frameId, frame] of Object.entries(state.frames)) {
    frames[frameId] = {
      ...frame,
      decisions: { ...frame.decisions, ...(decisionAdditions.get(frameId) ?? {}) },
      inputAnswers: { ...(frame.inputAnswers ?? {}), ...(inputAdditions.get(frameId) ?? {}) },
    };
  }
  const now = Date.now();
  return { ...state, phase: "resuming", revision: state.revision + 1, frames, updatedAt: now };
}

export function approvalId(frameId: string, toolCallId: string): string {
  return `${frameId}:${toolCallId}`;
}

/**
 * Internal-only unwind thrown by `ToolRunContext.suspend`: a tool suspending itself
 * mid-execution with a user-facing `request` and a private continuation `state`.
 * Caught by the tool-call layer and reified into a `PendingInputInterrupt`.
 */
export class ToolSuspendSignal extends Error {
  readonly request: ToolInputRequest;
  readonly state?: unknown;

  constructor(request: ToolInputRequest, state?: unknown) {
    super("Tool suspended awaiting caller input.");
    this.name = "ToolSuspendSignal";
    this.request = request;
    this.state = state;
  }
}

export function isToolSuspendSignal(value: unknown): value is ToolSuspendSignal {
  return value instanceof ToolSuspendSignal;
}

/** Internal-only structured unwind from an Agent tool into the parent tool batch. */
export class ToolInterruptionSignal extends Error {
  readonly state: InterruptionState;

  constructor(state: InterruptionState) {
    super("Foreground sub-agent interrupted.");
    this.name = "ToolInterruptionSignal";
    this.state = state;
  }
}

export function isToolInterruptionSignal(value: unknown): value is ToolInterruptionSignal {
  return value instanceof ToolInterruptionSignal;
}

const interruptionStateSymbol = Symbol("operon.interruptionState");

export function attachInterruptionState<T extends object>(result: T, state: InterruptionState): T {
  Object.defineProperty(result, interruptionStateSymbol, { value: state, enumerable: false });
  return result;
}

export function getInterruptionState(result: object): InterruptionState | undefined {
  return (result as { [interruptionStateSymbol]?: InterruptionState })[interruptionStateSymbol];
}

function assistantToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
