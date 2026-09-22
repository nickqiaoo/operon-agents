import type { ToolResultMessage } from "../protocol/index.ts";
import { DEFAULT_ADDRESS, type AgentRecord, type SessionStore } from "../store/index.ts";

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

/**
 * The latest tool result `details` for `toolName`, PER JOURNAL SHARD.
 *
 * The log is linear but not single-owner: `main` and every `main/<agentId>` append to it, tagged
 * by `record.address`. State that belongs to a frame therefore folds per address — one agent's
 * last write is not another's. State that belongs to the session folds with
 * {@link latestToolDetails}, which reads the log as one stream. Which of the two applies is the
 * question in docs/state-and-lifetime.md; it is a property of the state, not of the log.
 */
export function latestToolDetailsByAddress(records: readonly AgentRecord[], toolName: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const record of records) {
    if (record.type !== "context.append_message") continue;
    const msg = record.message;
    if (msg.role === "toolResult" && msg.toolName === toolName) out.set(record.address ?? DEFAULT_ADDRESS, msg.details);
  }
  return out;
}

/** The `details` of the latest tool result for `toolName` in the log, or undefined. */
export function latestToolDetails(records: readonly AgentRecord[], toolName: string): unknown {
  const results = toolResultsInLog(records, toolName);
  return results.length === 0 ? undefined : results[results.length - 1]!.details;
}
