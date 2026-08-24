/**
 * The one injection seam for peer persistence: the host hands `PeerNetwork` a repo, the repo
 * decides where things live (memory, files, PG, Redis, …).
 *
 * Why an OPERATION-level interface and not key/value: with get/put the caller must read-modify-
 * write, and no backend can make that safe. Defined by intent — `enqueue`, `settle`, `put`,
 * `add` — every backend can make each single call atomic with its own primitives (a transaction,
 * a list op, an increment). The contract, stated once here and relied on everywhere: **each
 * method is atomic in the backend; no caller ever does a cross-call read-modify-write.** That is
 * why sharing one repo between processes cannot corrupt it.
 *
 * What each facet persists is exactly what only peers knows:
 * - `mailbox` — messages in flight. The only facet that protects CORRECTNESS: a crash between
 *   routing and consumption loses the message without it.
 * - `cards` — team labels + the type/description card. Invented at runtime, recorded nowhere
 *   else; without them a restart leaves parked teammates undiscoverable, hence unwakeable.
 * - `stats` — fleet accounting. Memory by default, deliberately: persisting the budget ledger
 *   forces reset semantics only the host can decide (see `MemoryPeerStatsStore`).
 */
import { MemoryPeerCardStore, type PeerCardStore } from "./directory.ts";
import { MemoryPeerMailbox, type PeerMailbox } from "./mailbox.ts";
import { MemoryPeerStatsStore, type PeerStatsStore } from "./stats.ts";

export interface PeerRepo {
  readonly mailbox: PeerMailbox;
  readonly cards: PeerCardStore;
  readonly stats: PeerStatsStore;
}

/** Everything in memory: routes fine in one process, remembers nothing across a restart. */
export function createMemoryPeerRepo(): PeerRepo {
  return { mailbox: new MemoryPeerMailbox(), cards: new MemoryPeerCardStore(), stats: new MemoryPeerStatsStore() };
}
