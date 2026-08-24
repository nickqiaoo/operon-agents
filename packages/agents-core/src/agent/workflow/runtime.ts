/**
 * Workflow runtime — builds the in-script hooks (agent/parallel/pipeline/phase/
 * log/budget/workflow) and runs the compiled script in a hardened VM. `agent()`
 * runs through the host — this framework's subagent runner.
 *
 * Design points worth knowing:
 *  - structured output is enforced by the HOST (StructuredOutput tool), so the
 *    runtime just trusts hooks.runAgent to return a parsed value when a schema
 *    is set — no fragile text-JSON parsing here;
 *  - budget is REAL: hooks.runAgent reports output tokens and the host's
 *    getTurnSpent() reads live usage, so spent()/remaining() are not stubs;
 *  - parallel()/pipeline() enforce the 4096-items-per-call cap.
 */

import { compileScriptBody, createSandboxContext, harden, runCompiled } from "./sandbox.ts";
import { Semaphore } from "../concurrency.ts";
import type { WorkflowJournal } from "./journal.ts";
import {
  WORKFLOW_AGENT_CAP,
  WORKFLOW_MAX_ITEMS_PER_CALL,
  type AgentHookOptions,
  type WorkflowAgentIdentity,
  type WorkflowAgentRunResult,
  type WorkflowHostHooks,
  type WorkflowMeta,
} from "./types.ts";

export class WorkflowAgentCapError extends Error {
  constructor() {
    super(
      `Workflow agent() call cap reached (${WORKFLOW_AGENT_CAP}). This usually means a loop using ` +
        "budget.remaining() never terminates because no token budget was set — remaining() returns " +
        "Infinity when budget.total is null. Add a hard iteration cap, or pass a token budget.",
    );
    this.name = "WorkflowAgentCapError";
  }
}

export class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). ` +
        "Stopping further agent() calls. In-flight agents will complete; their results are preserved.",
    );
    this.name = "WorkflowBudgetExceededError";
  }
}

/**
 * Thrown by every hook when the workflow is aborted. There is no external VM
 * teardown here, so abort must unwind the script by throwing
 * rather than by stalling — otherwise a script that continues past a parallel()
 * would hang forever. `name` is "AbortError" so the host's isAbortError() treats a
 * backgrounded run as "killed" instead of "failed".
 */
export class WorkflowAbortedError extends Error {
  constructor() {
    super("Workflow aborted.");
    this.name = "AbortError";
  }
}

interface RunWorkflowParams {
  meta: WorkflowMeta;
  scriptBody: string;
  args: unknown;
  hooks: WorkflowHostHooks;
  journal: WorkflowJournal;
  /** Depth guard for nested workflow() calls. */
  depth?: number;
  /**
   * Resume chain state, SHARED across nested workflow() calls (a child
   * continues the parent's key chain rather than resetting it). `prevKey` rolls per
   * agent() in execution order; `diverged` latches true on the first cache miss so
   * everything after the first changed/new/interrupted call re-runs (prefix model).
   */
  chain?: { prevKey: string; diverged: boolean };
}

export type RunWorkflowResult =
  | { ok: true; result: unknown; failures: string[]; agentCount: number }
  | { ok: false; error: string; failures: string[]; agentCount: number };

export async function runWorkflow(params: RunWorkflowParams): Promise<RunWorkflowResult> {
  const { meta, scriptBody, args, hooks, journal } = params;
  const depth = params.depth ?? 0;
  // Resume chain — created at the root, shared into nested workflows.
  const chain = params.chain ?? { prevKey: "", diverged: false };

  const compiled = compileScriptBody(scriptBody);
  if (!compiled.ok) {
    return { ok: false, error: compiled.error, failures: [], agentCount: 0 };
  }

  const failures: string[] = [];
  const semaphore = new Semaphore(Math.max(1, hooks.concurrency));

  let agentCount = 0;
  let localSpent = 0;
  let capExceeded = false;
  let budgetExceeded = false;

  const aborted = (): boolean => hooks.abortSignal.aborted;

  const budgetTotal = hooks.budget.total;
  const spent = (): number => hooks.budget.getTurnSpent() + localSpent;
  const remaining = (): number =>
    budgetTotal == null ? Number.POSITIVE_INFINITY : Math.max(0, budgetTotal - spent());
  const budgetExhausted = (): boolean => budgetTotal != null && budgetTotal > 0 && spent() >= budgetTotal;

  function checkCaps(): void {
    // Abort is checked first: there is no external VM teardown here, so every hook
    // turns an aborted signal into a thrown AbortError that unwinds the script.
    if (aborted()) throw new WorkflowAbortedError();
    if (agentCount >= WORKFLOW_AGENT_CAP) {
      capExceeded = true;
      throw new WorkflowAgentCapError();
    }
    if (budgetExhausted()) {
      budgetExceeded = true;
      throw new WorkflowBudgetExceededError(spent(), budgetTotal!);
    }
  }

  function assertItemCount(n: number, who: string): void {
    if (n > WORKFLOW_MAX_ITEMS_PER_CALL) {
      throw new RangeError(
        `${who}() accepts at most ${WORKFLOW_MAX_ITEMS_PER_CALL} items per call (got ${n}). ` +
          "Chunk the work, or loop in smaller batches.",
      );
    }
  }

  // ---- agent() ----------------------------------------------------------
  const agent = harden(async (promptArg: unknown, optsArg?: AgentHookOptions): Promise<unknown> => {
    checkCaps();

    const prompt = String(promptArg);
    const opts = optsArg ?? {};
    const index = ++agentCount;
    const label =
      (opts.label != null ? String(opts.label) : prompt.slice(0, 60).replace(/\s+/g, " ").trim()) ||
      `agent ${index}`;
    const phase = opts.phase != null ? String(opts.phase) : undefined;
    const recordBase = { index, label, ...(phase !== undefined ? { phase } : {}) };

    // Journal: chained key over (prevKey + prompt + opts), rolling in
    // execution order. `diverged` latches the prefix model — once one call misses,
    // every key after it changes too, so we stop consulting the cache entirely.
    const key = journal.keyFor(chain.prevKey, prompt, opts);
    chain.prevKey = key;
    const cached = chain.diverged ? undefined : journal.getResult(key);
    if (cached !== undefined) {
      // No journal write: a resume reuses the prior run's journal address, so this result is
      // already on record — re-appending it would grow the journal by a full copy per resume.
      hooks.emitProgress({
        type: "agent",
        record: {
          ...recordBase,
          ...(cached.agentId.length > 0 ? { agentId: cached.agentId } : {}),
          ...(cached.address !== undefined ? { address: cached.address } : {}),
          state: "done",
          resultPreview: previewOf(cached.result),
        },
      });
      return cached.result;
    }
    // First miss → diverge. If this key has a `started` marker but no result, the
    // agent was interrupted on a prior run; we re-run it (respawn) and say so.
    chain.diverged = true;
    if (journal.wasStarted(key)) {
      hooks.emitProgress({ type: "log", message: `↻ respawning interrupted agent [${label}]` });
      void journal.recordLog(`↻ respawning interrupted agent [${label}]`);
    }

    hooks.emitProgress({ type: "agent", record: { ...recordBase, state: "queued" } });
    void journal.recordQueued(key, recordBase);
    return semaphore.run(async () => {
      // Re-check once the slot is free: agents that completed while this one queued
      // have updated spent(), so a real budget ceiling stops further dispatch here
      // (in-flight agents still finish — overshoot is bounded by concurrency).
      if (aborted()) {
        hooks.emitProgress({ type: "agent", record: { ...recordBase, state: "error", error: "Workflow aborted before dispatch." } });
        await journal.recordError(key, "", "Workflow aborted before dispatch.", recordBase);
        throw new WorkflowAbortedError();
      }
      if (budgetExhausted()) {
        budgetExceeded = true;
        hooks.emitProgress({ type: "agent", record: { ...recordBase, state: "error", error: "Token budget exhausted before dispatch." } });
        await journal.recordError(key, "", "Token budget exhausted before dispatch.", recordBase);
        throw new WorkflowBudgetExceededError(spent(), budgetTotal!);
      }
      let identity: WorkflowAgentIdentity | undefined;
      let res: WorkflowAgentRunResult;
      try {
        res = await hooks.runAgent({
          index,
          prompt,
          label,
          phase,
          model: opts.model,
          agentType: opts.agentType,
          isolation: opts.isolation,
          schema: opts.schema,
          signal: hooks.abortSignal,
          // Marker written BEFORE the agent runs, so an interruption leaves a
          // `started`-without-`result` trail that the next resume can detect.
          onStart: (started) => {
            identity = started;
            void journal.recordStarted(key, started.agentId, {
              ...recordBase,
              address: started.address,
            });
            hooks.emitProgress({
              type: "agent",
              record: { ...recordBase, ...started, state: "running" },
            });
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        hooks.emitProgress({
          type: "agent",
          record: { ...recordBase, ...(identity ?? {}), state: "error", error: msg },
        });
        // Recorded, not just emitted: "which step broke" is the first question asked of a run
        // that came back empty, and progress events do not survive the process.
        await journal.recordError(key, identity?.agentId ?? "", msg, {
          ...recordBase,
          ...(identity !== undefined ? { address: identity.address } : {}),
        });
        throw new Error(`agent "${label}" failed: ${msg}`);
      }

      localSpent += res.outputTokens;
      await journal.recordResult(key, res.agentId, res.value, { ...recordBase, address: res.address });
      hooks.emitProgress({
        type: "agent",
        record: { ...recordBase, agentId: res.agentId, address: res.address, state: "done", resultPreview: previewOf(res.value) },
      });
      return res.value;
    });
  });

  // ---- parallel() -------------------------------------------------------
  const parallel = harden(async (thunks: unknown): Promise<unknown[]> => {
    checkCaps();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.length === 0) return [];
    assertItemCount(thunks.length, "parallel");
    for (const t of thunks) {
      if (typeof t !== "function") {
        throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
      }
    }
    const settled = await Promise.allSettled((thunks as (() => Promise<unknown>)[]).map((t) => t()));
    // Aborted mid-flight: propagate so the script unwinds instead of continuing
    // past the (now meaningless) results into another agent() that would throw.
    if (aborted()) throw new WorkflowAbortedError();
    return settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      if (r.reason instanceof WorkflowBudgetExceededError) return null;
      const msg = `parallel[${i}] failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
      failures.push(msg);
      hooks.emitProgress({ type: "log", message: msg });
      void journal.recordLog(msg);
      return null;
    });
  });

  // ---- pipeline() -------------------------------------------------------
  const pipeline = harden(async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
    checkCaps();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (items.length === 0) return [];
    assertItemCount(items.length, "pipeline");
    for (const s of stages) {
      if (typeof s !== "function") {
        throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
      }
    }
    const stageFns = stages as ((prev: unknown, item: unknown, index: number) => Promise<unknown>)[];
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stageFns) {
          if (value === null) break;
          value = await stage(value, item, index);
        }
        return value;
      }),
    );
    if (aborted()) throw new WorkflowAbortedError();
    return settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      if (r.reason instanceof WorkflowBudgetExceededError) return null;
      const msg = `pipeline[${i}] failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
      failures.push(msg);
      hooks.emitProgress({ type: "log", message: msg });
      void journal.recordLog(msg);
      return null;
    });
  });

  // ---- phase() / log() --------------------------------------------------
  let phaseIndex = 0;
  const seenPhases = new Map<string, number>();
  const resolvePhase = (title: string, kind: "normal" | "child" = "normal"): number => {
    let idx = seenPhases.get(title);
    if (idx == null) {
      idx = ++phaseIndex;
      seenPhases.set(title, idx);
      hooks.emitProgress({ type: "phase", index: idx, title, kind });
      void journal.recordPhase(idx, title, kind);
    }
    return idx;
  };
  // Seed declared phases up front.
  for (const p of meta.phases ?? []) resolvePhase(p.title);

  const phase = harden((title: unknown): void => {
    resolvePhase(String(title));
  });
  const log = harden((message: unknown): void => {
    const text = String(message);
    hooks.emitProgress({ type: "log", message: text });
    void journal.recordLog(text);
  });

  // ---- budget -----------------------------------------------------------
  const budget = {
    total: budgetTotal,
    spent: harden(() => spent()),
    remaining: harden(() => remaining()),
  };

  // ---- workflow() (nested, one level) -----------------------------------
  const workflowHook = harden(async (nameOrRef: unknown, childArgs?: unknown): Promise<unknown> => {
    checkCaps();
    if (depth >= 1) {
      throw new Error(
        "workflow() cannot be called from within a child workflow — nesting is limited to one level. " +
          "Inline the inner script or call its agents directly.",
      );
    }
    if (typeof nameOrRef !== "string") {
      throw new TypeError("workflow() expects a saved workflow name (string)");
    }
    if (!hooks.resolveWorkflowScript) {
      throw new Error(`workflow('${nameOrRef}'): named workflows are not available in this context`);
    }
    const script = await hooks.resolveWorkflowScript(nameOrRef);
    if (!script) throw new Error(`workflow('${nameOrRef}'): no workflow with that name`);
    const { parseWorkflow } = await import("./parse.ts");
    const parsed = parseWorkflow(script);
    if ("error" in parsed) throw new Error(`workflow('${nameOrRef}'): ${parsed.error}`);
    hooks.emitProgress({ type: "log", message: `▸ running nested workflow ${parsed.meta.name}` });
    void journal.recordLog(`▸ running nested workflow ${parsed.meta.name}`);
    const child = await runWorkflow({
      meta: parsed.meta,
      scriptBody: parsed.scriptBody,
      args: childArgs,
      hooks,
      journal,
      depth: depth + 1,
      // Share the chain: the child continues the parent's key chain,
      // so a nested workflow whose first agent() shares a prompt with the parent's
      // gets a DIFFERENT key (prevKey differs) and can't collide on the journal.
      chain,
    });
    if (!child.ok) throw new Error(`workflow('${nameOrRef}'): ${child.error}`);
    return child.result;
  });

  // ---- assemble globals + run ------------------------------------------
  const globals: Record<string, unknown> = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    workflow: workflowHook,
    budget,
    args,
    console: makeConsole(log),
  };

  const context = createSandboxContext(globals);

  try {
    const result = await runCompiled(compiled.vmScript, context);
    return { ok: true, result, failures, agentCount };
  } catch (err) {
    // Abort: there is no external VM teardown, so propagate (the host folds usage in
    // a finally, and a backgrounded run settles as "killed" via isAbortError).
    if (err instanceof WorkflowAbortedError || aborted()) throw new WorkflowAbortedError();
    if (capExceeded || budgetExceeded) {
      // Soft stop — return what we have; the error is informational.
      return { ok: true, result: undefined, failures: [...failures, errMsg(err)], agentCount };
    }
    return { ok: false, error: errMsg(err), failures, agentCount };
  }
}

function makeConsole(log: (msg: unknown) => void): Record<string, (...a: unknown[]) => void> {
  const fmt = (parts: unknown[]): string =>
    parts.map((p) => (typeof p === "string" ? p : safeStringify(p))).join(" ");
  return {
    log: (...a: unknown[]) => log(fmt(a)),
    info: (...a: unknown[]) => log(fmt(a)),
    debug: (...a: unknown[]) => log(fmt(a)),
    warn: (...a: unknown[]) => log(`[warn] ${fmt(a)}`),
    error: (...a: unknown[]) => log(`[error] ${fmt(a)}`),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function previewOf(value: unknown): string {
  const s = typeof value === "string" ? value : safeStringify(value);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
