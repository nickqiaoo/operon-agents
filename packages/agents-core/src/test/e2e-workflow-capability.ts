/**
 * Workflow discovery test — a BACKGROUND workflow run is a task, discoverable through
 * session.listWorkflows()/getWorkflow() and the /workflows command, sourced from the durable
 * task store (not a conversation fold). A FOREGROUND workflow is a plain Workflow tool call —
 * its record is the conversation plus its journal shard — so it is NOT listed (its shard stays
 * resumable by runId), mirroring how foreground subagents are handled.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  backgroundCapability,
  createExtensionCommandRegistry,
  DiskSessionStore,
  defineAgent,
  defineModel,
  DiskBackgroundTaskPersistence,
  Runner,
  Session,
  WorkflowManager,
  workflowCapability,
  type PersistedTask,
  type WorkflowSnapshot,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, extra = ""): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label} ${extra}`);
}

/** A completed background workflow run a prior process persisted. */
function backgroundWorkflowTask(runId: string): PersistedTask {
  const now = Date.now();
  return {
    schemaVersion: 2,
    revision: 1,
    taskId: `workflow-${runId}`,
    kind: "workflow",
    description: "nightly workflow",
    status: "completed",
    startedAt: now - 1000,
    endedAt: now,
    workflowName: "nightly",
    runId,
    runStatus: "completed",
    outputRef: { kind: "workflow-run", address: `workflow:${runId}` },
  };
}


/**
 * A run's journal is the whole record: replaying needs nothing else.
 *
 * The two inputs a replay depends on are the script and the args, and before this the script
 * lived only in the workspace — a file the model may have edited, that the next run of the
 * same workflow overwrote (it was named per workflow, not per run), and that does not exist
 * at all on a rebuilt sandbox. Since journal keys are chained hashes over each agent's prompt,
 * replaying against a DIFFERENT script does not fail; it misses every cache entry and re-runs
 * the entire workflow for real. So the script is recorded, and `resumeFromRunId` alone — no
 * script, no path, no name — is enough.
 */
async function testJournalIsSelfContained(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wf-journal-"));
  try {
    const store = new DiskSessionStore(dir, "s-journal");
    const manager = new WorkflowManager(store);
    const SOURCE = [
      "export const meta = { name: 'recorded', description: 'x' }",
      "return { answer: 7 }",
    ].join("\n");

    const journal = manager.newJournal("run-abc");
    await journal.load();
    await journal.recordRun("recorded", SOURCE, { seed: 1 });
    await journal.recordPhase(1, "Scan", "normal");
    await journal.recordStarted("k1", "agent-1", { address: "main/agent-1", index: 0, label: "scan:a", phase: "Scan" });
    await journal.recordResult("k1", "agent-1", { found: 3 }, { address: "main/agent-1", index: 0, label: "scan:a", phase: "Scan" });
    await journal.recordError("k2", "agent-2", "boom", { address: "main/agent-2", index: 1, label: "scan:b", phase: "Scan" });
    await journal.recordLog("2 of 3 done");
    await journal.recordOutcome({ status: "completed", ok: true, result: { answer: 7 }, failures: ["scan:b"], agentCount: 2 });
    await store.flush?.();

    // A fresh process: new store handle, new manager, nothing carried in memory.
    const reopened = new WorkflowManager(new DiskSessionStore(dir, "s-journal"));
    const replay = reopened.newJournal("run-abc");
    await replay.load();

    check("journal: the exact source is recoverable for a replay", replay.recordedScript() === SOURCE);
    check("journal: cached agent results survive the process", replay.getResult("k1")?.result !== undefined);
    check("journal: cached agent identity keeps its conversation address", replay.getResult("k1")?.address === "main/agent-1");
    check("journal: the outcome survives too, so reading it needs no replay", replay.outcome()?.ok === true);
    const events = replay.readEvents();
    check("journal: a failed step left a trace", events.some((e) => e.type === "error" && e.error === "boom"));
    check("journal: the script's own narration is there", events.some((e) => e.type === "log" && e.message === "2 of 3 done"));
    check("journal: agent entries carry the labels a reader recognises", events.some((e) => e.type === "result" && e.label === "scan:a" && e.phase === "Scan"));
    check("journal: entries are timestamped by the store", events.every((e) => e.type === "run" || typeof e.time === "number"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testJournalIsSelfContained();
  const root = mkdtempSync(join(tmpdir(), "wf-cap-"));
  try {
    const sessionDir = join(root, "s");
    const store = new DiskSessionStore(sessionDir);

    // A prior background run persisted its record; reopening should surface it. Disk sessions
    // keep the task store under `<sessionDir>/tasks/`, so seed through the matching backend.
    await new DiskBackgroundTaskPersistence(sessionDir).writeTask(backgroundWorkflowTask("bg-run-1"));

    const manager = new WorkflowManager();
    const session = await Session.open({ store, capabilities: [workflowCapability(manager), backgroundCapability()] });
    const runner = new Runner({});
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    const worker = defineAgent({ name: "worker", model, instructions: "Do the task." });
    const mainAgent = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [worker] });

    // ── The service is exposed on the session (like session.goal / session.background) ──
    check("session.workflow service is present", session.workflow !== undefined);
    check("session.workflow is the injected manager", session.workflow === manager);

    // ── A foreground workflow run is a plain tool call: it completes but is NOT listed ──
    const script = [
      "export const meta = { name: 'demo', description: 'demo workflow' }",
      "const x = await agent('do the thing', { label: 'w' })",
      "return { x }",
    ].join("\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Workflow", { script }), { stopReason: "toolUse" }),
      fauxAssistantMessage("WORKER-OK", { stopReason: "stop" }),
      fauxAssistantMessage("workflow done", { stopReason: "stop" }),
    ]);
    const r = await runner.run(mainAgent, "run the demo workflow", { session });
    faux.unregister();
    check("foreground workflow run completes", r.status === "completed", r.status);

    // ── Discovery: only the BACKGROUND run is listed, from the task store ──
    const runs = await session.listWorkflows();
    check("session.listWorkflows() returns only the background run", runs.length === 1, String(runs.length));
    const run: WorkflowSnapshot | undefined = runs[0];
    check("background run recorded as completed", run?.status === "completed", JSON.stringify(run?.status));
    check("background run carries name + timestamps", run?.workflowName === "nightly" && run?.startedAt !== undefined && run?.endedAt !== undefined, JSON.stringify({ n: run?.workflowName, s: run?.startedAt, e: run?.endedAt }));
    check("foreground run is not listed", !runs.some((w) => w.workflowName === "demo"));

    const byId = run ? await session.getWorkflow(run.runId) : undefined;
    check("session.getWorkflow(runId) round-trips", byId?.runId === run?.runId, JSON.stringify(byId?.runId));

    // ── The /workflows user command consumes the same store-backed listing ──
    const commands = createExtensionCommandRegistry();
    const listed = await commands.run("/workflows", { session });
    check("/workflows lists the background run", listed.ok && Array.isArray(listed.data) && (listed.data as unknown[]).length === 1, JSON.stringify(listed.message));
    const info = run ? await commands.run(`/workflows info ${run.runId}`, { session }) : { ok: false };
    check("/workflows info <runId> resolves the run", info.ok === true, JSON.stringify(info));
    const missing = await commands.run("/workflows info nope-xxx", { session });
    check("/workflows info <unknown> reports not found", missing.ok === false);

    await session.close();

    const failed = checks.filter(([, ok]) => !ok);
    console.log(`\n${failed.length === 0 ? "ALL PASS" : "FAILURES"}: ${checks.length - failed.length}/${checks.length}`);
    if (failed.length > 0) process.exit(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
