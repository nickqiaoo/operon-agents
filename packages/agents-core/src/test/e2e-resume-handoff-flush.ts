import { testRunner, openTestSession } from "./faux.ts";
/**
 * Regression test for Runner.resume()'s finally block flushing the WRONG context.
 *
 * Bug: resume() replays the interrupted root frame's context once, up front, and its
 * `finally` used to flush that SAME local `context` variable unconditionally. But if the
 * resumed run performs a handoff, the engine re-points `state.address` (and the session's
 * live context) at a brand-new shard, and everything the target agent does after the
 * handoff is journaled there — not on the original `context`. The old finally never
 * awaited that shard's writes, so resume() could return while the target agent's final
 * turn was still mid-flush: a caller reading the session back immediately after resume()
 * resolved could see a torn/incomplete post-handoff shard.
 *
 * Reproduced deterministically (no flaky timing race) with a store that delays appendRecord
 * for any non-root shard: with the fix, resume() awaits the *live* context for the run's
 * final address, so the delayed write is always visible by the time resume() returns;
 * with the old bug it flushed the original (now-irrelevant) root context instead, whose
 * write chain was already empty, so resume() would return before the delayed write lands.
 */
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  defineAgent,
  defineModel,
  defineTool,
  getInterruptionState,
  handoff,
  MemoryStore,
  Runner,
  type AgentRecord,
  type SessionStore,
  type ReadRecordPageOptions,
  type ReadRecordsFilter,
  type RecordPage,
  type StateKey,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Delays appendRecord for any shard other than the root ("main") — i.e. exactly the
 *  post-handoff shard in this test — to make the flush race deterministic. */
class DelayingStore implements SessionStore {
  private readonly inner: SessionStore;
  private readonly delayMs: number;

  constructor(inner: SessionStore, delayMs: number) {
    this.inner = inner;
    this.delayMs = delayMs;
  }

  async appendRecord(record: AgentRecord): Promise<string> {
    if (record.address !== "main") await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.appendRecord(record);
  }
  readRecords(filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    return this.inner.readRecords(filter);
  }
  readRecordPage(options: ReadRecordPageOptions): Promise<RecordPage> {
    return this.inner.readRecordPage(options);
  }
  putState(key: StateKey, value: unknown): Promise<void> {
    return this.inner.putState(key, value);
  }
  getState(key: StateKey): Promise<unknown | null> {
    return this.inner.getState(key);
  }
  deleteState(key: StateKey): Promise<void> {
    return this.inner.deleteState(key);
  }
}

function suspendOnceTool(fired: { value: boolean }) {
  return defineTool({
    name: "pause",
    description: "pause once",
    params: z.object({}),
    resolve: () => ({
      approvalRule: "pause",
      run: async (ctx) => {
        if (ctx.resumed) return { content: [{ type: "text", text: "resumed" }] };
        fired.value = true;
        ctx.suspend({ display: { title: "pause" } });
      },
    }),
  });
}

async function main(): Promise<void> {
  const fired = { value: false };
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  const closer = defineAgent({ name: "closer", model, instructions: "Close out the conversation." });
  const router = defineAgent({
    name: "router",
    model,
    instructions: "Pause, then hand off to closer.",
    tools: [suspendOnceTool(fired)],
    handoffs: [handoff(closer)],
  });

  const inner = new MemoryStore();
  const store = new DelayingStore(inner, 40);
  const runner = testRunner({ store, permission: { mode: "yolo" } });

  faux.setResponses([fauxAssistantMessage(fauxToolCall("pause", {}), { stopReason: "toolUse" })]);
  const first = await runner.run(router, "start");
  check("setup: first run interrupts on the suspend tool", first.status === "interrupted" && fired.value);
  const persisted = first.interruptions;
  check("setup: interruption payload present", persisted !== undefined && persisted.length > 0);

  // On resume: router hands off to closer, then closer produces its final turn — that
  // final assistant message is what lands in the delayed (non-"main") shard.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("transfer_to_closer", { reason: "done here" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("closer says goodbye", { stopReason: "stop" }),
  ]);

  const interruption = getInterruptionState(first)!;
  const pendingId = first.interruptions![0]!.approvalId;

  const second = await runner.resume(router, { interruption: interruption, answers: { [pendingId]: { kind: "input", data: {} } } });
  faux.unregister();

  check("resume: run completes after the handoff", second.status === "completed");
  check("resume: final agent is the handoff target", second.finalAgent === "closer");

  // The critical assertion: right after resume() resolves (no extra awaits), the
  // post-handoff shard's final message must already be durably visible in the store.
  const handoffAddress = Object.keys(await dumpAllAddresses(inner)).find((addr) => addr !== "main" && addr.startsWith("h_"));
  check("resume: a post-handoff shard was created", handoffAddress !== undefined);
  const records: AgentRecord[] = [];
  if (handoffAddress) for await (const r of inner.readRecords({ address: handoffAddress })) records.push(r);
  const hasFinalMessage = records.some(
    (r) => r.type === "context.append_message" && r.message.content.some((c) => c.type === "text" && c.text.includes("closer says goodbye")),
  );
  check("resume: post-handoff shard's final turn IS flushed by the time resume() returns (the bug this guards)", hasFinalMessage);

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — resume() flushes the live post-handoff shard, not the stale root context");
}

async function dumpAllAddresses(store: MemoryStore): Promise<Record<string, true>> {
  const addresses: Record<string, true> = {};
  for await (const r of store.readRecords()) addresses[r.address] = true;
  return addresses;
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
