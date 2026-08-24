/**
 * Per-turn toolset assembly — extracted from the Engine. Builds the active agent's tool
 * list (own tools ∪ capability tools ∪ handoff tools ∪ subagent-spawning tools) and the
 * `SubagentSpawner` seam those spawn tools share. The engine's run loop is injected as a
 * plain callback (`runAgent`), so only TYPES are imported from `runner.ts` and no
 * value-level cycle exists.
 */
import type { Tool } from "../tool/types.ts";
import type { ChatModel } from "../llm/define-model.ts";
import type { Agent } from "./agent.ts";
import type { SubagentInfo } from "./profiles.ts";
import { buildWorkflowTool } from "./workflow/tool.ts";
import { buildSubagentTool, buildAgentTool } from "./subagent-tools.ts";
import { buildSearchTool } from "../tool/search/search-tool.ts";
import { findAgentByName } from "./graph.ts";
import { deriveChild, emitRunEvent, runCtxFor } from "./run-support.ts";
import type { RunState, SubagentSpawner } from "./runner.ts";
import { toolSource } from "../capabilities/tool-provider.ts";

/** The engine call a spawner runs child agents through (`Engine.run`, injected). */
export type RunAgentFn<TContext> = SubagentSpawner<TContext>["run"];

/**
 * The execution registry stays complete so a newly loaded schema can become
 * callable on the next step without rebuilding capability connections. The
 * deferred-name set controls only the model-facing projection.
 */
export interface RunToolset {
  readonly tools: readonly Tool[];
  readonly deferredToolNames: ReadonlySet<string>;
}

export async function buildRunTools<TContext>(
  active: Agent<TContext>,
  state: RunState<TContext>,
  runAgent: RunAgentFn<TContext>,
  model: ChatModel,
): Promise<RunToolset> {
  // Capability (MCP) tools are the deferred-loading candidates. When the agent
  // opts in, they stay executable but are omitted from the model-facing schema
  // projection until a SearchTool result adds their names to the transcript.
  const rawCapTools = await state.capabilities.listTools();
  // A tagged (dynamically contributed) tool loses a name clash and says so; untagged tools are
  // trusted contributors and keep theirs. Between two tagged claimants the first one survives,
  // so a clash never makes the name vanish entirely. See `tagToolSource`.
  const untaggedNames = new Set(
    [...active.tools, ...rawCapTools.filter((tool) => toolSource(tool) === undefined)].map((tool) => tool.schema.name),
  );
  const claimed = new Set<string>();
  const capTools = rawCapTools.filter((tool) => {
    const source = toolSource(tool);
    if (source === undefined) return true;
    const name = tool.schema.name;
    if (!untaggedNames.has(name) && !claimed.has(name)) {
      claimed.add(name);
      return true;
    }
    emitRunEvent(state, {
      type: "warning",
      message: `Tool provider "${source}" tool "${name}" collides with an existing tool and was omitted.`,
    });
    return false;
  });
  const deferEnabled = active.deferTools === true && capTools.length > 0 && model.supportsDeferredTools;
  const deferredToolNames = new Set(deferEnabled ? capTools.map((tool) => tool.schema.name) : []);
  const tools: Tool[] = [...active.tools, ...capTools];
  if (deferEnabled) tools.push(buildSearchTool(capTools.map((t) => t.schema)));
  for (const h of active.handoffs) tools.push(h.asTool());
  // Subagent types come from the agent's static `subagents` plus any runtime provider
  // (e.g. profile-loaded agents). The unified "Agent" tool spawns/resumes by type.
  const providerAgents = state.subagentProvider !== undefined ? [...(await state.subagentProvider.list())] : [];
  if (active.subagents.length === 0 && providerAgents.length === 0) {
    return finish(state, tools, deferredToolNames);
  }
  // One spawner (the engine seam) shared by every subagent-spawning tool: the static
  // `agent_<name>` tools, the unified `Agent` tool, and `Workflow`.
  const spawner = makeSpawner(active, state, providerAgents, runAgent);
  for (const sub of active.subagents) tools.push(buildSubagentTool(sub, spawner, state));
  if (!tools.some((tool) => tool.schema.name === "Agent")) {
    tools.push(buildAgentTool(spawner, state));
  }
  // `workflowTool: false` withholds only this one — subagents and the `Agent`
  // tool above stay, for a host that brings its own workflow orchestration.
  if (state.workflowTool !== false && !tools.some((tool) => tool.schema.name === "Workflow")) {
    tools.push(buildWorkflowTool(spawner, state));
  }
  return finish(state, tools, deferredToolNames);
}

/**
 * Last stop before the turn: let capabilities narrow the complete registry (the extension
 * runtime's `setActiveTools` rides this). Filtering happens AFTER assembly so a filter sees
 * handoff and subagent tools too, and the deferred-name set is pruned to whatever survived.
 */
function finish<TContext>(
  state: RunState<TContext>,
  tools: readonly Tool[],
  deferredToolNames: ReadonlySet<string>,
): RunToolset {
  const filtered = state.capabilities.applyToolFilters(tools);
  if (filtered === tools) return { tools, deferredToolNames };
  const surviving = new Set(filtered.map((tool) => tool.schema.name));
  return {
    tools: filtered,
    deferredToolNames: new Set([...deferredToolNames].filter((name) => surviving.has(name))),
  };
}

/**
 * Build the `SubagentSpawner` for `active`: the available types (static subagents ∪
 * provider agents), their resolver, and the engine handles (`derive` = fork a child
 * runtime, `run` = the loop). This is what lets a tool run an agent without reaching
 * into the Runner.
 */
/** Run frames already warned about provider agents shadowed by static subagents — the
 *  toolset is rebuilt every turn, so without this the same warning would repeat per turn. */
const shadowWarned = new WeakSet<object>();

function makeSpawner<TContext>(
  active: Agent<TContext>,
  parent: RunState<TContext>,
  providerAgents: readonly SubagentInfo[],
  runAgent: RunAgentFn<TContext>,
): SubagentSpawner<TContext> {
  const subagents = active.subagents;
  // Available types = static subagents ∪ provider (profile) agents; static wins on name clash.
  const shadowed = providerAgents.filter((p) => subagents.some((sub) => sub.name === p.name));
  if (shadowed.length > 0 && !shadowWarned.has(parent)) {
    shadowWarned.add(parent);
    // Silent dedupe reads as "my profile agent just doesn't load" — say who won and why.
    emitRunEvent(parent, {
      type: "warning",
      message: `Runtime-provided subagent type(s) ${shadowed.map((p) => `"${p.name}"`).join(", ")} are shadowed by agent "${active.name}"'s static subagents of the same name; the static definitions win.`,
    });
  }
  const available: SubagentInfo[] = [
    ...subagents.map((sub) => ({ name: sub.name, description: sub.handoffDescription })),
    ...providerAgents.filter((p) => !subagents.some((sub) => sub.name === p.name)),
  ];
  const defaultType = available.find((a) => a.name === "coder")?.name ?? available[0]?.name ?? subagents[0]?.name ?? "";
  return {
    available,
    defaultType,
    // Resolve a type to an Agent: prefer the static graph, then the runtime provider.
    resolve: async (type) =>
      subagents.find((sub) => sub.name === type) ?? (await parent.subagentProvider?.get(type)),
    resolveInGraph: (root, key) => findAgentByName(root, key),
    derive: (opts) => deriveChild(parent, opts),
    run: runAgent,
    ctxFor: (childState) => runCtxFor(childState),
  };
}
