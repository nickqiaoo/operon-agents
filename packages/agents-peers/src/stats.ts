/**
 * What the fleet is costing, and the ceiling on it.
 *
 * Two problems this answers, which are really one:
 *
 * - **Observability.** A host running a team of agents otherwise has no aggregate view — each
 *   session reports its own usage and nobody sums them. Peer coordination makes that worse: one
 *   message can wake an idle teammate and start a turn, so cost accrues without anyone prompting.
 * - **A ceiling.** `maxTurns` bounds a single agent. It cannot stop ten agents each burning their
 *   own budget, and it cannot see that they kept waking each other to do it.
 *
 * Deliberately NOT a cap on conversation length: a long peer exchange is normal collaboration.
 * What is bounded is the total spend, which is the thing that actually hurts.
 *
 * SPLIT: turning `usage.updated` running totals into increments (`UsageDiff`) stays in the
 * extension — an agent's events only ever arrive in the process hosting it, so per-process
 * diffing is correct by construction. The store only ever receives deltas, and `add` is an atomic
 * accumulate — every backend has a native primitive for that (memory `+=`, SQL `SET x = x + ?`,
 * Redis `HINCRBY`), so no backend ever needs read-modify-write.
 */
import type { Usage } from "operon-agents-core";

export interface PeerCounters {
  readonly messagesSent: number;
  readonly messagesReceived: number;
  /** Deliveries that started a turn on an idle or parked recipient — the expensive kind. */
  readonly wakes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface PeerAgentStats extends PeerCounters {
  readonly agentId: string;
}

export interface PeerFleetStats {
  readonly agents: readonly PeerAgentStats[];
  readonly totals: PeerCounters;
}

/** Spend ceiling for the whole network. Reaching it stops PEER traffic — it cannot and does not
 *  stop an agent already running from finishing its own work. */
export interface PeerBudget {
  readonly maxTotalTokens?: number;
  readonly maxTotalCost?: number;
  /** Deliveries that start a turn on an idle/parked recipient. The sharpest lever: each one is a
   *  fresh LLM call nobody explicitly asked for. */
  readonly maxWakes?: number;
}

export interface PeerStatsStore {
  /** Atomic accumulate. Missing fields mean +0. */
  add(agentId: string, delta: Partial<PeerCounters>): Promise<void>;
  snapshot(): Promise<PeerFleetStats>;
}

export function emptyCounters(): PeerCounters {
  return { messagesSent: 0, messagesReceived: 0, wakes: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
}

function accumulate(base: PeerCounters, delta: Partial<PeerCounters>): PeerCounters {
  return {
    messagesSent: base.messagesSent + (delta.messagesSent ?? 0),
    messagesReceived: base.messagesReceived + (delta.messagesReceived ?? 0),
    wakes: base.wakes + (delta.wakes ?? 0),
    inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
    totalTokens: base.totalTokens + (delta.totalTokens ?? 0),
    cost: base.cost + (delta.cost ?? 0),
  };
}

/**
 * The default: per-process counters, gone on restart — and that is the right default, because a
 * persisted budget forces a question this package cannot answer for the host: WHEN does the
 * budget reset? (A durable ledger that never resets bricks the network on its first exhaustion —
 * every restart wakes up already over quota.) A host that wants a fleet ledger spanning restarts
 * implements this facet on its own store and owns the reset semantics with it.
 */
export class MemoryPeerStatsStore implements PeerStatsStore {
  private readonly perAgent = new Map<string, PeerCounters>();

  async add(agentId: string, delta: Partial<PeerCounters>): Promise<void> {
    this.perAgent.set(agentId, accumulate(this.perAgent.get(agentId) ?? emptyCounters(), delta));
  }

  async snapshot(): Promise<PeerFleetStats> {
    const agents = [...this.perAgent.entries()].map(([agentId, counters]) => ({ agentId, ...counters }));
    const totals = agents.reduce<PeerCounters>((acc, a) => accumulate(acc, a), emptyCounters());
    return { agents, totals };
  }
}

/**
 * Turns `usage.updated` events into increments. The event carries the reporting run's RUNNING
 * TOTAL, so summing raw events would count the same tokens many times over — we diff against the
 * last value seen.
 *
 * Keyed by AGENT, not by frame address: every session's root frame is `main`, so an address-keyed
 * map would have one session's totals subtracted from another's.
 */
export class UsageDiff {
  private readonly lastUsage = new Map<string, PeerCounters>();

  delta(agentId: string, usage: Usage): Partial<PeerCounters> {
    const current: PeerCounters = {
      ...emptyCounters(),
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.totalTokens ?? usage.input + usage.output,
      cost: usage.cost?.total ?? 0,
    };
    // A total that went DOWN means a fresh run started counting from zero, so there is no
    // previous value to diff against — usage is monotonic within a run, never across them.
    const last = this.lastUsage.get(agentId);
    const previous = last === undefined || current.totalTokens < last.totalTokens ? emptyCounters() : last;
    this.lastUsage.set(agentId, current);
    return {
      inputTokens: current.inputTokens - previous.inputTokens,
      outputTokens: current.outputTokens - previous.outputTokens,
      totalTokens: current.totalTokens - previous.totalTokens,
      cost: current.cost - previous.cost,
    };
  }
}

/** The budget line this snapshot has crossed, if any. */
export function budgetExceeded(stats: PeerFleetStats, budget: PeerBudget | undefined): string | undefined {
  if (budget === undefined) return undefined;
  const { totals } = stats;
  if (budget.maxTotalTokens !== undefined && totals.totalTokens >= budget.maxTotalTokens) {
    return `fleet token budget reached (${totals.totalTokens}/${budget.maxTotalTokens})`;
  }
  if (budget.maxTotalCost !== undefined && totals.cost >= budget.maxTotalCost) {
    return `fleet cost budget reached (${totals.cost.toFixed(4)}/${budget.maxTotalCost})`;
  }
  if (budget.maxWakes !== undefined && totals.wakes >= budget.maxWakes) {
    return `fleet wake budget reached (${totals.wakes}/${budget.maxWakes})`;
  }
  return undefined;
}
