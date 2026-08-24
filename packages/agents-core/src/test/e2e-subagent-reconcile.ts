// On reopening a session, background subagents that were spawned but never settled (their process
// died) are reclassified as the terminal `lost` and surfaced. Subagent lifecycle now lives in the
// durable TASK STORE (not a fold over the conversation): a prior process wrote a PersistedTask per
// background subagent; reopening loads them and reconcile marks the non-terminal ones lost. A
// foreground subagent is a plain tool call — it never enters the task store, so it is not listed
// and never reconciled.
import { backgroundCapability, ListenerSink, MemoryStore, Session, StoreBackgroundTaskPersistence } from "../index.ts";
import type { AgentEvent, PersistedTask } from "../index.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** A background agent task record a prior process persisted. */
function agentTask(agentId: string, status: PersistedTask["status"]): PersistedTask {
  return {
    schemaVersion: 2,
    revision: 1,
    taskId: agentId,
    kind: "agent",
    description: `coder ${agentId}`,
    status,
    startedAt: Date.now(),
    endedAt: status === "running" ? null : Date.now(),
    agentId,
    subagentType: "coder",
    outputRef: { kind: "conversation", address: `main/${agentId}` },
  };
}

async function main(): Promise<void> {
  const store = new MemoryStore();
  // Seed the task store as a prior, now-dead process would have left it.
  const persistence = new StoreBackgroundTaskPersistence(store);
  await persistence.writeTask(agentTask("bg-1", "running")); // never settled → should reconcile to lost
  await persistence.writeTask(agentTask("bg-done", "completed")); // settled before the crash → untouched

  const sink = new ListenerSink();
  const events: AgentEvent[] = [];
  sink.subscribe((e) => {
    events.push(e);
  });
  const session = await Session.open({ store, events: sink, capabilities: [backgroundCapability()] });

  const listed = await session.listSubagents();
  check("store: both background subagents are listed", listed.length === 2);
  const preById = Object.fromEntries(listed.map((r) => [r.agentId, r]));
  check("store: unsettled background task loads as running", preById["bg-1"]!.status === "running");
  check("store: settled background task loads as completed", preById["bg-done"]!.status === "completed");
  check("store: address carried on the record", preById["bg-1"]!.address === "main/bg-1");

  const lost = await session.reconcileSubagents();
  check("reconcile: returns the orphaned background subagent", lost.length === 1 && lost[0]!.agentId === "bg-1" && lost[0]!.status === "lost");

  const byId = Object.fromEntries((await session.listSubagents()).map((r) => [r.agentId, r]));
  check("reconcile: orphaned background running → lost", byId["bg-1"]!.status === "lost");
  check("reconcile: already-settled record left untouched", byId["bg-done"]!.status === "completed");
  check("reconcile: emitted a warning naming the lost agent", events.some((e) => e.type === "warning" && String((e as { message?: unknown }).message).includes("bg-1")));
  check("reconcile: emitted a terminated event for the lost task", events.some((e) => e.type === "background.task.terminated"));
  check("reconcile: steered a lost notification (the durable settle record)", session.steer.hasItems());

  // Persisted back as terminal `lost`, so a later reopen has nothing running to reconcile.
  const persistedAfter = await persistence.readTask("bg-1");
  check("reconcile: lost status persisted back to the store", persistedAfter?.status === "lost");
  const again = await session.reconcileSubagents();
  check("reconcile: idempotent — nothing running left to reconcile", again.length === 0);

  await session.close();

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ SUBAGENT-RECONCILE E2E FAIL");
    process.exit(1);
  }
  console.log("✅ SUBAGENT-RECONCILE E2E PASS — task store loads prior background subagents; orphans → lost; persisted back; idempotent");
}

main().catch((error) => {
  console.error("❌ SUBAGENT-RECONCILE E2E ERROR:", error);
  process.exit(1);
});
