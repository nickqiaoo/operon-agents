/**
 * Unit-style coverage for ConversationContext's write chain (loop/context.ts).
 *
 * Regression test for a bug where a single failed `store.appendRecord` permanently
 * poisoned `writeChain` into a rejected promise: every later `journal()` call chained
 * `.then(onFulfilled)` with no `onRejected` onto it, so `onFulfilled` (the actual
 * `store.appendRecord(record)` call) never ran again — later records were silently
 * never even attempted, and every future `flush()` re-threw the same stale error forever.
 */
import type { AgentRecord, ReadRecordPageOptions, ReadRecordsFilter, RecordPage, SessionStore, StateKey } from "../store/store.ts";
import { ConversationContext } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

class FlakyStore implements SessionStore {
  readonly appended: AgentRecord[] = [];
  readonly failOnData = new Set<number>();

  async appendRecord(record: AgentRecord): Promise<string> {
    if (record.type === "custom" && typeof record.data === "object" && record.data !== null) {
      const n = (record.data as { n?: number }).n;
      if (n !== undefined && this.failOnData.has(n)) {
        throw new Error(`simulated store failure for record #${String(n)}`);
      }
    }
    this.appended.push(record);
    return String(this.appended.length);
  }

  async *readRecords(_filter?: ReadRecordsFilter): AsyncIterable<AgentRecord> {
    return;
  }
  async readRecordPage(_options: ReadRecordPageOptions): Promise<RecordPage> {
    return { data: [] };
  }
  async putState(_key: StateKey, _value: unknown): Promise<void> {}
  async getState(_key: StateKey): Promise<unknown | null> {
    return null;
  }
  async deleteState(_key: StateKey): Promise<void> {}
}

function customData(n: number): { data: { n: number } } {
  return { data: { n } };
}

async function main(): Promise<void> {
  const store = new FlakyStore();
  const ctx = new ConversationContext({ store, address: "main" });

  // Record #1 will fail. Record #2 is journaled in the SAME synchronous tick, before
  // flush() is ever awaited — this is exactly the case that used to get silently dropped.
  store.failOnData.add(1);
  ctx.record({ type: "custom", name: "test", ...customData(1) });
  ctx.record({ type: "custom", name: "test", ...customData(2) });

  let flushThrew = false;
  try {
    await ctx.flush();
  } catch {
    flushThrew = true;
  }
  check("flush() surfaces the failure instead of hanging or silently succeeding", flushThrew);
  check(
    "record #2 was still attempted despite record #1 failing first (no permanent chain poisoning)",
    store.appended.some((r) => r.type === "custom" && (r.data as { n: number }).n === 2),
  );

  // The chain must keep working after a failure — not stay poisoned forever.
  store.failOnData.delete(1);
  ctx.record({ type: "custom", name: "test", ...customData(3) });
  let secondFlushThrew = false;
  try {
    await ctx.flush();
  } catch {
    secondFlushThrew = true;
  }
  check("flush() does not re-throw a stale error once the underlying issue is gone", !secondFlushThrew);
  check(
    "record #3 (written after recovery) was persisted",
    store.appended.some((r) => r.type === "custom" && (r.data as { n: number }).n === 3),
  );

  // A later independent failure should be reported once, then clear again.
  store.failOnData.add(4);
  ctx.record({ type: "custom", name: "test", ...customData(4) });
  ctx.record({ type: "custom", name: "test", ...customData(5) });
  let thirdFlushThrew = false;
  try {
    await ctx.flush();
  } catch {
    thirdFlushThrew = true;
  }
  check("a second, later failure is reported on its own flush()", thirdFlushThrew);
  check(
    "record #5 (after the second failure) was still attempted",
    store.appended.some((r) => r.type === "custom" && (r.data as { n: number }).n === 5),
  );
  let fourthFlushThrew = false;
  try {
    await ctx.flush();
  } catch {
    fourthFlushThrew = true;
  }
  check("flush() is clean again once errors have been drained by a prior flush()", !fourthFlushThrew);

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — ConversationContext write-chain failure isolation");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
