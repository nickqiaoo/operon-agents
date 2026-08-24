/**
 * Peer discovery and messaging between agents — built entirely on public seams, with nothing in
 * the engine. See this package's README.
 *
 * One definition, two channels. `peers(config)` is an ordinary `ExtensionDefinition` (with a
 * `create` half): the server passes it by value, a desktop loads the same thing from a bundle.
 *
 * ```ts
 * const harness = createHarness({
 *   extensions: [peers({
 *     visibility: sharedLabelVisibility,
 *     teammates: { coder: { title: "coder" } },   // what a `coder` teammate is born as
 *   })],
 * });
 * const lead = await harness.createSession();
 * // The lead's agent can `Team create` + `Team spawn`; teammates talk over `Hub`.
 * ```
 *
 * There is no team object: membership is a label on the roster, and a teammate is a session the
 * extension's `create` half spawned. Capability follows birth — an ordinary session holds `Team`
 * (form and run its own team), a spawned teammate holds only `Hub` (general peer messaging), and
 * never `Team`: it is a member, not a team-former. `setup` reaches the network only through the
 * shared handle, which is what lets a reload swap the network under live sessions.
 */
export { PeerNetwork, createPeerNetwork, peers, mountTeam, mountHub, PEER_SOURCE, PEERS_SERVICE } from "./network.ts";
export type { PeerNetworkHandle } from "./network.ts";
export type {
  PeerExtensionOptions,
  PeerMemberOptions,
  PeerNetworkOptions,
  PeerOptions,
  PeerParams,
  PeerReceipt,
  TeamCaller,
  TeammateFactory,
  TeammateSessionOptions,
  TeammateSpawnRequest,
} from "./network.ts";

export { MemoryPeerStatsStore, UsageDiff, budgetExceeded } from "./stats.ts";
export type { PeerAgentStats, PeerBudget, PeerCounters, PeerFleetStats, PeerStatsStore } from "./stats.ts";

export { MemoryAgentDirectory, MemoryPeerCardStore, anyOf, sameSessionVisibility, sharedLabelVisibility } from "./directory.ts";
export type { AgentDirectory, AgentListFilter, AgentRef, AgentRefKind, AgentRefStatus, PeerCard, PeerCardStore, Visibility } from "./directory.ts";

export { MemoryPeerMailbox } from "./mailbox.ts";
export type { PeerLimits, PeerMailbox, PeerMessage } from "./mailbox.ts";

export { createMemoryPeerRepo } from "./repo.ts";
export type { PeerRepo } from "./repo.ts";
export { createFilePeerRepo } from "./file-repo.ts";

export { buildTeamTool } from "./team-tool.ts";
export { buildMemberTool } from "./member-tool.ts";
