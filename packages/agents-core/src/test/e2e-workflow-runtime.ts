/**
 * Runtime-level tests for the Workflow engine — the concurrency/abort/resume paths
 * the end-to-end tests don't reach. These drive `runWorkflow` directly with a mock
 * host (no Runner/LLM), so they can force exact behaviour:
 *   #1 abort unwinds the script instead of hanging (no external VM teardown here);
 *   #5 the token budget stops DISPATCH once a freed slot sees it exhausted;
 *   resume — chained/prefix: same run → 100% hit; an edit re-runs from
 *           the change onward; an interrupted agent (started-without-result) respawns;
 *   nested workflow() shares the parent's key chain (no journal collision);
 *   snapshots — the /workflows-style discovery records (write/list/read round-trip).
 */
import {
  parseWorkflow,
  runWorkflow,
  WorkflowJournal,
  type WorkflowAgentRunArgs,
  type WorkflowAgentRunResult,
  type WorkflowHostHooks,
  type WorkflowProgressEvent,
} from "../agent/workflow/index.ts";
import { MemoryStore } from "../store/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, extra = ""): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label} ${extra}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
function agentIdentity(agentId: string): { agentId: string; address: string } {
  return { agentId, address: `main/${agentId}` };
}

interface MockOpts {
  runAgent: (args: WorkflowAgentRunArgs) => Promise<WorkflowAgentRunResult>;
  abortSignal?: AbortSignal;
  total?: number | null;
  concurrency?: number;
  resolveWorkflowScript?: (name: string) => Promise<string | null>;
  onProgress?: (e: WorkflowProgressEvent) => void;
}
function hooks(o: MockOpts): WorkflowHostHooks {
  return {
    concurrency: o.concurrency ?? 8,
    abortSignal: o.abortSignal ?? new AbortController().signal,
    budget: { total: o.total ?? null, getTurnSpent: () => 0 },
    emitProgress: o.onProgress ?? (() => {}),
    resolveWorkflowScript: o.resolveWorkflowScript,
    runAgent: o.runAgent,
  };
}
async function run(script: string, o: MockOpts, journal: WorkflowJournal) {
  const parsed = parseWorkflow(script);
  if ("error" in parsed) throw new Error(`parse failed: ${parsed.error}`);
  return runWorkflow({ meta: parsed.meta, scriptBody: parsed.scriptBody, args: undefined, hooks: hooks(o), journal });
}

async function main(): Promise<void> {
  // Journals and snapshots persist through a SessionStore; one in-memory store per
  // scenario group reproduces the old shared-directory behaviour (per-run addresses).
  const root = new MemoryStore();
  {
    // ── #1 abort: a script that continues PAST a parallel() must not hang ──────
    {
      const controller = new AbortController();
      const script = [
        "export const meta = { name: 'abort', description: 'x' }",
        "await parallel([() => agent('x'), () => agent('y')])",
        "await agent('z')", // pre-fix: hung here forever after the parallel swallowed the abort
        "return 'done'",
      ].join("\n");
      const runAgent = ({ signal }: WorkflowAgentRunArgs): Promise<WorkflowAgentRunResult> =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      setTimeout(() => controller.abort(), 20);
      const journal = new WorkflowJournal("abort", root);
      const outcome = await Promise.race([
        run(script, { runAgent, abortSignal: controller.signal }, journal).then(
          () => "returned-ok",
          (e: unknown) => (e instanceof Error && e.name === "AbortError" ? "threw-abort" : `threw-${(e as Error)?.name}`),
        ),
        sleep(2000).then(() => "HANG"),
      ]);
      check("abort unwinds the workflow (no hang)", outcome === "threw-abort", outcome);
    }

    // ── #5 budget: dispatch stops once a freed slot sees the budget exhausted ──
    {
      let calls = 0;
      const script = [
        "export const meta = { name: 'budget', description: 'x' }",
        "return await parallel([() => agent('1'), () => agent('2'), () => agent('3'), () => agent('4')])",
      ].join("\n");
      const runAgent = async ({ prompt, onStart }: WorkflowAgentRunArgs): Promise<WorkflowAgentRunResult> => {
        calls++;
        const identity = agentIdentity(`id-${prompt}`);
        onStart(identity);
        await sleep(5);
        return { value: `ran-${calls}`, outputTokens: 100, ...identity };
      };
      const journal = new WorkflowJournal("budget", root);
      const res = await run(script, { runAgent, total: 100, concurrency: 1 }, journal);
      const results = (res.ok ? (res.result as unknown[]) : []) ?? [];
      check("budget: only the first agent ran", calls === 1, `calls=${calls}`);
      check("budget: over-budget agents resolve to null", JSON.stringify(results) === JSON.stringify(["ran-1", null, null, null]), JSON.stringify(results));
    }

    // ── progress identity: parallel orchestration records join exact child streams ──
    {
      const progress: WorkflowProgressEvent[] = [];
      const script = [
        "export const meta = { name: 'identity', description: 'x' }",
        "return await parallel([() => agent('A', { label: 'alpha' }), () => agent('B', { label: 'beta' })])",
      ].join("\n");
      const runAgent = async ({ prompt, onStart }: WorkflowAgentRunArgs): Promise<WorkflowAgentRunResult> => {
        const identity = agentIdentity(`id-${prompt}`);
        onStart(identity);
        await sleep(prompt === "A" ? 10 : 5);
        return { value: prompt, outputTokens: 1, ...identity };
      };
      const journal = new WorkflowJournal("identity", root);
      const result = await run(script, { runAgent, concurrency: 2, onProgress: (event) => progress.push(event) }, journal);
      const agents = progress.flatMap((event) => event.type === "agent" ? [event.record] : []);
      const alpha = agents.filter((record) => record.index === 1);
      const beta = agents.filter((record) => record.index === 2);
      const identityIsStable = (records: typeof agents): boolean => {
        const running = records.find((record) => record.state === "running");
        const done = records.find((record) => record.state === "done");
        return records[0]?.state === "queued" &&
          typeof running?.agentId === "string" &&
          typeof running.address === "string" &&
          done?.agentId === running.agentId &&
          done.address === running.address;
      };
      check("progress identity: parallel workflow completes", result.ok === true);
      check("progress identity: alpha transitions queued → running → done with one identity", identityIsStable(alpha));
      check("progress identity: beta transitions queued → running → done with one identity", identityIsStable(beta));
      check(
        "progress identity: parallel children have distinct join addresses",
        alpha.find((record) => record.state === "running")?.address !== beta.find((record) => record.state === "running")?.address,
      );
    }

    // ── resume: chained/prefix (sequential → deterministic order) ──
    {
      const seq = (extra = "") =>
        [
          "export const meta = { name: 'seq', description: 'x' }",
          "const a = await agent('A')",
          `const b = await agent('B${extra}')`,
          "const c = await agent('C')",
          "return [a, b, c]",
        ].join("\n");
      const make = () => {
        let calls = 0;
        return {
          runAgent: async ({ prompt, onStart }: WorkflowAgentRunArgs) => {
            calls++;
            const identity = agentIdentity(`id-${prompt}`);
            onStart(identity);
            return { value: prompt, outputTokens: 1, ...identity };
          },
          calls: () => calls,
        };
      };
      const id = "seq-run";
      const r1 = make();
      const j1 = new WorkflowJournal(id, root); await j1.load();
      await run(seq(), { runAgent: r1.runAgent }, j1);
      const r2 = make();
      const j2 = new WorkflowJournal(id, root); await j2.load();
      await run(seq(), { runAgent: r2.runAgent }, j2);
      const r3 = make();
      const j3 = new WorkflowJournal(id, root); await j3.load();
      await run(seq("2"), { runAgent: r3.runAgent }, j3); // edit B → B & C re-run, A cached

      check("resume: first run executed all 3", r1.calls() === 3, String(r1.calls()));
      check("resume: unchanged re-run is a 100% prefix hit (0 re-runs)", r2.calls() === 0, String(r2.calls()));
      check("resume: editing B re-runs B and C only (A cached)", r3.calls() === 2, String(r3.calls()));
    }

    // ── respawn: an interrupted agent (started, no result) re-runs on resume ───
    {
      const script = [
        "export const meta = { name: 'respawn', description: 'x' }",
        "const a = await agent('A')",
        "const b = await agent('B')",
        "const c = await agent('C')",
        "return [a, b, c]",
      ].join("\n");
      const id = "respawn-run";
      // Run 1: A completes; B marks started then "crashes" (no result); C never runs.
      const j1 = new WorkflowJournal(id, root); await j1.load();
      const run1 = await run(script, {
        runAgent: async ({ prompt, onStart }: WorkflowAgentRunArgs) => {
          const identity = agentIdentity(`id-${prompt}`);
          onStart(identity);
          if (prompt === "B") throw new Error("boom");
          return { value: prompt, outputTokens: 1, ...identity };
        },
      }, j1);
      check("respawn: interrupted run reports not-ok", run1.ok === false, JSON.stringify(run1));
      await sleep(50); // `started` markers are journaled fire-and-forget — let the append flush.

      // Run 2 (resume): A cached, B has a started-without-result → respawn + run; C runs.
      let calls = 0;
      const respawnLogs: string[] = [];
      const j2 = new WorkflowJournal(id, root); await j2.load();
      const run2 = await run(script, {
        runAgent: async ({ prompt, onStart }: WorkflowAgentRunArgs) => {
          calls++;
          const identity = agentIdentity(`id-${prompt}`);
          onStart(identity);
          return { value: prompt, outputTokens: 1, ...identity };
        },
        onProgress: (e) => { if (e.type === "log" && e.message.includes("respawning")) respawnLogs.push(e.message); },
      }, j2);
      check("respawn: resume re-runs exactly B and C (A cached)", calls === 2, String(calls));
      check("respawn: a respawn notice was emitted for the interrupted agent", respawnLogs.some((m) => m.includes("[B]")), JSON.stringify(respawnLogs));
      check("respawn: resumed run completes ok with full result", run2.ok === true && JSON.stringify(run2.result) === JSON.stringify(["A", "B", "C"]), JSON.stringify(run2));
    }

    // ── nested workflow(): child continues the parent's chain (no key collision) ─
    {
      let n = 0;
      const runAgent = async ({ onStart }: WorkflowAgentRunArgs): Promise<WorkflowAgentRunResult> => {
        n++;
        const identity = agentIdentity(`id-${n}`);
        onStart(identity);
        return { value: `call#${n}`, outputTokens: 1, ...identity };
      };
      const child = ["export const meta = { name: 'child', description: 'c' }", "return await agent('same')"].join("\n");
      const parent = [
        "export const meta = { name: 'parent', description: 'p' }",
        "const a = await agent('same')",
        "const b = await workflow('child')",
        "return { a, b }",
      ].join("\n");
      const journal = new WorkflowJournal("nested", root);
      const res = await run(parent, { runAgent, resolveWorkflowScript: async (name) => (name === "child" ? child : null) }, journal);
      const out = res.ok ? (res.result as { a: string; b: string }) : { a: "", b: "" };
      check("nested: parent agent ran first", out.a === "call#1", JSON.stringify(out));
      check("nested: child agent actually ran (shared chain → distinct key)", out.b === "call#2", JSON.stringify(out));
    }

  }


  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : "FAILURES"}: ${checks.length - failed.length}/${checks.length}`);
  if (failed.length > 0) process.exit(1);
}

await main();
