import type { ToolResultMessage } from "../protocol/index.ts";
import type { AgentRecord, SessionStore } from "../store/index.ts";

// Capability state lives in the linear session log, not in a side channel: a stateful capability
// writes its state snapshot into the `details` of the tool result that changed it, and rebuilds
// its in-memory state by folding the shard's records on session open. This keeps the state
// durable across resume and, because a fork copies the log, correct after a fork.

/** The whole linear log in append order, or [] when there is no store / empty session. */
export async function readLog(store: SessionStore | undefined): Promise<AgentRecord[]> {
  if (store === undefined) return [];
  const records: AgentRecord[] = [];
  for await (const record of store.readRecords()) records.push(record);
  return records;
}

/** The session's records for a capability's `openSession`: prefers the memoized `logRecords`
 *  the session shares across capabilities (one read for goal/plan/todo + the context replay),
 *  falling back to a direct `readLog` when it is absent (e.g. a test-constructed context). */
export function readSessionLog(ctx: {
  readonly store?: SessionStore;
  readonly logRecords?: () => Promise<readonly AgentRecord[]>;
}): Promise<readonly AgentRecord[]> {
  return ctx.logRecords !== undefined ? ctx.logRecords() : readLog(ctx.store);
}

/** Tool-result messages for `toolName` in the log, in append order. */
function toolResultsInLog(records: readonly AgentRecord[], toolName: string): ToolResultMessage[] {
  const out: ToolResultMessage[] = [];
  for (const record of records) {
    if (record.type !== "context.append_message") continue;
    const msg = record.message;
    if (msg.role === "toolResult" && msg.toolName === toolName) out.push(msg);
  }
  return out;
}

/** The `details` of the latest tool result for `toolName` in the log, or undefined. */
export function latestToolDetails(records: readonly AgentRecord[], toolName: string): unknown {
  const results = toolResultsInLog(records, toolName);
  return results.length === 0 ? undefined : results[results.length - 1]!.details;
}
