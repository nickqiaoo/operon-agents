/**
 * Handoff execution — extracted from the Engine's turn loop. Only TYPES are imported from
 * `runner.ts`; the loop calls `performHandoff` and continues with the returned agent/context.
 */
import { ConversationContext } from "../loop/context.ts";
import type { HandoffSignal } from "../loop/types.ts";
import { newInterruptionId } from "../loop/interruption.ts";
import type { Agent } from "./agent.ts";
import type { Handoff } from "./handoff.ts";
import { toFunctionToolName } from "./handoff.ts";
import { runInputGuardrails } from "./guardrail.ts";
import { emitRunEvent, historyChangeEmitter, runCtxFor } from "./run-support.ts";
import type { RunState } from "./runner.ts";

/**
 * Execute a handoff edge: seed a fresh root shard for the target agent, journal both
 * sides (destination first — the source-side record is the commit point for cold
 * replay), and repoint the run (`state.address`, session head) at the destination.
 * Returns the target agent and its context for the loop to continue with, or
 * `undefined` when the signal names an edge the current agent doesn't have — the
 * caller finishes the run as an error.
 */
export async function performHandoff<TContext>(
  current: Agent<TContext>,
  context: ConversationContext,
  handoff: HandoffSignal,
  state: RunState<TContext>,
): Promise<{ agent: Agent<TContext>; context: ConversationContext } | undefined> {
  const messages = context.messages;
  const edge = current.handoffs.find((h: Handoff<TContext>) => h.toolName === handoff.toolName);
  if (!edge) {
    emitRunEvent(state, { type: "warning", message: `Unknown handoff target "${handoff.toolName}".` });
    return undefined;
  }
  // The tool framework already validated these args against the handoff's schema
  // (`inputType`, or the default `{ reason }`), so hand them to onHandoff as-is.
  // runCtxFor is called before the address repoint below, so onHandoff sees the source address.
  if (edge.onHandoff) await edge.onHandoff(runCtxFor(state), handoff.args);
  const filtered = edge.inputFilter ? edge.inputFilter({ history: messages }) : { history: messages };
  const handoffId = newInterruptionId("handoff");
  const fromAddress = state.address;
  const toAddress = handoffRootAddress(edge.target.name, handoffId);
  const seeded = structuredClone([...filtered.history]);
  const targetContext = new ConversationContext({
    store: state.store,
    address: toAddress,
    ...(state.store === undefined
      ? { onHistoryChange: historyChangeEmitter(state.events, state.sessionId) }
      : {}),
  });

  // Prepare and flush the destination first. The source-side handoff record below is the
  // commit point: a crash before it leaves only an unreachable orphan shard; a crash after
  // it always finds a fully initialized destination during cold replay.
  targetContext.record({
    type: "agent.handoff.accepted",
    handoffId,
    from: current.name,
    to: edge.target.name,
    fromAddress,
    seedCount: seeded.length,
  });
  for (const message of seeded) {
    targetContext.appendMessage(message, { kind: "handoff_seed", handoffId, fromAddress });
  }
  await targetContext.flush();
  await state.store?.flush?.();

  context.record({
    type: "agent.handoff",
    from: current.name,
    to: edge.target.name,
    handoffId,
    toAddress,
    seedCount: seeded.length,
  });
  await context.flush();
  await state.store?.flush?.();
  if (state.store === undefined) {
    emitRunEvent(state, {
      type: "agent.handoff",
      from: current.name,
      to: edge.target.name,
      handoffId,
      fromAddress,
      toAddress,
    });
  }
  state.session.setLiveContext(toAddress, targetContext);
  state.session.setConversationHead({ agentKey: edge.target.name, address: toAddress });
  state.address = toAddress;
  await runInputGuardrails(edge.target.guardrails.input ?? [], {
    agent: edge.target,
    input: targetContext.messages,
    context: runCtxFor(state),
  });
  emitRunEvent(state, { type: "agent.started", agent: edge.target.name, ...(state.parentToolCallId ? { parentToolCallId: state.parentToolCallId } : {}) });
  return { agent: edge.target, context: targetContext };
}

/** Handoff destinations are new top-level shards; `/` remains reserved for spawned children. */
function handoffRootAddress(agentName: string, handoffId: string): string {
  const suffix = handoffId.startsWith("handoff_") ? handoffId.slice("handoff_".length) : handoffId;
  const slug = toFunctionToolName(agentName).slice(0, 64);
  return `h_${slug}_${suffix}`;
}
