/**
 * The coordinator: an explicit roster plus routing on top of `steerTo`.
 *
 * Nothing here is in the engine. The whole thing rests on four public seams:
 *   - `api.onEvent` — root-frame lifecycle says who is awake, asleep, or gone
 *   - `api.registerTool` — the `Team` tool (creators) and the `Hub` tool (members)
 *   - `actions.openSession` — reach another session (reopening it if it was closed)
 *   - `handle.steerTo(address, …)` — hand a message to one specific frame
 *
 * TWO ROLES, TWO TOOLS, both fixed at birth (a toolset never changes mid-conversation):
 *
 * - An ordinary agent gets the `Team` tool: it can FORM a team and SPAWN teammates, and its
 *   `send` reaches only members of teams it created (scope IS the permission — no visibility
 *   policy involved). It has no general peer messaging, and it is not on the roster until the
 *   moment it creates a team.
 * - A teammate is a SESSION created through the host's `spawnable` factory, born with the
 *   member `Hub` tool (send/list/inbox, gated by the `visibility` policy). Members are the only
 *   agents with general send.
 *
 * Identity and capability are therefore produced by the same act: a member's roster row is
 * written at spawn, a creator's at `Team create`. Nothing is inferred from event timing, and
 * subagents (delegations) never enter the peer world at all — `observe` only refreshes the
 * status of rows that explicit acts created.
 *
 * This does not belong in core; see the README for the reasoning and for how
 * this shape was reached.
 */
import type { ExtensionAPI, ExtensionActions, ExtensionDefinition, ExtensionHostContext } from "operon-agents";
import type { AgentEvent, SteerOrigin } from "operon-agents-core";
import {
  CardSyncedDirectory,
  MemoryAgentDirectory,
  type AgentDirectory,
  type AgentListFilter,
  type AgentRef,
  type Visibility,
} from "./directory.ts";
import type { PeerLimits, PeerMailbox, PeerMessage } from "./mailbox.ts";
import { createMemoryPeerRepo, type PeerRepo } from "./repo.ts";
import { budgetExceeded, UsageDiff, type PeerBudget, type PeerFleetStats, type PeerStatsStore } from "./stats.ts";
import { buildTeamTool } from "./team-tool.ts";
import { buildMemberTool } from "./member-tool.ts";

/** Marks a peer message on the wire and in the recipient's journal. `deliveryId` is the reconcile
 *  anchor — a restart matches it against the recipient's log to tell delivered from lost. */
export const PEER_SOURCE = "peer";

/** What routing reports back. `send` never blocks, so this describes DELIVERY, not a reply. */
export interface PeerReceipt {
  readonly messageId: string;
  readonly to: string;
  readonly status: "delivered" | "failed";
  /** Machine-readable cause, so a model can tell "wrong id" from "you sent too much" and stop
   *  retrying what cannot succeed. */
  readonly reason?: "unknown_agent" | "not_visible" | "self_send" | "quota_exceeded" | "mailbox_full" | "unreachable";
  readonly detail?: string;
}

/** What `Team spawn` hands a teammate factory. The `peers()` extension's own factory creates the
 *  session tagged `params: { peers: { member } }`, so the member is born with its Hub and its
 *  roster identity — the host never wires this. */
export interface TeammateSpawnRequest {
  readonly name: string;
  readonly type: string;
  /** Full team label (`team:<creator>:<name>`). */
  readonly team: string;
  readonly creatorId: string;
}

export type TeammateFactory = (request: TeammateSpawnRequest) => Promise<{ readonly id: string }>;

export interface PeerNetworkOptions {
  /** Required — there is no permissive default. Gates MEMBER messaging (`Hub send`/`list`).
   *  `Team send` is not gated by it: a creator's reach is exactly the members it spawned. */
  readonly visibility: Visibility;
  readonly limits?: PeerLimits;
  /**
   * Where peer state lives — the host's choice of backend (memory default, `createFilePeerRepo`,
   * or its own PG/Redis implementation). See `PeerRepo` for what each facet persists and the
   * atomicity contract implementations must honor.
   */
  readonly repo?: PeerRepo;
  /**
   * Spend ceiling across the whole network. Reaching it stops PEER traffic; it does not (and
   * cannot) stop an agent already running from finishing its own work — `maxTurns` owns that.
   */
  readonly budget?: PeerBudget;
  /**
   * Teammate types the model may create with `Team spawn` — the parameter boundary: the HOST
   * defines what a teammate of each type is (its session config, permissions, model), the model
   * only picks a type and a name. Absent → the spawn op reports nothing is spawnable.
   */
  readonly spawnable?: Readonly<Record<string, TeammateFactory>>;
}

/** Options for the creator-side extension. No `labels`: an ordinary agent has no peer identity
 *  until it forms a team, and membership is never granted by configuration here — a member is
 *  made by a session's `params.member`, which the spawn factory sets. */
export interface PeerExtensionOptions {
  /** What this agent IS if it steps onto the roster by creating a team — `"lead"`, `"orchestrator"`. */
  readonly type?: string;
  /** One line on what this agent is for. Shown on the roster next to `type`. */
  readonly description?: string;
}

/** Options for the member-side extension. `name` is the agent's peer identity (what teammates
 *  address), `team` the full label it belongs to. A host can also attach this directly to
 *  pre-arrange a standing team without any model-driven spawn. */
export interface PeerMemberOptions {
  readonly name: string;
  /** Full team label. Host-arranged teams pick any stable string (e.g. `team:host:alpha`);
   *  spawn-created members receive the creator-stamped label via `TeammateSpawnRequest`. */
  readonly team: string;
  readonly type?: string;
  readonly description?: string;
}

let messageCounter = 0;
function newMessageId(): string {
  messageCounter += 1;
  return `pm_${Date.now().toString(36)}_${messageCounter.toString(36)}`;
}

function addressTail(address: string): string {
  const index = address.lastIndexOf("/");
  return index < 0 ? address : address.slice(index + 1);
}

/**
 * A team label is `team:<creator>:<name>`.
 *
 * The creator segment is stamped by us, never by the model, and that is the whole security
 * argument: two agents that both name a team "migration" get two different labels, so neither
 * can join the other's team by guessing its name. Teams stay FLAT — the segments make a label
 * unique, they do not nest one team inside another.
 */
function teamLabel(creatorId: string, name: string): string {
  return `team:${creatorId}:${name}`;
}

function ownedTeamLabels(ref: AgentRef): readonly string[] {
  const prefix = `team:${ref.agentId}:`;
  return (ref.labels ?? []).filter((label) => label.startsWith(prefix));
}

function invalidName(kind: "Team" | "Agent", name: string): string | undefined {
  if (name.length === 0 || name.length > 48) return `${kind} name must be 1-48 characters.`;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return `${kind} name "${name}" may only contain letters, digits, "_" and "-".`;
  return undefined;
}

/** Who is calling a Team op: resolved per call from the frame address, because the Team tool is
 *  shared by every frame of its session — the root agent IS the session for addressing purposes,
 *  a subagent frame is its own (memory-only) identity. */
export interface TeamCaller {
  readonly agentId: string;
  readonly sessionId: string;
  readonly address: string;
  readonly type?: string;
  readonly description?: string;
}

export class PeerNetwork {
  readonly directory: AgentDirectory;
  private readonly mailbox: PeerMailbox;
  private readonly visibility: Visibility;
  private readonly limits: PeerLimits | undefined;
  private readonly spawnable: Readonly<Record<string, TeammateFactory>> | undefined;
  /** Any session's actions will do — `openSession` reaches every session on the harness. */
  private actions: ExtensionActions | undefined;
  /** Per-turn outbound counters, keyed by "<agentId>:<turnId>" so they self-expire. */
  private readonly outbound = new Map<string, number>();
  private readonly budget: PeerBudget | undefined;
  private readonly statistics: PeerStatsStore;
  private readonly usageDiff = new UsageDiff();
  /**
   * Roster seeding from the card store, kicked off at construction. Every public entry point
   * awaits it, so a durable repo's parked teammates are discoverable before the first route —
   * without forcing hosts through a separate init call.
   */
  private readonly ready: Promise<void>;
  /** Deliveries handed to a recipient that was not running — each one starts a turn. Consumed
   *  when the message surfaces in the recipient's conversation. */
  private readonly wokenBy = new Set<string>();

  constructor(options: PeerNetworkOptions) {
    const repo = options.repo ?? createMemoryPeerRepo();
    const directory = new CardSyncedDirectory(new MemoryAgentDirectory(), repo.cards);
    this.directory = directory;
    this.mailbox = repo.mailbox;
    this.statistics = repo.stats;
    this.visibility = options.visibility;
    this.limits = options.limits;
    this.budget = options.budget;
    this.spawnable = options.spawnable;
    this.ready = directory.seed().catch(() => undefined);
  }

  /** What the fleet has spent, per agent and in total. The view a host needs to notice a runaway
   *  team before the bill does. */
  async stats(): Promise<PeerFleetStats> {
    await this.ready;
    return this.statistics.snapshot();
  }

  /** Idempotent: the first session to mount wins — any session's actions reach every session
   *  (`openSession` spans the harness). Mounts also re-arm this on every observed event, which
   *  is what re-connects a REPLACEMENT instance (whose own `actions` starts empty) without any
   *  session being touched. */
  attachActions(actions: ExtensionActions): void {
    this.actions ??= actions;
  }

  /** Roster lookup in method form — field access (`.directory`) does not survive a service
   *  handle, which exposes methods only. Host-side code may keep using `.directory`. */
  async getAgent(agentId: string): Promise<AgentRef | undefined> {
    await this.ready;
    return this.directory.get(agentId);
  }

  /** Mark an agent parked (its session closed / its member session ended). */
  async parkAgent(agentId: string): Promise<void> {
    await this.ready;
    await this.directory.setStatus(agentId, "parked");
  }

  /** Member identity registration at session start — what `mountHub` calls from `session.start`. */
  async registerMemberSession(options: PeerMemberOptions, sessionId: string): Promise<void> {
    await this.ready;
    await this.directory.register({
      agentId: options.name,
      type: options.type ?? "member",
      kind: "session",
      sessionId,
      address: "main",
      status: "idle",
      labels: [options.team],
      ...(options.description !== undefined ? { description: options.description } : {}),
      updatedAt: Date.now(),
    });
  }

  /**
   * Detach from the harness and drop in-memory coordination state. This is the replace/unload
   * dispose hook: calls already in flight (leased on this instance) finish normally; later
   * deliveries fail with the existing "unreachable" receipt. The repo behind cards/mailbox/stats
   * is HOST-owned and deliberately left open — a successor instance re-seeds from it.
   */
  async close(): Promise<void> {
    await this.ready;
    this.actions = undefined;
    this.outbound.clear();
    this.wokenBy.clear();
  }

  /**
   * Refresh the STATUS of rows explicit acts created — nothing more. Identity never comes from
   * here: members are registered at spawn (or member session start), creators at `Team create`.
   * A frame the roster does not know (every ordinary delegation) falls through `setStatus`'s
   * no-op, which is exactly the point.
   */
  observe(event: AgentEvent, rosterId: string | undefined): void {
    const address = event.address;
    if (address === undefined || rosterId === undefined) return;
    const isRoot = address === "main";
    const key = isRoot ? rosterId : addressTail(address);
    if (event.type === "agent.started") {
      void this.directory.setStatus(key, "running");
      return;
    }
    if (event.type === "agent.ended") {
      // A subagent creator that finished stays on the roster as a record — `parked`, continuable
      // only by its parent; a root agent going quiet is just `idle`.
      void this.directory.setStatus(key, isRoot ? "idle" : "parked");
      return;
    }
    if (event.type === "message.appended") {
      // A peer message reached the recipient's conversation — NOW it is safe to clear the ledger.
      //
      // Settling at delivery time instead would defeat the point: `steerTo` only puts the message
      // on an in-memory queue, so a crash before the recipient consumed it would lose the message
      // AND its ledger entry. Waiting for this event is what makes the write-ahead real.
      const origin = event.origin;
      if (origin?.kind !== "external" || origin.source !== PEER_SOURCE) return;
      const woken = this.wokenBy.delete(origin.deliveryId);
      void this.statistics.add(key, { messagesReceived: 1, wakes: woken ? 1 : 0 }).catch(() => undefined);
      void this.mailbox.settle(key, origin.deliveryId).catch(() => undefined);
      return;
    }
    if (event.type === "usage.updated") {
      // Attributed to the SESSION's roster identity: a delegation's spend is its session's spend.
      // The delta MUST be taken synchronously — `UsageDiff` relies on seeing running totals in
      // event order; only the resulting increment is handed to the (possibly async) store.
      const delta = this.usageDiff.delta(rosterId, event.usage);
      void this.statistics.add(rosterId, delta).catch(() => undefined);
    }
  }

  async list(filter?: AgentListFilter): Promise<readonly AgentRef[]> {
    await this.ready;
    return this.directory.list(filter);
  }

  /** Peers `selfId` may see, excluding itself. Backs the member `Hub list`. */
  async visiblePeers(selfId: string): Promise<readonly AgentRef[]> {
    await this.ready;
    const self = await this.directory.get(selfId);
    if (self === undefined) return [];
    const all = await this.directory.list();
    return all.filter((ref) => ref.agentId !== selfId && this.visibility(self, ref));
  }

  /** Members of teams `selfId` created. Backs `Team list` and `Team send`'s scope. */
  async ownedMembers(selfId: string): Promise<readonly AgentRef[]> {
    await this.ready;
    const prefix = `team:${selfId}:`;
    const all = await this.directory.list();
    return all.filter((ref) => ref.agentId !== selfId && (ref.labels ?? []).some((label) => label.startsWith(prefix)));
  }

  /**
   * Form a team. The one act that puts a CREATOR on the roster — its identity and its team are
   * produced together, which is why "holding the Team tool but unknown to the roster" is not a
   * reachable state for anything that matters: every op that needs an identity either creates it
   * (here) or requires a team to exist (everywhere else).
   *
   * Membership cannot be extended sideways: the only agents that ever wear the label are ones
   * `Team spawn` creates under it. So a team can never widen what its creator could already
   * reach — no agent can pull a stranger in, or push itself into someone else's team.
   */
  async createTeam(caller: TeamCaller, name: string): Promise<{ readonly label: string } | { readonly error: string }> {
    const invalid = invalidName("Team", name);
    if (invalid !== undefined) return { error: invalid };
    await this.ready;
    const label = teamLabel(caller.agentId, name);
    const existing = await this.directory.get(caller.agentId);
    const labels = existing?.labels ?? [];
    if (!labels.includes(label)) {
      const isRoot = caller.address === "main";
      // Awaited: the label is the one piece of team state that exists nowhere else, so the card
      // write must land before the caller is told the team exists.
      await this.directory.register({
        agentId: caller.agentId,
        type: existing?.type ?? caller.type ?? (isRoot ? "session" : "subagent"),
        kind: isRoot ? "session" : "subagent",
        sessionId: caller.sessionId,
        address: caller.address,
        status: "running",
        labels: [...labels, label],
        ...(caller.description !== undefined ? { description: caller.description } : {}),
        updatedAt: Date.now(),
      });
    }
    return { label };
  }

  /**
   * Create one teammate: resolve the host's factory for `type`, let it build the session (which
   * tags it `params: { peers: { member } }`, so identity + Hub arrive with birth), then hand the initial
   * prompt over as the first peer message — the write-ahead ledger covers the crash window
   * between session creation and the prompt entering its conversation.
   */
  async spawnTeammate(
    creatorId: string,
    args: { readonly type: string; readonly name: string; readonly prompt: string; readonly team?: string },
  ): Promise<{ readonly name: string; readonly sessionId: string; readonly team: string; readonly receipt: PeerReceipt } | { readonly error: string }> {
    await this.ready;
    const factory = this.spawnable?.[args.type];
    if (factory === undefined) {
      const available = Object.keys(this.spawnable ?? {});
      return { error: available.length === 0 ? "No teammate types are configured; spawning is unavailable here." : `Unknown teammate type "${args.type}". Available: ${available.join(", ")}` };
    }
    const creator = await this.directory.get(creatorId);
    const owned = creator === undefined ? [] : ownedTeamLabels(creator);
    if (creator === undefined || owned.length === 0) {
      return { error: `Create a team first (Team create), then spawn into it.` };
    }
    let label: string;
    if (args.team !== undefined) {
      label = teamLabel(creatorId, args.team);
      if (!owned.includes(label)) return { error: `You have no team named "${args.team}".` };
    } else if (owned.length === 1) {
      label = owned[0] as string;
    } else {
      return { error: `You own several teams — say which: team must be one of ${owned.map((l) => l.slice(`team:${creatorId}:`.length)).join(", ")}.` };
    }
    const invalid = invalidName("Agent", args.name);
    if (invalid !== undefined) return { error: invalid };
    if ((await this.directory.get(args.name)) !== undefined) {
      return { error: `The name "${args.name}" is already taken on the roster. Pick another.` };
    }
    const overspent = budgetExceeded(await this.statistics.snapshot(), this.budget);
    if (overspent !== undefined) return { error: `${overspent}. Spawning is paused.` };

    let session: { readonly id: string };
    try {
      session = await factory({ name: args.name, type: args.type, team: label, creatorId });
    } catch (error) {
      return { error: `Could not create teammate "${args.name}": ${error instanceof Error ? error.message : String(error)}` };
    }
    // The member was registered at its session start (params.member → Hub); this merge
    // is belt-and-braces against a factory that resolved before that handler settled.
    await this.directory.register({
      agentId: args.name,
      type: args.type,
      kind: "session",
      sessionId: session.id,
      address: "main",
      status: "idle",
      labels: [label],
      updatedAt: Date.now(),
    });
    const to = await this.directory.get(args.name);
    if (to === undefined) return { error: `Teammate "${args.name}" was created but never appeared on the roster — did the spawn factory set params.member?` };
    const receipt = await this.dispatch(creator, to, args.prompt, {});
    return { name: args.name, sessionId: session.id, team: label, receipt };
  }

  /** Charge one outbound message against the sender's per-turn budget. */
  overBudget(selfId: string, turnId: string): boolean {
    const limit = this.limits?.maxOutboundPerTurn;
    if (limit === undefined) return false;
    const key = `${selfId}:${turnId}`;
    const used = this.outbound.get(key) ?? 0;
    if (used >= limit) return true;
    this.outbound.set(key, used + 1);
    return false;
  }

  /**
   * MEMBER send: the general peer path, gated by the `visibility` policy. The single enforcement
   * point for the boundary — a member may only address a peer its policy admits.
   */
  async route(from: AgentRef, toId: string, content: string, opts: { readonly replyTo?: string; readonly interrupt?: boolean } = {}): Promise<PeerReceipt> {
    await this.ready;
    const fail = (reason: PeerReceipt["reason"], detail: string): PeerReceipt => ({ messageId: newMessageId(), to: toId, status: "failed", reason, detail });
    if (toId === from.agentId) return fail("self_send", "Cannot send a message to yourself.");
    const to = await this.directory.get(toId);
    if (to === undefined) return fail("unknown_agent", `No agent "${toId}" is on the roster. Use Hub list; never invent an id.`);
    if (!this.visibility(from, to)) return fail("not_visible", `Agent "${toId}" is not addressable from here.`);
    return this.dispatch(from, to, content, opts);
  }

  /**
   * CREATOR send: scope replaces policy — a creator reaches exactly the members wearing one of
   * its own team labels, and nothing else. No visibility function is consulted.
   */
  async sendWithinTeam(fromId: string, toId: string, content: string, opts: { readonly replyTo?: string; readonly interrupt?: boolean } = {}): Promise<PeerReceipt> {
    await this.ready;
    const fail = (reason: PeerReceipt["reason"], detail: string): PeerReceipt => ({ messageId: newMessageId(), to: toId, status: "failed", reason, detail });
    const from = await this.directory.get(fromId);
    if (from === undefined) return fail("unknown_agent", "Create a team first (Team create).");
    const to = await this.directory.get(toId);
    const prefix = `team:${fromId}:`;
    if (to === undefined || !(to.labels ?? []).some((label) => label.startsWith(prefix))) {
      return fail("not_visible", `"${toId}" is not a member of any team you created. Team list shows your members.`);
    }
    return this.dispatch(from, to, content, opts);
  }

  /** The shared tail of every send: budget → write-ahead ledger (capacity enforced atomically
   *  inside) → delivery. Callers have already established WHO may talk to WHOM. */
  private async dispatch(from: AgentRef, to: AgentRef, content: string, opts: { readonly replyTo?: string; readonly interrupt?: boolean }): Promise<PeerReceipt> {
    const messageId = newMessageId();
    const fail = (reason: PeerReceipt["reason"], detail: string): PeerReceipt => ({ messageId, to: to.agentId, status: "failed", reason, detail });
    const overspent = budgetExceeded(await this.statistics.snapshot(), this.budget);
    if (overspent !== undefined) {
      // Stops peer traffic only. Agents already running finish their own work — `maxTurns` owns
      // that, and cutting a run off mid-flight would strand it worse than letting it end.
      return fail("quota_exceeded", `${overspent}. Peer messaging is paused; finish what you have.`);
    }
    const message: PeerMessage = { messageId, from: from.agentId, to: to.agentId, content, queuedAt: Date.now(), ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}) };
    const { accepted } = await this.mailbox.enqueue(message, { ...(this.limits?.mailboxCapacity !== undefined ? { capacity: this.limits.mailboxCapacity } : {}) });
    if (!accepted) return fail("mailbox_full", `Agent "${to.agentId}" has too many undelivered messages.`);
    return this.deliver(to, message, opts.interrupt === true);
  }

  /**
   * Hand an already-ledgered message to its recipient. Split out from the send paths so a
   * redelivery (see `reconcile`) does not re-run the checks or write a second ledger entry.
   */
  private async deliver(to: AgentRef, message: PeerMessage, interrupt: boolean): Promise<PeerReceipt> {
    const { messageId, to: toId, content } = message;
    const fail = (reason: PeerReceipt["reason"], detail: string): PeerReceipt => ({ messageId, to: toId, status: "failed", reason, detail });

    const origin: SteerOrigin = {
      kind: "external",
      source: PEER_SOURCE,
      deliveryId: messageId,
      actor: message.from,
      // follow_up by default: peers interject between turns, they do not interrupt work in flight.
      channel: interrupt ? "steering" : "follow_up",
      ...(message.replyTo !== undefined ? { metadata: { replyTo: message.replyTo } } : {}),
    };

    await this.statistics.add(message.from, { messagesSent: 1 });
    // Whether this delivery will start a turn: a recipient that is not currently running has to
    // be woken to see it.
    if (to.status !== "running") this.wokenBy.add(messageId);
    try {
      if (this.actions === undefined) return fail("unreachable", "Peer networking is not attached to a harness.");
      // Reopens the session when it was closed — which is what makes a parked teammate wakeable.
      const handle = await this.actions.openSession(to.sessionId);
      // NOTE: no `settle` on success. The ledger entry is cleared when the recipient's
      // `message.appended` shows the message actually entered its conversation (see `observe`) —
      // delivery here only means it reached an in-memory queue.
      if (!handle.steerTo(to.address, content, origin)) {
        // The session is open but no frame is running at that address. For a member session that
        // cannot happen (its root frame revives on open); it happens for a subagent CREATOR whose
        // delegation finished — continuing it is its parent's call, not a message.
        await this.mailbox.settle(toId, messageId);
        return fail(
          "unreachable",
          to.kind === "subagent"
            ? `Agent "${toId}" has finished. Its parent can continue it with Agent(resume="${toId}", prompt=...); it cannot be messaged.`
            : `No frame is running at "${to.address}" in session "${to.sessionId}".`,
        );
      }
    } catch (error) {
      return fail("unreachable", `Could not reach session "${to.sessionId}": ${error instanceof Error ? error.message : String(error)}`);
    }
    return { messageId, to: toId, status: "delivered" };
  }

  /**
   * Redeliver everything the ledger still holds. Call once on startup, after at least one session
   * with the extension is attached (that is what connects the network to a harness). Recipients
   * themselves need not be open: a card-seeded parked teammate is found on the roster and delivery
   * reopens its session.
   *
   * The ledger only ever contains messages whose recipient never took them into its conversation
   * (entries clear on `message.appended`), so anything left after a restart was genuinely lost in
   * the crash window — no journal comparison needed to tell that apart.
   *
   * A message whose recipient is no longer on the roster is dropped rather than retried forever;
   * `dropped` is reported so a host can log it instead of discovering the gap later.
   */
  async reconcile(): Promise<{ readonly redelivered: number; readonly dropped: number }> {
    await this.ready;
    let redelivered = 0;
    let dropped = 0;
    for (const recipientId of await this.mailbox.pendingRecipients()) {
      const to = await this.directory.get(recipientId);
      for (const message of await this.mailbox.pending(recipientId)) {
        if (to === undefined) {
          await this.mailbox.settle(recipientId, message.messageId);
          dropped += 1;
          continue;
        }
        const receipt = await this.deliver(to, message, false);
        if (receipt.status === "delivered") redelivered += 1;
        else dropped += 1;
      }
    }
    return { redelivered, dropped };
  }

  /** Undelivered ledger entries for one agent — what was routed but never reached its
   *  conversation (the crash window). */
  async drainInbox(agentId: string): Promise<readonly PeerMessage[]> {
    await this.ready;
    const pending = await this.mailbox.pending(agentId);
    for (const message of pending) await this.mailbox.settle(agentId, message.messageId);
    return pending;
  }
}

/**
 * The METHOD-ONLY surface the session-side mounts and tools consume. Both the live instance
 * and a `ServiceRegistry` handle satisfy it — a handle exposes methods only, which is why
 * nothing here is a field (`.directory` stays host-side). Methods must not return objects
 * that carry the instance (the one leak a handle cannot stop).
 */
export type PeerNetworkHandle = Pick<
  PeerNetwork,
  | "attachActions"
  | "observe"
  | "parkAgent"
  | "registerMemberSession"
  | "getAgent"
  | "list"
  | "visiblePeers"
  | "ownedMembers"
  | "createTeam"
  | "spawnTeammate"
  | "overBudget"
  | "route"
  | "sendWithinTeam"
  | "drainInbox"
  | "stats"
  | "reconcile"
>;

/** The extension id, and so the service name its `create` half's network is registered under.
 *  A session's `setup` reaches the network as `ctx.shared`; the host reaches it with
 *  `harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE)`. */
export const PEERS_SERVICE = "peers";

/** Mount the creator side (the `Team` tool) onto a session — what `peers().setup` does for an
 *  ordinary session. */
export function mountTeam(network: PeerNetworkHandle, api: ExtensionAPI, options: PeerExtensionOptions = {}): void {
  let sessionId: string | undefined;
  network.attachActions(api.actions);
  api.on("session.start", (event) => {
    sessionId = event.sessionId;
  });
  api.on("session.end", () => {
    if (sessionId !== undefined) void network.parkAgent(sessionId);
  });
  api.onEvent((event) => {
    // Re-arm on every event: through a handle this lands on the CURRENT instance, so a
    // replacement network regains a route back into the harness without any session redoing
    // setup. Idempotent and cheap on the live instance.
    network.attachActions(api.actions);
    network.observe(event, sessionId);
  });
  api.registerTool(buildTeamTool(network, () => sessionId, options));
}

/** Mount the member side (the `Hub` tool + identity registration) onto a session — what
 *  `peers().setup` does for a teammate. */
export function mountHub(network: PeerNetworkHandle, api: ExtensionAPI, options: PeerMemberOptions): void {
  network.attachActions(api.actions);
  api.on("session.start", (event) => {
    void network.registerMemberSession(options, event.sessionId);
  });
  api.on("session.end", () => {
    void network.parkAgent(options.name);
  });
  api.onEvent((event) => {
    network.attachActions(api.actions);
    network.observe(event, options.name);
  });
  api.registerTool(buildMemberTool(network, options.name));
}

export function createPeerNetwork(options: PeerNetworkOptions): PeerNetwork {
  return new PeerNetwork(options);
}

// ============================================================================
// The extension — one definition, both halves
// ============================================================================

/** What a teammate session is born as: the options `harness.createSession` takes. `peers`
 *  merges in the member's peer identity as `params.peers`, so the host never wires a mount. */
export type TeammateSessionOptions = {
  readonly title?: string;
  readonly extensions?: readonly ExtensionDefinition[];
  readonly params?: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * The per-session argument to the `peers` extension (`createSession({ params: { peers } })`).
 *
 * - `member` present ⇒ this session is a teammate: it gets the member `Hub` with this identity,
 *   and NOT `Team` — a teammate is a member, it does not form teams of its own.
 * - `member` absent ⇒ an ordinary session, which gets the creator `Team`.
 *
 * A spawn factory sets `member` automatically; a host sets it directly to pre-arrange a standing
 * team. Pass `false` as a session's `peers` param (handled by the framework) to skip peers there.
 */
export interface PeerParams {
  readonly member?: PeerMemberOptions;
}

export interface PeerOptions extends Omit<PeerNetworkOptions, "spawnable" | "repo"> {
  /**
   * Where peer state lives: a repo, or a factory given the `create` host — the file form builds
   * its file repo in `host.dataDir` (outside the bundle, so an update keeps roster and mailbox).
   * Absent → in-memory (wiped by a reload).
   */
  readonly repo?: PeerRepo | ((host: ExtensionHostContext) => PeerRepo);
  /**
   * Teammate types the model may create with `Team spawn`, each as the session options a
   * teammate of that type is born with (a constant, or computed from the spawn request). The
   * parameter boundary: the HOST says what a `coder` IS, the model only picks a type and a name.
   * Absent → the spawn op reports nothing is spawnable.
   */
  readonly teammates?: Readonly<
    Record<string, TeammateSessionOptions | ((request: TeammateSpawnRequest) => TeammateSessionOptions | Promise<TeammateSessionOptions>)>
  >;
  /** Creator options (`type`, `description`) for the `Team` an ordinary session is born holding. */
  readonly team?: PeerExtensionOptions;
}

/**
 * The peers extension — ONE definition, both halves:
 *
 * - `create` (the process-shared half) runs once per harness and returns the shared
 *   `PeerNetwork`, which the framework registers as the `peers` service. Its spawn factory
 *   creates each teammate through `host.createSession`, tagging it `params: { peers: { member } }`.
 * - `setup` (the per-session half) runs on every session: a teammate (has `params.member`) gets
 *   the member `Hub`; every other session gets the creator `Team`. It reaches the network only
 *   through the `shared` handle, so a reload swaps the network under live sessions.
 *
 * Server: `createHarness({ extensions: [peers({...})] })`. Desktop: a bundle in `extensionDir`
 * whose default export is `peers({...})`. Same definition, only the channel differs.
 */
export function peers(options: PeerOptions): ExtensionDefinition<PeerNetworkHandle, PeerParams> {
  const { teammates, team = {}, repo, ...networkOptions } = options;
  return {
    id: PEERS_SERVICE,
    create(host: ExtensionHostContext) {
      const resolvedRepo = typeof repo === "function" ? repo(host) : repo;
      const spawnable =
        teammates === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(teammates).map(([type, sessionOptions]): [string, TeammateFactory] => [
                type,
                async (request) => {
                  const base = typeof sessionOptions === "function" ? await sessionOptions(request) : sessionOptions;
                  const member: PeerMemberOptions = { name: request.name, team: request.team, type: request.type };
                  return host.createSession({ ...base, params: { ...(base.params ?? {}), [PEERS_SERVICE]: { member } } });
                },
              ]),
            );
      return createPeerNetwork({
        ...networkOptions,
        ...(resolvedRepo !== undefined ? { repo: resolvedRepo } : {}),
        ...(spawnable !== undefined ? { spawnable } : {}),
      });
    },
    setup(api, { shared: network, params }) {
      if (params?.member !== undefined) mountHub(network, api, params.member);
      else mountTeam(network, api, team);
    },
  };
}
