import { randomBytes } from "node:crypto";
import type { SessionStore } from "../store/index.ts";

// `lost` is reconcile-only: a background subagent with no terminal status in the task store when a
// new process opens the session — its previous process died, so no live task is driving it.
// Terminal; resume by id.
export type SubagentStatus = "running" | "completed" | "error" | "paused" | "cancelled" | "lost";

/** One spawned background subagent, projected from its task-store record: `agentId` names the
 *  instance, `address` is its journal shard, `type` is the agent definition to re-run on resume. */
export interface SubagentRecord {
  readonly agentId: string;
  readonly type: string;
  readonly address: string;
  readonly description?: string;
  readonly background: boolean;
  /** The background task handle. */
  readonly taskId?: string;
  readonly createdAt: number;
  status: SubagentStatus;
  updatedAt: number;
}

/** The structured `details` an Agent tool result carries in the conversation — the human/model
 *  facing spawn record. Subagent lifecycle state itself now lives in the task store, not a fold. */
export interface AgentSpawnDetails {
  readonly agentId: string;
  readonly type: string;
  readonly status: SubagentStatus;
  readonly background?: boolean;
  readonly description?: string;
  readonly taskId?: string;
  readonly usage?: unknown;
}

/** A unique per-spawn id so two spawns of the same type get separate shards (and resume). */
export function newAgentId(type: string): string {
  const safe = type.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${safe}-${randomBytes(4).toString("hex")}`;
}

/**
 * Why a caller-chosen agent name is checked rather than sanitized: the name becomes the id
 * teammates address and `resume` looks up, so quietly rewriting it would leave the caller
 * holding a name that reaches nobody. `/` is barred because ids are address segments.
 *
 * Returns the reason it is unusable, or `undefined` when it is fine.
 */
export function invalidAgentName(name: string): string | undefined {
  if (name.length > 64) return `Agent name "${name}" is too long (max 64 characters).`;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return `Agent name "${name}" may only contain letters, digits, "_" and "-" — it is used as an address segment and as the id peers address you by.`;
  }
  return undefined;
}

// ── Subagent meta (address-keyed identity) ───────────────────────────────────────────────

/**
 * Audit-only meta record written to a subagent's own shard at spawn.
 *
 * This is what makes a shard self-describing: its agent type is recoverable from the shard
 * itself, with no fold over the parent conversation and no live registry. That is the whole
 * reason an agent at `main/<id>` can be started again by anyone holding the store — its
 * parent frame does not have to exist, let alone be running.
 */
export const SUBAGENT_META = "subagent_meta";

export interface SubagentMeta {
  readonly agentId: string;
  readonly type: string;
  readonly description?: string;
  readonly background: boolean;
  readonly parentAddress?: string;
  readonly parentToolCallId?: string;
}

export async function readSubagentMeta(store: SessionStore, address: string): Promise<SubagentMeta | undefined> {
  for await (const record of store.readRecords({ address })) {
    if (record.type !== "custom" || record.name !== SUBAGENT_META) continue;
    const data = record.data as Partial<SubagentMeta> | undefined;
    if (data !== undefined && typeof data.type === "string" && typeof data.agentId === "string") {
      return {
        agentId: data.agentId,
        type: data.type,
        description: data.description,
        background: data.background === true,
        parentAddress: data.parentAddress,
        parentToolCallId: data.parentToolCallId,
      };
    }
  }
  return undefined;
}
