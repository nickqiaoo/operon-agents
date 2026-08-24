/**
 * Agent-graph resolution + validation helpers, shared by the Runner (run()/resume()
 * boundary checks, conversation-head resolution) and the toolset's spawner
 * (resolveInGraph). Pure functions over the `Agent` graph — no runtime state.
 */
import { Agent } from "./agent.ts";
import { toFunctionToolName } from "./handoff.ts";

/**
 * Fail a malformed graph at the run()/resume() boundary — before any turn executes or records
 * commit — rather than mid-conversation when the offending agent finally becomes active. Walks
 * by object identity, not name: distinct same-named agents in different corners of the graph are
 * legal, and each one still gets validated.
 */
export function assertGraphUnambiguous<TContext>(root: Agent<TContext>): void {
  const seen = new Set<Agent<TContext>>();
  const queue: Agent<TContext>[] = [root];
  while (queue.length > 0) {
    const agent = queue.shift()!;
    if (seen.has(agent)) continue;
    seen.add(agent);
    assertUnambiguousEdges(agent);
    for (const h of agent.handoffs) queue.push(h.target);
    for (const s of agent.subagents) queue.push(s);
  }
}

/**
 * An agent's edges are addressed by name at two seams — tool names the model calls
 * (`transfer_to_<x>`, `agent_<slug>`) and durable handoff records resolved on resume — so within
 * one agent each name must map to a single target. Not checked in the Agent constructor: cyclic
 * graphs are built by pushing into `handoffs` after both agents exist, so the constructor never
 * sees the final lists. Runs only at the run()/resume() boundary (via `assertGraphUnambiguous`);
 * agents that enter the graph later — provider-loaded subagents, post-run() edge mutation — are
 * the caller's responsibility (name clashes with static subagents already dedupe, static wins).
 */
export function assertUnambiguousEdges<TContext>(agent: Agent<TContext>): void {
  const toolNames = new Set<string>();
  const targetsByName = new Map<string, Agent<TContext>>();
  for (const h of agent.handoffs) {
    if (toolNames.has(h.toolName)) {
      throw new Error(`Agent "${agent.name}" has multiple handoff tools named "${h.toolName}".`);
    }
    toolNames.add(h.toolName);
    const prior = targetsByName.get(h.target.name);
    if (prior !== undefined && prior !== h.target) {
      throw new Error(
        `Agent "${agent.name}" has handoffs to two different agents both named "${h.target.name}"; handoff target names must be unique per agent.`,
      );
    }
    targetsByName.set(h.target.name, h.target);
  }
  const subagentSlugs = new Map<string, string>();
  for (const sub of agent.subagents) {
    const slug = toFunctionToolName(sub.name);
    const prior = subagentSlugs.get(slug);
    if (prior !== undefined) {
      throw new Error(
        `Agent "${agent.name}" has subagents "${prior}" and "${sub.name}" that share the tool name "agent_${slug}"; subagent names must be unique per agent.`,
      );
    }
    subagentSlugs.set(slug, sub.name);
  }
}

/** Durable state (conversation head, interruption frames) stores agent NAMES, so resume-time
 *  resolution is by name — and a graph with two distinct same-named agents (legal, see
 *  {@link assertGraphUnambiguous}) cannot be resolved safely that way. Thrown instead of
 *  guessing: binding whichever BFS found first would silently hand the conversation to the
 *  wrong agent. */
export class AmbiguousAgentNameError extends Error {
  readonly agentName: string;
  constructor(name: string, count: number) {
    super(
      `Agent name "${name}" is ambiguous: ${String(count)} distinct agents in the graph share it. ` +
        `Durable state stores agents by name, so resume/head resolution cannot tell them apart — give agents unique names.`,
    );
    this.name = "AmbiguousAgentNameError";
    this.agentName = name;
  }
}

/** Names shared by ≥2 distinct agent objects in the graph. Such a graph builds and runs
 *  live fine (edges resolve by object), but durable name-keyed resolution (resume,
 *  interruption frames) fails closed on those names — surfaced as a run-boundary warning
 *  so users hear about it before an {@link AmbiguousAgentNameError} interrupts a resume. */
export function duplicateAgentNames<TContext>(root: Agent<TContext>): string[] {
  const seen = new Set<Agent<TContext>>();
  const counts = new Map<string, number>();
  const queue: Agent<TContext>[] = [root];
  while (queue.length > 0) {
    const agent = queue.shift()!;
    if (seen.has(agent)) continue;
    seen.add(agent);
    counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
    for (const h of agent.handoffs) queue.push(h.target);
    for (const s of agent.subagents) queue.push(s);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

/** Every distinct agent OBJECT in the graph named `name`. Visits by object identity — a
 *  name-keyed visited set would prune the subtree behind a same-named duplicate, hiding
 *  agents reachable only through it. */
export function findAgentsByName<TContext>(root: Agent<TContext>, name: string): Agent<TContext>[] {
  const seen = new Set<Agent<TContext>>();
  const matches: Agent<TContext>[] = [];
  const queue: Agent<TContext>[] = [root];
  while (queue.length > 0) {
    const agent = queue.shift()!;
    if (seen.has(agent)) continue;
    seen.add(agent);
    if (agent.name === name) matches.push(agent);
    for (const h of agent.handoffs) queue.push(h.target);
    for (const s of agent.subagents) queue.push(s);
  }
  return matches;
}

/** Resolve `name` to THE agent it denotes: `undefined` when absent, the agent when unique,
 *  and a thrown {@link AmbiguousAgentNameError} when several distinct agents share the name
 *  (fail-closed — see the error's doc). Callers that can resolve ambiguity another way
 *  (the Runner's cold head walk resolves along committed handoff edges) should catch it or
 *  use {@link findAgentsByName} directly. */
export function findAgentByName<TContext>(root: Agent<TContext>, name: string): Agent<TContext> | undefined {
  const matches = findAgentsByName(root, name);
  if (matches.length > 1) throw new AmbiguousAgentNameError(name, matches.length);
  return matches[0];
}
