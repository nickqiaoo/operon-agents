/**
 * Durable pause — reify a paused run into `InterruptionState` and publish it. Extracted
 * from the Engine's turn loop; the live-responder approval path stays in the loop (it
 * continues in memory and never reifies). Only TYPES are imported from `runner.ts`.
 */
import type { AssistantMessage } from "../protocol/index.ts";
import type { PendingInterrupt } from "../loop/types.ts";
import type { ConversationContext } from "../loop/context.ts";
import {
  INTERRUPTION_STATE_KEY,
  INTERRUPTION_STATE_VERSION,
  attachInterruptionState,
  flattenPendingInterrupts,
  interruptionAnchor,
  newInterruptionId,
  type InterruptionFrame,
  type InterruptionState,
  type ToolCallSuspension,
} from "../loop/interruption.ts";
import type { Agent } from "./agent.ts";
import { emitRunEvent, finalText, lastAssistant } from "./run-support.ts";
import type { RunResult, RunState } from "./runner.ts";

/**
 * Take the run durable: flush the shard, reify the paused frame tree, persist it (root
 * frame only — child frames bubble structurally to their spawning Agent tool and are
 * merged by the parent), and build the `interrupted` RunResult carrying the control tree.
 */
export async function pauseRun<TContext>(
  active: Agent<TContext>,
  context: ConversationContext,
  pending: readonly PendingInterrupt[],
  suspensions: readonly ToolCallSuspension[],
  state: RunState<TContext>,
  turnId: string,
): Promise<RunResult> {
  const messages = context.messages;
  // The assistant message holding the paused calls and any completed parallel sibling
  // results are already in the log. Flush every shard before publishing the control tree.
  await context.flush();
  const assistant = lastAssistant(messages);
  if (!assistant) throw new Error("Cannot interrupt: current shard has no assistant message.");
  const interruption = reify(active, assistant, pending, suspensions, state, turnId);
  state.interruption = interruption;
  const publicPending = flattenPendingInterrupts(interruption);
  // Only the root owns the session-scoped KV key. Child frames bubble structurally to
  // their spawning Agent tool and are merged by the parent frame.
  if (state.parentFrameId === undefined && state.store) {
    await state.store.putState(INTERRUPTION_STATE_KEY, interruption);
  }
  emitRunEvent(state, { type: "turn.paused", pending: publicPending });
  const result: RunResult = {
    status: "interrupted",
    finalAgent: active.name,
    activeAddress: state.address,
    output: finalText(messages),
    // Snapshot — RunResult.messages must not alias the live context array (see Engine.finish).
    messages: [...messages],
    usage: state.usage,
    interruption: {
      id: interruption.interruptionId,
      revision: interruption.revision,
      pending: publicPending,
    },
    interruptions: publicPending,
  };
  return attachInterruptionState(result, interruption);
}

function reify<TContext>(
  active: Agent<TContext>,
  assistant: AssistantMessage,
  pending: readonly PendingInterrupt[],
  suspensions: readonly ToolCallSuspension[],
  state: RunState<TContext>,
  turnId: string,
): InterruptionState {
  const preferredToolCallId = pending[0]?.toolCallId ?? suspensions[0]?.toolCallId;
  const children: Record<string, string> = {};
  const frames: Record<string, InterruptionFrame> = {};
  for (const suspension of suspensions) {
    children[suspension.toolCallId] = suspension.state.rootFrameId;
    Object.assign(frames, suspension.state.frames);
  }
  // Input answers are one-shot: a call that suspended AGAIN after consuming its answer
  // must not see the stale answer on the next resume — drop answers for re-suspended
  // calls. Re-parked (never-answered) entries had no answer, so this is a no-op for them.
  const pendingInputIds = new Set(pending.filter((p) => p.kind === "input").map((p) => p.toolCallId));
  const inputAnswers = Object.fromEntries(
    Object.entries(state.inputAnswers ?? {}).filter(([toolCallId]) => !pendingInputIds.has(toolCallId)),
  );
  frames[state.frameId] = {
    frameId: state.frameId,
    agentInstanceId: state.agentInstanceId,
    address: state.address,
    agent: { key: active.name, name: active.name },
    turnId,
    execution: { turns: state.turns, maxTurns: state.maxTurns, usage: state.usage },
    anchor: interruptionAnchor(assistant, preferredToolCallId),
    pending,
    decisions: { ...(state.answers ?? {}) },
    ...(Object.keys(inputAnswers).length > 0 ? { inputAnswers } : {}),
    children,
  };
  const previous = state.interruption;
  const now = Date.now();
  return {
    version: INTERRUPTION_STATE_VERSION,
    runId: state.runId,
    interruptionId: newInterruptionId("interrupt"),
    phase: "waiting",
    revision: (previous?.revision ?? 0) + 1,
    rootFrameId: state.frameId,
    frames,
    createdAt: now,
    updatedAt: now,
  };
}
