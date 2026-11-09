import { SessionProjection, readSessionTails } from "../events/projection.ts";
import { agentEventFromRecord, newAgentEventId, type AgentEvent } from "../events/index.ts";
import type { AgentRecord, SessionStore } from "../store/index.ts";
import { INTERRUPTION_STATE_KEY } from "../loop/interruption.ts";

/**
 * Close lifecycle frames abandoned by a previous executor, preserving durable pauses.
 * The host MUST establish exclusive execution ownership before calling this function.
 * It does not acquire a lease: an open turn alone is never evidence of a dead executor.
 * Repeated calls under that ownership are idempotent, including after a partial write.
 * A supplied log must be read under the same ownership and include every shard's tail.
 * Returns committed records; a raw store does not broadcast them to live observers.
 */
export async function recoverOrphanedTurns(
  sessionId: string,
  store: SessionStore,
  records?: readonly AgentRecord[],
): Promise<AgentRecord[]> {
  if (await store.getState(INTERRUPTION_STATE_KEY) !== null) return [];
  // Reuse the core checkpoint/lifecycle reducer, without history or live subscriptions.
  const frames = new SessionProjection(sessionId, { history: false });
  for (const record of records ?? await readSessionTails(store)) frames.applyRecord(record);
  const recovered: AgentRecord[] = [];
  for (const agent of frames.snapshot({ maxMessages: 0 }).agents) {
    if (agent.turn !== undefined) {
      await append(agent.address, { type: "turn.ended", turnId: agent.turn.turnId, reason: "failed" });
    }
    if (agent.live && agent.agent !== undefined) {
      await append(agent.address, { type: "agent.ended", agent: agent.agent });
    }
  }
  return recovered;

  async function append(address: string, event: Extract<AgentRecord, { type: "event.lifecycle" }>["event"]): Promise<void> {
    const record: AgentRecord = { type: "event.lifecycle", eventId: newAgentEventId(), time: Date.now(), address, event };
    await store.appendRecord(record);
    recovered.push(record);
  }
}

/** Host-facing recovery with projected events to broadcast after durable writes. Same
 * exclusive-ownership requirement as recoverOrphanedTurns; no Session needs to be opened. */
export async function closeOrphanedTurns(sessionId: string, store: SessionStore): Promise<readonly AgentEvent[]> {
  const records = await recoverOrphanedTurns(sessionId, store);
  return records.flatMap((record) => {
    const event = agentEventFromRecord(record, sessionId);
    return event === undefined ? [] : [event];
  });
}
