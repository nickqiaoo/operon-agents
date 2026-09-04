import os from "node:os";
import { z } from "zod";
import type { Message, Usage } from "../../protocol/index.ts";
import { addUsage, emptyUsage } from "../../loop/usage.ts";
import { errorMessage, isAbortError } from "../../loop/errors.ts";
import { ConversationContext } from "../../loop/context.ts";
import { historyChangeEmitter } from "../run-support.ts";
import { SteerBus } from "../../loop/steer.ts";
import { defineTool } from "../../tool/define.ts";
import { ToolAccesses } from "../../tool/access.ts";
import type { Tool, ToolResult } from "../../tool/types.ts";
import { resolveToolPath } from "../../tool/support/tool-path.ts";
import { readTextFile, writeTextFile } from "../../tool/support/machine-ops.ts";
import type { Machine } from "../../tool/machine.ts";
import { joinAddress } from "../../events/index.ts";
import { WorkflowBackgroundTask } from "../../capabilities/background/workflow-task.ts";
import type { BackgroundTaskSink } from "../../capabilities/background/task.ts";
import { asTaskRegistrar } from "../../capabilities/background/registrar.ts";
import type { RunState, SubagentSpawner } from "../runner.ts";
import type { SessionPort } from "../session.ts";
import { newAgentId } from "../subagent.ts";
import { guardSubagentInput } from "../subagent-tools.ts";
import { createWorktree } from "../worktree.ts";
import {
  runWorkflow,
  parseWorkflow,
  WorkflowJournal,
  journalAddress,
  workflowPrompt,
  makeStructuredOutputTool,
  cloneAgentWithTool,
  validateValue,
  structuredInstruction,
  WORKFLOW_AGENT_TIMEOUT_MS,
  type WorkflowHostHooks,
  type WorkflowProgressEvent,
  type RunWorkflowResult,
  type WorkflowRunDetails,
} from "./index.ts";

/**
 * The Workflow tool — a deterministic JS orchestration runtime over subagents.
 * The script runs in a hardened VM (see workflow/sandbox.ts); its agent() hook spawns
 * subagents through the shared `SubagentSpawner` (the same `Engine.run` the Agent tool
 * uses), so token usage feeds a REAL budget and structured output is enforced by
 * injecting a StructuredOutput tool into the subagent.
 *
 * Independent of the Runner: it receives the engine's spawner + the parent runtime, and
 * runs sub-agents by forking a child frame (`spawner.derive`) and calling `spawner.run`.
 */
export function buildWorkflowTool<TContext>(
  spawner: SubagentSpawner<TContext>,
  parent: RunState<TContext>,
): Tool {

  // Build the host hooks. `emitProgress` + `abortSignal` differ between the
  // foreground (ctx.onUpdate) and background (task sink) paths; subagent usage
  // accumulates into `usageBox` so the caller can fold it into parent.usage.
  const buildHooks = (
    emitProgress: (event: WorkflowProgressEvent) => void,
    abortSignal: AbortSignal,
    tokenBudget: number | null,
    usageBox: { usage: Usage },
    parentToolCallId: string,
  ): WorkflowHostHooks => {
    const baseline = parent.usage.output;
    return {
      concurrency: Math.min(16, Math.max(2, os.cpus().length - 2)),
      abortSignal,
      budget: { total: tokenBudget, getTurnSpent: () => baseline },
      resolveWorkflowScript: (name) => readNamedWorkflow(parent.machine, name),
      emitProgress,
      runAgent: async ({ prompt, agentType, schema, isolation, signal, onStart }) => {
        const sub = await spawner.resolve(agentType ?? spawner.defaultType);
        if (sub === undefined) {
          throw new Error(`unknown agentType "${agentType ?? spawner.defaultType}". Available: ${spawner.available.map((a) => a.name).join(", ")}`);
        }
        const agentId = newAgentId(sub.name);
        const address = joinAddress(parent.address, agentId);
        // Publish + journal the stable identity before any work runs, so the orchestration
        // event can be joined to this child's Session AgentEvents and interruption is resumable.
        onStart({ agentId, address });

        // Optional worktree isolation — degrade (with a log, never silently) if unsupported.
        let runMachine = parent.machine;
        let cleanupWorktree: (() => Promise<void>) | undefined;
        if (isolation === "worktree") {
          const wt = await createWorktree(parent.machine, { label: agentId });
          if (wt) {
            runMachine = wt.machine;
            cleanupWorktree = wt.cleanup;
            emitProgress({ type: "log", message: `🌳 ${agentId}: isolated worktree at ${wt.cwd}` });
          } else {
            emitProgress({ type: "log", message: `isolation:'worktree' unavailable on machine '${parent.machine.name}' — running in the shared workspace` });
          }
        }

        // Per-agent abort: workflow signal OR an absolute stall timeout.
        const controller = new AbortController();
        const onAbort = (): void => controller.abort();
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), WORKFLOW_AGENT_TIMEOUT_MS);

        // Each concurrent subagent gets its OWN SteerBus: the parent's tracks a
        // single activeTurnId, so sharing it across parallel agents would corrupt
        // the parent turn's steering state. Subagents are ephemeral and take no steers.
        const childState = spawner.derive({ address, machine: runMachine, signal: controller.signal, steer: new SteerBus(), parentToolCallId });
        const childContext = new ConversationContext({
          store: parent.store,
          address,
          ...(parent.store === undefined
            ? { onHistoryChange: historyChangeEmitter(parent.events, parent.sessionId) }
            : {}),
        });
        let outputTokens = 0;
        try {
          // Plain agent — return the final text.
          if (schema === undefined) {
            const promptMessage: Message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
            await guardSubagentInput(sub, [promptMessage], childState, spawner);
            childContext.seed([promptMessage]);
            const result = await spawner.run(sub, childContext, childState);
            usageBox.usage = addUsage(usageBox.usage, result.usage);
            return { value: result.output, outputTokens: result.usage.output, agentId, address };
          }
          // Structured agent — inject StructuredOutput, nudge-retry in-conversation.
          const { tool, capture } = makeStructuredOutputTool(schema);
          const childAgent = cloneAgentWithTool(sub, tool);
          const promptMessage: Message = {
            role: "user",
            content: [{ type: "text", text: prompt + structuredInstruction(schema) }],
            timestamp: Date.now(),
          };
          await guardSubagentInput(childAgent, [promptMessage], childState, spawner);
          childContext.seed([promptMessage]);
          const maxAttempts = 3;
          let lastError = "";
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            capture.called = false;
            capture.value = undefined;
            const result = await spawner.run(childAgent, childContext, childState);
            usageBox.usage = addUsage(usageBox.usage, result.usage);
            outputTokens += result.usage.output;
            if (capture.called) {
              const verdict = validateValue(schema, capture.value);
              if (verdict.ok) return { value: capture.value, outputTokens, agentId, address };
              lastError = verdict.error;
              childContext.appendMessage({
                role: "user",
                content: [{ type: "text", text: `Your StructuredOutput argument failed schema validation: ${lastError}. Call StructuredOutput again with corrected JSON.` }],
                timestamp: Date.now(),
              });
            } else {
              lastError = "you did not call StructuredOutput";
              childContext.appendMessage({
                role: "user",
                content: [{ type: "text", text: "You did not call the StructuredOutput tool. You MUST call it now with your answer." }],
                timestamp: Date.now(),
              });
            }
          }
          throw new Error(`subagent produced no schema-valid structured output after ${maxAttempts} attempts: ${lastError}`);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          await childContext.flush();
          if (cleanupWorktree) await cleanupWorktree();
        }
      },
    };
  };

  const input = z.object({
    script: z.string().optional().describe("Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase()."),
    name: z.string().optional().describe("Name of a predefined workflow (from the workspace `.agents/workflows/`). Resolves to a self-contained script."),
    scriptPath: z.string().optional().describe("Path to a workflow script file in the workspace. Every Workflow invocation persists its script under `.agents/runs/` and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`."),
    args: z.unknown().optional().describe("Value exposed to the script as the global `args` (pass real JSON, not a stringified value)."),
    resumeFromRunId: z.string().optional().describe("Resume a prior run; unchanged agent() calls return cached results instantly."),
    tokenBudget: z.number().optional().describe("Output-token target for the run; enables budget.remaining()-guarded loops in the script."),
    run_in_background: z.boolean().optional().describe("Run detached and return a task_id immediately (recommended for long workflows). A completion notice arrives on its own; BackgroundOutput(task_id, block=false) reads progress or the result meanwhile. Requires a BackgroundManager."),
  });

  return defineTool({
    name: "Workflow",
    description: workflowPrompt(spawner.available.map((a) => a.name)),
    params: input,
    resolve: (args) => ({
      approvalRule: "Workflow",
      accesses: ToolAccesses.all(),
      controlFlow: true,
      display: { title: "Workflow", detail: args.name ?? args.scriptPath ?? "inline script" },
      run: async (ctx): Promise<ToolResult> => {
        if (args.run_in_background === true && parent.store === undefined) {
          return errResult("Background Workflow execution requires a durable session store because the result lives in the workflow journal.");
        }
        // ── Resolve the script source. Precedence: scriptPath > script > name > the journal. ──
        //
        // The journal entry is what makes a resume self-contained. Every other source is a
        // path into the workspace — a file the model may have edited since, that a later run
        // of the same workflow may have replaced, and that does not exist at all if the
        // machine is a sandbox that has since been rebuilt. Resuming against a DIFFERENT
        // script is worse than failing: the journal keys are chained hashes of each agent's
        // prompt, so one changed prompt misses every cache entry after it and silently
        // re-runs the whole workflow for real money.
        let script: string | null = null;
        const resumeId = args.resumeFromRunId;
        const noExplicitSource =
          (args.scriptPath === undefined || args.scriptPath.length === 0) &&
          (args.script === undefined || args.script.trim().length === 0) &&
          (args.name === undefined || args.name.length === 0);
        if (resumeId !== undefined && resumeId.length > 0 && noExplicitSource) {
          const priorJournal = parent.session.newWorkflowJournal(resumeId, ctx.toolCallId);
          await priorJournal.load();
          const recorded = priorJournal.recordedScript();
          if (recorded === undefined) {
            return errResult(
              `No recorded script for runId "${resumeId}" — that run predates script recording, or its journal is gone. Pass \`script\`/\`scriptPath\` explicitly.`,
            );
          }
          script = recorded;
        } else if (args.scriptPath !== undefined && args.scriptPath.length > 0) {
          try {
            const safePath = await resolveToolPath(args.scriptPath, ctx.machine, "read");
            script = await readTextFile(ctx.machine, safePath);
          } catch (err) {
            return errResult(`Could not read scriptPath: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (args.script !== undefined && args.script.trim().length > 0) {
          script = args.script;
        } else if (args.name !== undefined && args.name.length > 0) {
          script = await readNamedWorkflow(ctx.machine, args.name);
          if (script === null) return errResult(`No saved workflow named "${args.name}" in the workspace .agents/workflows/.`);
        } else {
          return errResult("Provide one of: `scriptPath` (workspace file), `script` (inline), `name` (saved workflow), or `resumeFromRunId` alone to replay a recorded run.");
        }

        const parsed = parseWorkflow(script);
        if ("error" in parsed) return errResult(`Invalid workflow script: ${parsed.error}`);
        const { meta, scriptBody } = parsed;

        const runId = args.resumeFromRunId ?? newAgentId("wf");
        const tokenBudget = args.tokenBudget ?? null;
        // Persist the resolved script to the workspace and hand back its path, so the
        // model can Write/Edit it and re-run via `scriptPath` instead of re-sending the whole
        // script. Goes through the Machine → on a server it lands in the sandbox, never the
        // host disk. Best-effort: a persist failure never fails the run (path is left undefined).
        const persistedScriptPath = await persistRunScript(ctx.machine, meta.name, runId, script);
        // Resume journals come from the session port: the workflow capability's manager, or
        // the in-memory fallback Session.open provides when no capability is attached — either
        // way bound to the session's store. Discovery needs no writes: the tool results below
        // carry the run's lifecycle in `details`, and the `/workflows` list is a fold over the
        // conversation (snapshot.ts).
        const mkJournal = (id: string): WorkflowJournal => parent.session.newWorkflowJournal(id, ctx.toolCallId);
        // Timestamps are stamped HOST-side (Date.now is banned only inside the sandbox).
        const startedAt = new Date().toISOString();
        const runDetails = (status: WorkflowRunDetails["status"], endedAt?: string, outputTokens?: number): WorkflowRunDetails => ({
          workflow: meta.name,
          runId,
          status,
          background: args.run_in_background === true,
          description: meta.description,
          startedAt,
          endedAt,
          outputTokens,
        });
        const emitStorelessProgress = (event: WorkflowProgressEvent): void => {
          if (parent.store !== undefined) return;
          void parent.events.emit({
            address: journalAddress(runId),
            sessionId: parent.sessionId,
            type: "workflow.progress",
            runId,
            ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
            progress: event,
          });
        };
        /** Write the inputs before anything runs, so an interrupted run is still replayable. */
        const openJournal = async (journal: WorkflowJournal): Promise<void> => {
          await journal.load();
          // The SOURCE, not `scriptBody`: parseWorkflow strips the `meta` block off the front,
          // so a body cannot be parsed again. A resume re-parses what it reads back.
          await journal.recordRun(meta.name, script, args.args, {
            parentAddress: parent.address,
            parentToolCallId: ctx.toolCallId,
          });
        };
        /** Write what the run produced. Makes the address self-contained: inputs, every agent
         *  result, and the payload — so a reader never has to replay just to see the answer. */
        const closeJournal = async (journal: WorkflowJournal, outcome: RunWorkflowResult): Promise<void> => {
          await journal.recordOutcome({
            status: outcome.ok ? "completed" : "failed",
            ok: outcome.ok,
            ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
            failures: outcome.failures,
            agentCount: outcome.agentCount,
          });
        };
        /** The one execution boundary for every mode. It owns both journal brackets, so callers
         *  cannot forget the terminal record on failure or abort. */
        const executeJournaled = async (
          journal: WorkflowJournal,
          hooks: WorkflowHostHooks,
        ): Promise<RunWorkflowResult> => {
          await openJournal(journal);
          try {
            const outcome = await runWorkflow({ meta, scriptBody, args: args.args, hooks, journal });
            await closeJournal(journal, outcome);
            return outcome;
          } catch (error) {
            const events = journal.readEvents();
            const failures = events.flatMap((event) => (event.type === "error" ? [event.error] : []));
            await journal.recordOutcome({
              status: isAbortError(error) ? "aborted" : "failed",
              ok: false,
              error: errorMessage(error),
              failures,
              agentCount: events.filter((event) => event.type === "started").length,
            });
            throw error;
          }
        };
        const payloadOf = (outcome: RunWorkflowResult): string =>
          safeJsonStringify({
            runId,
            name: meta.name,
            ok: outcome.ok,
            result: outcome.ok ? outcome.result : undefined,
            error: outcome.ok ? undefined : outcome.error,
            failures: outcome.failures,
            agentCount: outcome.agentCount,
            // Editable via Write/Edit; pass back as `scriptPath` to re-run without resending.
            scriptPath: persistedScriptPath,
          });

        // ── Background path: register a task, return task_id, run detached ──
        if (args.run_in_background === true) {
          const registrar = asTaskRegistrar(parent.background);
          if (registrar === undefined) {
            return errResult("run_in_background requested but no BackgroundManager is attached to this session.");
          }
          const controller = new AbortController();
          // `runStatus` rides the task into the settle notification, whose journaled tag
          // is the durable settle record the workflow fold reads.
          const run = async (_sink: BackgroundTaskSink): Promise<{ runStatus: "completed" | "failed" }> => {
            const journal = mkJournal(runId);
            const usageBox = { usage: emptyUsage() };
            // Public workflow.progress events come from the journal's publication-aware
            // append. Background execution has no attached courtesy update outlet.
            const hooks = buildHooks(() => undefined, controller.signal, tokenBudget, usageBox, ctx.toolCallId);
            const outcome = await executeJournaled(journal, hooks);
            return { runStatus: outcome.ok ? "completed" : "failed" };
          };
          const taskId = registrar.registerTask(
            new WorkflowBackgroundTask(run, meta.name, {
              timeoutMs: 60 * 60 * 1000,
              workflowName: meta.name,
              runId,
              address: journalAddress(runId),
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
                  `runId: ${runId}`,
                  `workflow: ${meta.name}`,
                  `status: ${status}`,
                  "automatic_notification: true",
                  "",
                  `description: ${meta.description}`,
                  ...(meta.phases ? [`phases: ${meta.phases.map((p) => p.title).join(" → ")}`] : []),
                  ...(persistedScriptPath !== undefined ? [`persisted_script: ${persistedScriptPath} (edit with Write/Edit, re-run via scriptPath)`] : []),
                  "",
                  `next_step: A completion notice arrives automatically. BackgroundOutput(task_id="${taskId}", block=false) reads live progress or the final result; re-run cached with resumeFromRunId="${runId}".`,
                ].join("\n"),
              },
            ],
            // The spawn ack IS the discovery row: the fold opens the record from these details.
            details: { ...runDetails("running"), taskId },
          };
        }

        // ── Foreground path: run to completion, return the result ──
        const journal = mkJournal(runId);
        const usageBox = { usage: emptyUsage() };

        const detachSignal = ctx.detachSignal;
        const fgRegistrar = detachSignal !== undefined && parent.store !== undefined ? asTaskRegistrar(parent.background) : undefined;

        // One emitter for the whole run, foreground or not. It used to be swappable — detach
        // rewired progress from `ctx.onUpdate` to the background task's memory tail — which is
        // exactly the split that made a detached run's progress a different thing from an
        // attached one's.
        //
        // Two outlets, neither of them a buffer. The EVENT is how a watcher sees a step as it
        // happens, and it is addressed to the run rather than to the tool call, so it keeps
        // arriving after the run detaches and that call is long gone. `ctx.onUpdate` stays as
        // the attached UI's courtesy, and does nothing once nobody is attached.
        const emitTo = (event: WorkflowProgressEvent): void => {
          emitStorelessProgress(event);
          ctx.onUpdate?.({ kind: "custom", customKind: "workflow", customData: event, text: renderWorkflowProgress(event) });
        };
        // Run on our OWN controller (bridged from ctx.signal) so detach can drop the kill bridge
        // and hand the still-running workflow to a background task.
        const controller = new AbortController();
        const bridge = (): void => controller.abort();
        if (ctx.signal.aborted) controller.abort();
        else ctx.signal.addEventListener("abort", bridge, { once: true });

        const hooks = buildHooks((event) => emitTo(event), controller.signal, tokenBudget, usageBox, ctx.toolCallId);
        const outcomePromise = executeJournaled(journal, hooks);

        // Non-detachable (no trigger / no manager): await inline as before.
        if (detachSignal === undefined || fgRegistrar === undefined) {
          try {
            const outcome = await outcomePromise;
            return {
              content: [{ type: "text", text: payloadOf(outcome) }],
              details: {
                ...runDetails(outcome.ok ? "completed" : "failed", new Date().toISOString(), usageBox.usage.output),
                usage: usageBox.usage,
              },
              isError: !outcome.ok,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Workflow run ${ctx.signal.aborted ? "aborted" : "failed"}: ${error instanceof Error ? error.message : String(error)}` }],
              isError: true,
              details: runDetails(ctx.signal.aborted ? "aborted" : "failed", new Date().toISOString(), usageBox.usage.output),
            };
          } finally {
            ctx.signal.removeEventListener("abort", bridge);
            parent.usage = addUsage(parent.usage, usageBox.usage);
          }
        }

        // Detachable: race the run against the detach trigger.
        ctx.onUpdate?.({ kind: "custom", customKind: "detachable" }); // UI: offer "move to background"
        const detachP = new Promise<"detach">((resolve) => {
          const onDetach = (): void => resolve("detach");
          if (detachSignal.aborted) onDetach();
          else detachSignal.addEventListener("abort", onDetach, { once: true });
        });
        const winner = await Promise.race([outcomePromise.then(() => "done" as const, () => "done" as const), detachP]);

        if (winner === "detach") {
          ctx.signal.removeEventListener("abort", bridge); // turn-end must not kill the now-background run
          const taskId = fgRegistrar.registerTask(
            new WorkflowBackgroundTask(
              async () => {
                const oc = await outcomePromise;
                return { runStatus: oc.ok ? "completed" : "failed" };
              },
              meta.name,
              {
                workflowName: meta.name,
                runId,
                address: journalAddress(runId),
                parentAddress: parent.address,
                toolCallId: ctx.toolCallId,
                abort: () => controller.abort(),
              },
            ),
          );
          ctx.onUpdate?.({ kind: "custom", customKind: "detached", customData: { taskId } });
          parent.usage = addUsage(parent.usage, usageBox.usage); // fold spend accrued so far
          return {
            content: [
              {
                type: "text",
                text: [
                  `Moved to background task ${taskId}.`,
                  `runId: ${runId}`,
                  `workflow: ${meta.name}`,
                  "automatic_notification: true",
                  "",
                  `next_step: A completion notice arrives automatically. BackgroundOutput(task_id="${taskId}", block=false) reads live progress or the final result; re-run cached with resumeFromRunId="${runId}".`,
                ].join("\n"),
              },
            ],
            details: { ...runDetails("running"), taskId, movedToBackground: true },
          };
        }

        // Completed in foreground.
        ctx.signal.removeEventListener("abort", bridge);
        try {
          const outcome = await outcomePromise;
          return {
            content: [{ type: "text", text: payloadOf(outcome) }],
            details: {
              ...runDetails(outcome.ok ? "completed" : "failed", new Date().toISOString(), usageBox.usage.output),
              usage: usageBox.usage,
            },
            isError: !outcome.ok,
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Workflow run ${ctx.signal.aborted ? "aborted" : "failed"}: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
            details: runDetails(ctx.signal.aborted ? "aborted" : "failed", new Date().toISOString(), usageBox.usage.output),
          };
        } finally {
          parent.usage = addUsage(parent.usage, usageBox.usage);
        }
      },
    }),
  });
}

// ── Local helpers (moved out of runner.ts with the tool) ──

const WORKFLOW_DIR = ".agents/workflows";
// Run-scratch lives OUTSIDE `.agents/workflows` so a read-only provisioned workflow library
// (e.g. an R2 mount at `.agents/workflows` on a server) never blocks the persist write.
const WORKFLOW_RUNS_DIR = ".agents/runs";

/**
 * Persist the resolved script to `.agents/workflows/runs/<name>.js` in the workspace (via the
 * Machine — sandbox on a server, never the host disk) and return that path.
 * Every invocation drops an editable copy so the model can Write/Edit it and re-run via
 * `scriptPath`. Best-effort — returns undefined (never throws) if the write fails, so persistence
 * never blocks a run. Keyed by workflow name (stable across iterations of the "same" workflow);
 * curated named workflows live one level up in `.agents/workflows/`, so `runs/` never shadows them.
 */
async function persistRunScript(
  machine: Machine,
  name: string,
  runId: string,
  script: string,
): Promise<string | undefined> {
  // Named per RUN, not per workflow. Sharing a filename across runs of the same workflow meant
  // the second run silently overwrote the first — taking with it any edit the model had made,
  // and leaving a `resumeFromRunId` for the older run pointed at a script whose prompts no
  // longer match its journal keys, so every cached agent misses and re-runs for real.
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "") || "workflow";
  const rel = `${WORKFLOW_RUNS_DIR}/${safeName}.${runId}.js`;
  try {
    await machine.mkdir(await resolveToolPath(WORKFLOW_RUNS_DIR, machine, "write"), { parents: true, existOk: true });
    await writeTextFile(machine, await resolveToolPath(rel, machine, "write"), script);
    return rel;
  } catch {
    return undefined;
  }
}

/**
 * Read a saved workflow by name from the workspace `.agents/workflows/` dir, VIA the
 * machine — so it resolves inside the sandbox workspace, never the host
 * filesystem (the model writes these with Write; it reads them back from the same
 * place). Tries `<name>`, `<name>.js`, `<name>.mjs`; returns null if none exist.
 */
async function readNamedWorkflow(machine: Machine, name: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) return null;
  for (const ext of ["", ".js", ".mjs"]) {
    try {
      const safePath = await resolveToolPath(`${WORKFLOW_DIR}/${name}${ext}`, machine, "read");
      return await readTextFile(machine, safePath);
    } catch {
      // not found / not this extension — try the next
    }
  }
  return null;
}

function errResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function renderWorkflowProgress(event: WorkflowProgressEvent): string {
  if (event.type === "started") return `▸ workflow: ${event.name}`;
  if (event.type === "phase") return `▸ phase: ${event.title}`;
  if (event.type === "log") return event.message;
  if (event.type === "outcome") return `${event.ok ? "✓" : "✗"} workflow ${event.status}${event.error ? `: ${event.error}` : ""}`;
  const r = event.record;
  if (r.state === "queued") return `… [${r.index}] ${r.label}${r.phase ? ` (${r.phase})` : ""}`;
  if (r.state === "running") return `→ [${r.index}] ${r.label}${r.phase ? ` (${r.phase})` : ""}`;
  if (r.state === "error") return `✗ [${r.index}] ${r.label}: ${r.error ?? ""}`;
  return `✓ [${r.index}] ${r.label}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

