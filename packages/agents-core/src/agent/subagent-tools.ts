/**
 * The subagent-spawning tools — extracted from the Engine so all three spawn tools
 * (`agent_<name>`, the unified `Agent`, and `Workflow`) live outside the Runner and share
 * the same seam: the `SubagentSpawner` (resolve/derive/run/ctxFor) + the parent `RunState`.
 *
 * Neither tool reaches into the Engine: they run a sub-agent by forking a child frame
 * (`spawner.derive`) and calling `spawner.run` (which IS `Engine.run`). Only TYPES are
 * imported from `../runner.ts`, so there is no value-level import cycle (mirrors
 * `workflow/tool.ts`).
 */
import { z } from "zod";
import type { Message, Usage } from "../protocol/index.ts";
import { addUsage, subtractUsage } from "../loop/usage.ts";
import { ConversationContext, replayContext } from "../loop/context.ts";
import { historyChangeEmitter } from "./run-support.ts";
import { SteerBus } from "../loop/steer.ts";
import {
  ToolInterruptionSignal,
  findAnchoredAssistant,
  getInterruptionState,
  type InterruptionFrame,
} from "../loop/interruption.ts";
import { defineTool } from "../tool/define.ts";
import { ToolAccesses } from "../tool/access.ts";
import type { Tool, ToolResult } from "../tool/types.ts";
import { joinAddress } from "../events/index.ts";
import { AgentBackgroundTask } from "../capabilities/background/agent-task.ts";
import { asTaskRegistrar } from "../capabilities/background/registrar.ts";
import type { SessionStore } from "../store/index.ts";
import type { Agent } from "./agent.ts";
import { isGuardrailTripwireError, runInputGuardrails } from "./guardrail.ts";
import { toFunctionToolName } from "./handoff.ts";
import {
  SUBAGENT_META,
  type AgentSpawnDetails,
  type SubagentMeta,
  type SubagentStatus,
  invalidAgentName,
  newAgentId,
  readSubagentMeta,
} from "./subagent.ts";
import type { RunResult, RunState, RunStatus, SubagentSpawner } from "./runner.ts";
import { spawnLimiterFor } from "./concurrency.ts";

/**
 * The `agent_<name>` tool for a STATIC sub-agent on the active agent's graph. A thin
 * delegation: seed the sub-agent with the prompt, run it to completion in its own shard,
 * fold its usage back into the parent, and return its final text.
 */
export function buildSubagentTool<TContext>(
  sub: Agent<TContext>,
  spawner: SubagentSpawner<TContext>,
  parent: RunState<TContext>,
): Tool {
  const toolName = `agent_${toFunctionToolName(sub.name)}`;
  return defineTool({
    name: toolName,
    description: sub.handoffDescription ?? `Delegate a sub-task to the ${sub.name} sub-agent and return its result.`,
    params: z.object({ input: z.string().describe(`The task or prompt for the ${sub.name} sub-agent.`) }),
    resolve: (args) => ({
      approvalRule: toolName,
      // Conservative: a sub-agent can do anything, so serialize it against everything.
      accesses: ToolAccesses.all(),
      // Delegation is control flow — the sub-agent's OWN tools are permission-checked.
      controlFlow: true,
      display: { title: `Sub-agent: ${sub.name}`, detail: args.input },
      run: async (ctx) => {
        const continuation = childContinuation(parent, ctx.toolCallId);
        if (continuation) {
          const result = await resumeInterruptedChild(sub, continuation, spawner, parent, ctx.toolCallId, parent.signal);
          settleChild(parent, result, continuation.execution.usage);
          return subagentResult(sub.name, result.output, result.usage, result.status, continuation.agentInstanceId);
        }
        // Per-instance shard, same scheme as the unified Agent tool. A fixed
        // `<parent>/<sub.name>` address would make repeated calls to the same static
        // sub-agent append their seeds to one shared shard — live runs look fine (each
        // seeds a fresh in-memory context) but replay/interruption-resume would reduce
        // the mixed log into one polluted transcript.
        const agentId = newAgentId(sub.name);
        const address = joinAddress(parent.address, agentId);
        // Meta record (as the Agent tool writes at spawn) so the shard is resumable by id.
        if (parent.store !== undefined) {
          await parent.store.appendRecord({
            address,
            type: "custom",
            name: SUBAGENT_META,
            data: {
              agentId,
              type: sub.name,
              background: false,
              parentAddress: parent.address,
              parentToolCallId: ctx.toolCallId,
            } satisfies SubagentMeta,
          });
        }
        const result = await runFreshChild(sub, spawner, parent, {
          address,
          agentInstanceId: agentId,
          prompt: args.input,
          parentToolCallId: ctx.toolCallId,
        });
        settleChild(parent, result);
        return subagentResult(sub.name, result.output, result.usage, result.status, agentId);
      },
    }),
  });
}

/**
 * Build the `agent_<name>` tool's result from a finished child run. Unlike `spawnResult`
 * (the unified `Agent` tool's registry row, which never sets `isError`), this is the ONLY
 * result the parent model sees for this delegation — so an abnormal terminal status (the
 * child errored or was aborted) must set `isError`, or the parent reads a failed/empty
 * child run as a normal success.
 */
function subagentResult(name: string, output: string, usage: Usage, status: RunStatus, agentId?: string): ToolResult {
  const isError = status === "error" || status === "aborted";
  const text = status === "completed" ? output : [`status: ${status}`, "", output].join("\n");
  return {
    content: [{ type: "text", text }],
    details: { agent: name, usage, status, ...(agentId !== undefined ? { agentId } : {}) },
    ...(isError ? { isError } : {}),
  };
}

/**
 * The unified `Agent` tool: spawn (or resume) a sub-agent BY TYPE, optionally in the
 * background. Types come from the active agent's static `subagents` ∪ the runtime provider,
 * surfaced through the `spawner`.
 */
export function buildAgentTool<TContext>(
  spawner: SubagentSpawner<TContext>,
  parent: RunState<TContext>,
): Tool {
  const defaultName = spawner.defaultType;
  const backgroundAvailable = asTaskRegistrar(parent.background) !== undefined && parent.store !== undefined;
  const backgroundNote = backgroundAvailable
    ? "When run_in_background=true, the subagent runs detached from this turn. A metadata-only completion notice arrives automatically; call BackgroundOutput(task_id) when you need the result. You do not need to poll or sleep. Continue with other work. Never fabricate or predict what the result will say."
    : "Background execution requires both a BackgroundManager and a durable session store. Do not set run_in_background=true in this session.";
  const description = [
    "Launch a subagent to handle a task. The subagent runs as a same-session loop instance with its own context and journal shard.",
    "",
    "Writing the prompt:",
    "- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.",
    "- Lookups (read this file, run that test): put the exact path or command in the prompt — the subagent should not have to search for what you already know.",
    "- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.",
    "- Do not delegate understanding: if the task hinges on a file path or line number, find it yourself first and write it into the prompt.",
    "",
    "Usage notes:",
    "- Pass `name` when you will refer to this subagent later — resuming it, or naming it to a teammate. `name` becomes its agent id, so Agent(resume=\"dba\") beats resuming an opaque generated id. Names must be unique within this session.",
    "- When the task continues earlier work a subagent already did, prefer resuming it (pass its agent_id via resume) over spawning a fresh instance — the resumed agent keeps its prior context. Requires a durable session store.",
    "- A subagent's result is only visible to you, not the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself.",
    "- Subagents use a fixed 30-minute timeout. If one times out, resume the same agent instead of starting over.",
    "- Skip delegation for trivial work you can do directly in a step or two — delegation has a context-handoff cost that only pays off on substantial tasks.",
    "",
    backgroundNote,
    "",
    "Available agent types (pass via subagent_type):",
    ...spawner.available.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`),
  ].join("\n");

  const input = z.preprocess(
    (raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
      const record = raw as Record<string, unknown>;
      if (typeof record["subagent_type"] === "string" && record["subagent_type"].length > 0) return raw;
      if (typeof record["resume"] === "string" && record["resume"].trim().length > 0) return raw;
      return { ...record, subagent_type: defaultName };
    },
    z.object({
      prompt: z.string().describe("Full task prompt for the subagent."),
      description: z.string().describe("Short task description (3-5 words) for UI display."),
      name: z
        .string()
        .optional()
        .describe(
          "Name this subagent, e.g. \"dba\". Becomes its agent id — what you pass to resume, and what teammates address it by. Letters, digits, _ and - only; must be unused in this session. Omit for a generated id.",
        ),
      subagent_type: z.string().optional().describe("One of the available agent types. Defaults to coder when available, otherwise the first available subagent."),
      resume: z.string().optional().describe("Agent ID (returned by a prior spawn) to continue that subagent with a new prompt."),
      run_in_background: z.boolean().optional().describe("If true, return immediately without waiting for completion."),
    }),
  );

  return defineTool({
    name: "Agent",
    description,
    params: input,
    resolve: (args) => {
      const requested = args.subagent_type ?? defaultName;
      return {
        approvalRule: "Agent",
        // The Agent call itself touches nothing directly — the spawned subagent runs its own
        // tools, each declaring its own accesses and going through its own approval. Declare
        // none() so delegation isn't gated as a mutator (the subagent enforces plan-mode /
        // permissions on its side).
        accesses: ToolAccesses.none(),
        controlFlow: true,
        display: {
          title: args.run_in_background === true ? `Background sub-agent: ${requested}` : `Sub-agent: ${requested}`,
          detail: args.description,
        },
        run: async (ctx): Promise<ToolResult> => {
          const continuation = childContinuation(parent, ctx.toolCallId);
          if (continuation) {
            if (parent.store === undefined) {
              return errResult("Agent interruption resume requires a durable session store; none is configured.");
            }
            const meta = await readSubagentMeta(parent.store, continuation.address);
            if (!meta) return errResult(`Cannot resume interrupted agent "${continuation.agentInstanceId}": subagent metadata is missing.`);
            const root = await spawner.resolve(meta.type);
            if (!root) return errResult(`Cannot resume interrupted agent: type "${meta.type}" is not available here.`);
            const deadline = createDeadline(parent.signal, AGENT_TIMEOUT_MS);
            let result: RunResult;
            try {
              result = await resumeInterruptedChild(root, continuation, spawner, parent, ctx.toolCallId, deadline.signal);
            } finally {
              deadline.clear();
            }
            settleChild(parent, result, continuation.execution.usage);
            if (deadline.timedOut()) return timeoutResult(root.name, continuation.agentInstanceId);
            return spawnResult(root.name, continuation.agentInstanceId, "completed", result.output, result.usage, settleStatus(result.status));
          }

          const resumeId = args.resume?.trim();
          if (resumeId !== undefined && resumeId.length > 0 && args.subagent_type !== undefined && args.subagent_type.length > 0) {
            return errResult("Cannot set subagent_type when resuming an existing agent. Resume by agent id only.");
          }
          if (resumeId !== undefined && resumeId.length > 0 && args.name !== undefined && args.name.trim().length > 0) {
            return errResult("Cannot set name when resuming an existing agent — it already has one. Resume by agent id only.");
          }

          // ── Resume an existing subagent by id: reload its shard and continue ──
          if (resumeId !== undefined && resumeId.length > 0) {
            if (parent.store === undefined) {
              return errResult("Agent resume requires a durable session store; none is configured for this session.");
            }
            // Recover the subagent's type from the meta record in its OWN shard (written at
            // spawn), so resume needs no registry/fold over the parent conversation. The shard
            // address is the per-instance address, identical to how it was assigned at spawn.
            const address = joinAddress(parent.address, resumeId);
            const meta = await readSubagentMeta(parent.store, address);
            if (meta === undefined) {
              return errResult(`Unknown agent id "${resumeId}". Spawn a new subagent, or check the id returned by a prior spawn.`);
            }
            const sub = await spawner.resolve(meta.type);
            if (sub === undefined) {
              return errResult(`Cannot resume "${resumeId}": its agent type "${meta.type}" is not available here.`);
            }
            const deadline = createDeadline(parent.signal, AGENT_TIMEOUT_MS);
            const childState = spawner.derive({ address, signal: deadline.signal, parentToolCallId: ctx.toolCallId, steer: new SteerBus() });
            // Rebuild the subagent's context, validate the new prompt, then append it only
            // after acceptance. A rejected prompt is audit-only in the child shard.
            const childContext = await replayContext(parent.store, address);
            const promptMessage: Message = { role: "user", content: [{ type: "text", text: args.prompt }], timestamp: Date.now() };
            await guardSubagentInput(sub, [promptMessage], childState, spawner);
            childContext.appendMessage(promptMessage);
            // Same contract as a fresh spawn: the resumed frame is live at its address, so its
            // inbox must be reachable via `session.steerTo` for the duration of the run.
            const unregisterBus = parent.session.registerFrameBus(childState.address, childState.steer);
            let result: RunResult;
            try {
              result = await spawner.run(sub, childContext, childState);
            } finally {
              deadline.clear();
              unregisterBus();
              await childContext.flush();
            }
            settleChild(parent, result);
            if (deadline.timedOut()) return timeoutResult(sub.name, resumeId);
            return spawnResult(sub.name, resumeId, "resumed", result.output, result.usage, settleStatus(result.status));
          }

          // ── Fresh spawn: assign a per-instance id + shard, register, run ──
          const sub = await spawner.resolve(requested);
          if (sub === undefined) {
            return errResult(`Unknown subagent_type "${requested}". Available: ${spawner.available.map((a) => a.name).join(", ")}`);
          }
          // A caller-chosen name IS the agent's id: it addresses the shard, resume looks it up,
          // and peers message it by that name. So it has to be unique here — silently
          // uniquifying it would hand the caller a name that reaches a different agent.
          const chosenName = args.name?.trim();
          if (chosenName !== undefined && chosenName.length > 0) {
            const invalid = invalidAgentName(chosenName);
            if (invalid !== undefined) return errResult(invalid);
            if (parent.store !== undefined && (await readSubagentMeta(parent.store, joinAddress(parent.address, chosenName))) !== undefined) {
              return errResult(
                `Agent name "${chosenName}" is already taken in this session. Continue that agent with Agent(resume="${chosenName}", prompt=...), or choose a different name.`,
              );
            }
          }
          const agentId = chosenName !== undefined && chosenName.length > 0 ? chosenName : newAgentId(sub.name);
          const address = joinAddress(parent.address, agentId);
          const background = args.run_in_background === true;
          if (background && parent.store === undefined) {
            return errResult("Background Agent execution requires a durable session store because the result lives in the subagent's conversation shard.");
          }

          // Record the subagent's identity in its OWN shard so resume can recover its type by
          // id without folding the parent conversation.
          // `custom` entries are audit-only — never replayed into history — so this stays out
          // of the run's context. Foreground subagents get one too: they are plain tool calls,
          // but their shard is still resumable by id.
          if (parent.store !== undefined) {
            await parent.store.appendRecord({
              address,
              type: "custom",
              name: SUBAGENT_META,
              data: {
                agentId,
                type: sub.name,
                description: args.description,
                background,
                parentAddress: parent.address,
                parentToolCallId: ctx.toolCallId,
              } satisfies SubagentMeta,
            });
          }

          const runSubagent = (signal: AbortSignal): Promise<RunResult> =>
            runFreshChild(sub, spawner, parent, {
              address,
              agentInstanceId: agentId,
              prompt: args.prompt,
              parentToolCallId: ctx.toolCallId,
              signal,
              description: args.description,
            });

          if (background) {
            const registrar = asTaskRegistrar(parent.background);
            if (registrar === undefined) {
              return errResult("Background agent execution is unavailable because no BackgroundManager is attached.");
            }
            const controller = new AbortController();
            // `agentStatus` rides the task into the settle notification, whose journaled
            // tag is the durable settle record the subagent fold reads.
            // Only the status: the run's own answer is already the last message of its shard,
            // which the task names as its output location rather than carrying a copy of.
            const taskId = registrar.registerTask(
              new AgentBackgroundTask(() => runSubagent(controller.signal).then((result) => ({
                agentStatus: settleStatus(result.status),
              })), args.description, {
                timeoutMs: AGENT_TIMEOUT_MS,
                subagentType: sub.name,
                agentId,
                address,
                parentAddress: parent.address,
                toolCallId: ctx.toolCallId,
                abort: () => controller.abort(),
              }),
            );
            const status = registrar.getTask(taskId)?.status ?? "running";
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `task_id: ${taskId}`,
                    `agent_id: ${agentId}`,
                    `status: ${status}`,
                    `actual_subagent_type: ${sub.name}`,
                    "automatic_notification: true",
                    "",
                    `description: ${args.description}`,
                    "",
                    `next_step: The completion arrives automatically in a later turn. BackgroundOutput(task_id="${taskId}", block=false) to peek; resume later with Agent(resume="${agentId}", prompt=...).`,
                  ].join("\n"),
                },
              ],
              // The spawn ack IS the registry row: the fold opens the record from these details.
              details: {
                agent: sub.name,
                agentId,
                type: sub.name,
                status: "running",
                background: true,
                taskId,
                description: args.description,
              } satisfies AgentSpawnDetails & { agent: string },
            };
          }

          const detachSignal = ctx.detachSignal;
          const fgRegistrar = detachSignal !== undefined && parent.store !== undefined ? asTaskRegistrar(parent.background) : undefined;

          // Non-detachable foreground (no detach trigger or no manager): run inline as before.
          if (detachSignal === undefined || fgRegistrar === undefined) {
            const deadline = createDeadline(parent.signal, AGENT_TIMEOUT_MS);
            let result: RunResult;
            try {
              result = await runSubagent(deadline.signal);
            } finally {
              deadline.clear();
            }
            settleChild(parent, result);
            if (deadline.timedOut()) return timeoutResult(sub.name, agentId);
            return spawnResult(sub.name, agentId, "completed", result.output, result.usage, settleStatus(result.status), args.description);
          }

          // Detachable foreground: run on our OWN controller (bridged from parent.signal + the
          // agent timeout) so `ctx.detachSignal` can peel the still-running subagent into a
          // background task without the turn's abort killing it. The completion promise carries
          // the whole result, so a promise-based task adopts it cleanly — no stream handoff.
          ctx.onUpdate?.({ kind: "custom", customKind: "detachable" }); // UI: offer "move to background"
          const controller = new AbortController();
          const bridge = (): void => controller.abort();
          let timedOut = false;
          if (parent.signal.aborted) controller.abort();
          else parent.signal.addEventListener("abort", bridge, { once: true });
          const deadlineTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, AGENT_TIMEOUT_MS);

          const runPromise = runSubagent(controller.signal);
          const detachP = new Promise<"detach">((resolve) => {
            const onDetach = (): void => resolve("detach");
            if (detachSignal.aborted) onDetach();
            else detachSignal.addEventListener("abort", onDetach, { once: true });
          });
          const winner = await Promise.race([runPromise.then(() => "done" as const, () => "done" as const), detachP]);

          if (winner === "detach") {
            parent.signal.removeEventListener("abort", bridge); // drop the kill bridge: turn-end must not kill it
            clearTimeout(deadlineTimer);
            const completion = runPromise.then((result) => ({
              agentStatus: settleStatus(result.status),
            }));
            const taskId = fgRegistrar.registerTask(
              new AgentBackgroundTask(() => completion, args.description, {
                subagentType: sub.name,
                agentId,
                address,
                parentAddress: parent.address,
                toolCallId: ctx.toolCallId,
                abort: () => controller.abort(),
              }),
            );
            ctx.onUpdate?.({ kind: "custom", customKind: "detached", customData: { taskId } });
            const status = fgRegistrar.getTask(taskId)?.status ?? "running";
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `Moved to background task ${taskId}.`,
                    `agent_id: ${agentId}`,
                    `status: ${status}`,
                    `actual_subagent_type: ${sub.name}`,
                    "automatic_notification: true",
                    "",
                    `description: ${args.description}`,
                    "",
                    `next_step: The completion arrives automatically in a later turn. BackgroundOutput(task_id="${taskId}", block=false) to peek; resume later with Agent(resume="${agentId}", prompt=...).`,
                  ].join("\n"),
                },
              ],
              details: {
                agent: sub.name,
                agentId,
                type: sub.name,
                status: "running",
                background: true,
                movedToBackground: true,
                taskId,
                description: args.description,
              } satisfies AgentSpawnDetails & { agent: string; movedToBackground: boolean },
            };
          }

          parent.signal.removeEventListener("abort", bridge);
          clearTimeout(deadlineTimer);
          const result = await runPromise;
          settleChild(parent, result);
          if (timedOut) return timeoutResult(sub.name, agentId);
          return spawnResult(sub.name, agentId, "completed", result.output, result.usage, settleStatus(result.status), args.description);
        },
      };
    },
  });
}

// ── Shared child-run flow ────────────────────────────────────────────────────────────────

/**
 * Run a FRESH child to completion in its own journal shard: fork the frame, guard the
 * prompt, seed a new context, run, and always flush. The one spawn flow shared by the
 * static `agent_<name>` tool and the unified `Agent` tool's foreground and background
 * spawn paths (resume paths differ — they replay an existing shard instead of seeding).
 */
async function runFreshChild<TContext>(
  sub: Agent<TContext>,
  spawner: SubagentSpawner<TContext>,
  parent: RunState<TContext>,
  opts: {
    readonly address: string;
    readonly agentInstanceId: string;
    readonly prompt: string;
    readonly parentToolCallId: string;
    /** Per-child abort (deadline / background cancel); defaults to the parent's. */
    readonly signal?: AbortSignal;
    /** Short task label, surfaced on the peer roster. */
    readonly description?: string;
  },
): Promise<RunResult> {
  // Root-frame fan-out queues behind a session-wide limiter; a nested spawn does not (holding a
  // permit while waiting for a child that needs one is a deadlock). See `spawnLimiterFor`.
  const limiter = spawnLimiterFor(parent, parent.maxConcurrentSubagents);
  return limiter === undefined ? runFreshChildInner(sub, spawner, parent, opts) : limiter.run(() => runFreshChildInner(sub, spawner, parent, opts));
}

async function runFreshChildInner<TContext>(
  sub: Agent<TContext>,
  spawner: SubagentSpawner<TContext>,
  parent: RunState<TContext>,
  opts: {
    readonly address: string;
    readonly agentInstanceId: string;
    readonly prompt: string;
    readonly parentToolCallId: string;
    readonly signal?: AbortSignal;
    readonly description?: string;
  },
): Promise<RunResult> {
  // Its OWN SteerBus. Without this the child inherits the parent's (`deriveChild` spreads
  // `steer`) and the two frames drain one queue: a message aimed at the child could be consumed
  // by the parent, and — today, before any peer messaging exists — a user steer typed at the main
  // session gets eaten by whichever subagent happens to be running. Separate queues are what make
  // addressing a subagent meaningful at all.
  const childState = spawner.derive({
    address: opts.address,
    parentToolCallId: opts.parentToolCallId,
    agentInstanceId: opts.agentInstanceId,
    steer: new SteerBus(),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const childMessages: Message[] = [
    { role: "user", content: [{ type: "text", text: opts.prompt }], timestamp: Date.now() },
  ];
  await guardSubagentInput(sub, childMessages, childState, spawner);
  // The sub-agent journals to its own shard (`main/<child>`), isolated for replay.
  const childContext = new ConversationContext({
    store: childState.store,
    address: childState.address,
    ...(childState.store === undefined
      ? { onHistoryChange: historyChangeEmitter(childState.events, childState.sessionId) }
      : {}),
  });
  childContext.seed(childMessages);
  // Publish this frame's inbox for the duration of the run, so an external coordinator can reach
  // it by address (`session.steerTo`). Unregistered on the way out — a finished frame must not
  // keep receiving.
  const unregisterBus = parent.session.registerFrameBus(childState.address, childState.steer);
  try {
    return await spawner.run(sub, childContext, childState);
  } finally {
    unregisterBus();
    await childContext.flush();
  }
}


/**
 * Fold a settled FOREGROUND child run into the parent frame: account its usage (minus
 * `priorUsage` when resuming a continuation whose earlier turns were already accounted)
 * and re-throw an interruption as the structured tool-suspension signal. Background
 * children never come through here — their usage stays in their own ledger.
 */
function settleChild<TContext>(parent: RunState<TContext>, result: RunResult, priorUsage?: Usage): void {
  parent.usage = addUsage(parent.usage, priorUsage !== undefined ? subtractUsage(result.usage, priorUsage) : result.usage);
  bubbleInterruption(result);
}

// ── Foreground interruption continuation ─────────────────────────────────────────────────

function childContinuation<TContext>(
  parent: RunState<TContext>,
  parentToolCallId: string,
): InterruptionFrame | undefined {
  const interruption = parent.interruption;
  if (!interruption) return undefined;
  const parentFrame = interruption.frames[parent.frameId];
  const childFrameId = parentFrame?.children[parentToolCallId];
  return childFrameId ? interruption.frames[childFrameId] : undefined;
}

async function resumeInterruptedChild<TContext>(
  root: Agent<TContext>,
  frame: InterruptionFrame,
  spawner: SubagentSpawner<TContext>,
  parent: RunState<TContext>,
  parentToolCallId: string,
  signal: AbortSignal,
): Promise<RunResult> {
  if (!parent.store) throw new Error("Cannot resume an interrupted sub-agent without a durable session store.");
  const active = spawner.resolveInGraph(root, frame.agent.key);
  if (!active) throw new Error(`Cannot resume sub-agent: active agent "${frame.agent.key}" is unavailable.`);
  const childState = spawner.derive({
    address: frame.address,
    parentToolCallId,
    signal,
    resumeFrame: frame,
    steer: new SteerBus(),
  });
  const childContext = await replayContext(parent.store, frame.address);
  childState.session.setLiveContext(frame.address, childContext);
  const resumeFrom = findAnchoredAssistant(childContext.messages, frame.anchor);
  // Same contract as a fresh spawn: the resumed frame must be steerable at its address.
  const unregisterBus = parent.session.registerFrameBus(frame.address, childState.steer);
  try {
    return await spawner.run(active, childContext, childState, resumeFrom);
  } finally {
    unregisterBus();
    await childContext.flush();
  }
}

function bubbleInterruption(result: RunResult): void {
  if (result.status !== "interrupted") return;
  const interruption = getInterruptionState(result);
  if (!interruption) throw new Error("Interrupted sub-agent did not provide structured continuation state.");
  throw new ToolInterruptionSignal(interruption);
}

export async function guardSubagentInput<TContext>(
  agent: Agent<TContext>,
  input: readonly Message[],
  state: RunState<TContext>,
  spawner: SubagentSpawner<TContext>,
): Promise<void> {
  try {
    await runInputGuardrails(agent.guardrails.input ?? [], {
      agent,
      input,
      context: spawner.ctxFor(state),
    });
  } catch (error) {
    if (!isGuardrailTripwireError(error)) throw error;
    const blocked = {
      type: "guardrail.blocked",
      stage: error.stage,
      guardrail: error.guardrailName,
      agent: error.agentName ?? agent.name,
      message: error.message,
    } as const;
    if (state.store) {
      await state.store.appendRecord({
        ...blocked,
        address: state.address,
        input: [...input],
      });
    } else {
      await state.events.emit({
        ...blocked,
        address: state.address,
        sessionId: state.sessionId,
      });
    }
    throw error;
  }
}

// ── Deadline + result helpers ────────────────────────────────────────────────────────────

/** 30 minutes — the fixed foreground + background subagent deadline. */
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

interface Deadline {
  readonly signal: AbortSignal;
  /** True once the timer (not a parent/user abort) fired — lets the caller report the cause. */
  timedOut(): boolean;
  clear(): void;
}

/** A child abort signal that fires when `parent` aborts OR after `ms` elapses. `timedOut()`
 *  distinguishes the deadline from a parent/user abort so the caller reports the right cause. */
function createDeadline(parent: AbortSignal, ms: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Agent deadline exceeded"));
  }, ms);
  // Don't let the pending timer keep the process alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function timeoutResult(name: string, agentId: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `agent_id: ${agentId}`,
          `actual_subagent_type: ${name}`,
          "status: failed",
          "",
          "subagent error: Agent timed out after 30 minutes.",
          `resume_hint: Continue with Agent(resume="${agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
        ].join("\n"),
      },
    ],
    isError: true,
    details: { agent: name, agentId, type: name, status: "error" } satisfies AgentSpawnDetails & { agent: string },
  };
}

function settleStatus(status: RunStatus): SubagentStatus {
  // "skipped" folds into "completed": a capability answered instead of the model, but from the
  // parent's point of view the child finished and produced output.
  return status === "interrupted" ? "paused" : status === "aborted" ? "cancelled" : status === "error" ? "error" : "completed";
}

function errResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function spawnResult(
  name: string,
  agentId: string,
  verb: string,
  output: string,
  usage: Usage,
  status: SubagentStatus,
  description?: string,
): ToolResult {
  return {
    content: [{ type: "text", text: [`agent_id: ${agentId}`, `actual_subagent_type: ${name}`, `status: ${verb}`, "", "[summary]", output].join("\n") }],
    // These details are the spawn/settle record the subagent fold reads — the tool result
    // is the registry row, not an input to some separate ledger.
    details: { agent: name, agentId, usage, type: name, status, background: false, description } satisfies AgentSpawnDetails & { agent: string },
  };
}
