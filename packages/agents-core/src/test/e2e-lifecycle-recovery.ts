import assert from "node:assert/strict";
import {
  MemoryStore, MemorySessionLock, SessionBusyError, Session, Runner,
  closeOrphanedTurns, recoverOrphanedTurns, defineAgent,
  INTERRUPTION_STATE_KEY, type AgentRecord, type AgentEvent,
} from "../index.ts";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";

async function seed(store: MemoryStore): Promise<void> {
  for (const address of ["main", "main/child"]) {
    // Lifecycle preceding a checkpoint must still be recovered from its frame stamp.
    await store.appendRecord({ type: "context.replace", address, messages: [], checkpoint: {
      "#frame": { agent: "root", live: true, turn: { turnId: address, step: 1, toolCalls: [] }, pendingSteers: [] },
    } });
  }
}
async function records(store: MemoryStore): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const record of store.readRecords()) out.push(record);
  return out;
}

const store = new MemoryStore();
await seed(store);
const opened = await Session.open({ sessionId: "test", store });
assert.equal((await records(store)).filter((r) => r.type === "event.lifecycle").length, 0, "opening alone must never close another executor's turn");
await opened.close();
await store.putState(INTERRUPTION_STATE_KEY, { phase: "waiting" });
assert.deepEqual(await closeOrphanedTurns("test", store), [], "durable pauses are not orphans");
await store.deleteState(INTERRUPTION_STATE_KEY);
const events = await closeOrphanedTurns("test", store);
assert.equal(events.filter((e) => e.type === "turn.ended").length, 2);
assert.equal(events.filter((e) => e.type === "agent.ended").length, 2);
assert.deepEqual(await closeOrphanedTurns("test", store), [], "repeated recovery is idempotent");

// A partial recovery must remain repairable without duplicating committed closes.
class FailingStore extends MemoryStore {
  fail = false;
  override async appendRecord(record: AgentRecord): Promise<string> {
    if (this.fail && record.type === "event.lifecycle" && record.event.type === "agent.ended") {
      this.fail = false;
      throw new Error("write failed");
    }
    return super.appendRecord(record);
  }
}
const partial = new FailingStore();
await seed(partial);
partial.fail = true;
await assert.rejects(recoverOrphanedTurns("partial", partial), /write failed/);
await recoverOrphanedTurns("partial", partial);
assert.equal((await records(partial)).filter((r) => r.type === "event.lifecycle" && r.event.type === "turn.ended").length, 2);

// Both Runner entry points repair before their new turn, only after acquiring the lease.
for (const streaming of [false, true]) {
  const runStore = new MemoryStore();
  await seed(runStore);
  const lock = new MemorySessionLock();
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
  const agent = defineAgent({ name: "root", model: faux.getChatModel()!, instructions: "Answer." });
  const seen: AgentEvent[] = [];
  const session = await Session.open({ sessionId: "run", store: runStore, eventPublication: "durable" });
  session.events.subscribe((event) => { seen.push(event); });
  const runner = new Runner({ lock });
  const before = (await records(runStore)).length;
  const owner = (await lock.acquire("run"))!;
  await assert.rejects(runner.run(agent, "continue", { session }), SessionBusyError);
  assert.equal((await records(runStore)).length, before, "a rejected contender cannot repair");
  await owner.release();
  if (streaming) {
    const handle = runner.runStream(agent, "continue", { session });
    for await (const _event of handle) { /* drain */ }
    assert.equal((await handle.completed).status, "completed");
  } else {
    assert.equal((await runner.run(agent, "continue", { session })).status, "completed");
  }
  const repaired = seen.filter((event) => event.type === "turn.ended" && event.reason === "failed");
  assert.equal(repaired.length, 2, "core Runner publishes durable repair events");
  assert.ok(seen.indexOf(repaired[0]!) < seen.findIndex((event) => event.type === "turn.started"));
  for (const event of repaired) {
    assert.ok((await records(runStore)).some((record) => record.eventId === event.eventId));
  }
  await session.close();
}
console.log("Lifecycle recovery: checkpoint tails, pauses, idempotency, partial failure, opening, leases, run and runStream passed");
