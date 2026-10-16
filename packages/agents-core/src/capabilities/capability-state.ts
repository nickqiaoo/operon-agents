import type { AgentRecord, SessionStore } from "../store/index.ts";

// Capability state is NOT read from the log: a stateful capability keeps its current value in the
// store's key/value side and restores from it (see `CapabilityDurableState`). The log holds what
// the model saw. These readers are for a capability that genuinely wants that history.

/** The whole linear log in append order, or [] when there is no store / empty session. */
export async function readLog(store: SessionStore | undefined): Promise<AgentRecord[]> {
  if (store === undefined) return [];
  const records: AgentRecord[] = [];
  for await (const record of store.readRecords()) records.push(record);
  return records;
}

/** The session's whole log for a capability that needs history from before the newest
 *  checkpoint: prefers the memoized `logRecords` the session shares across capabilities,
 *  falling back to a direct `readLog` when it is absent (e.g. a test-constructed context). */
export function readSessionLog(ctx: {
  readonly store?: SessionStore;
  readonly logRecords?: () => Promise<readonly AgentRecord[]>;
}): Promise<readonly AgentRecord[]> {
  return ctx.logRecords !== undefined ? ctx.logRecords() : readLog(ctx.store);
}
