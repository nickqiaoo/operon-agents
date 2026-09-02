/**
 * Who is on the field, across sessions.
 *
 * A PROJECTION, not a source of truth: durable state lives in each session's log, and this only
 * aggregates what the event stream already says so agents can find — and address — each other.
 * Losing it on restart costs discovery, not data.
 *
 * Two ids, deliberately separate: `agentId` is flat and unique (addressing), `address` stays
 * hierarchical (journal sharding, and what `steerTo` takes).
 */

/**
 * Two genuinely different things, not two flavours of one:
 *
 * `session` — an independent agent. Its own store, capabilities, permissions and lifetime; the
 * host (or an extension) opens it, and closing it only puts it to sleep.
 *
 * `subagent` — one delegation inside a session. It SHARES the parent's store, capabilities,
 * permissions and machine; only its conversation shard and its frame are its own, and its
 * lifetime is the parent run's. That is the right shape for "go do this for me", and the wrong
 * shape for a durable teammate — which is why the two are not unified.
 */
export type AgentRefKind = "session" | "subagent";

/**
 * `parked` means different things for the two kinds, because they ARE different:
 *
 * - a closed `session` is asleep — reopening it (a message will) brings it back;
 * - a finished `subagent` is a completed delegation — its shard stays replayable, but only the
 *   parent that spawned it can continue it (`Agent(resume=…)`), because everything else it ran
 *   on belongs to that parent.
 *
 * A `running` subagent, by contrast, is messageable like anyone else — which is what lets a batch
 * of parallel delegates coordinate while they work.
 *
 * Being on the roster never implies permission: that is `visibility`, independent of status.
 */
export type AgentRefStatus = "running" | "idle" | "parked" | "error";

export interface AgentRef {
  readonly agentId: string;
  /**
   * The short name agents use for each other. A spawned teammate's is the name the model chose,
   * unique WITHIN ITS TEAM (its `agentId` is `<team label>/<name>`, which is what keeps two
   * teams' "dba"s apart on one roster). Absent for creators, whose `agentId` is their session id.
   */
  readonly name?: string;
  readonly type: string;
  readonly kind: AgentRefKind;
  readonly sessionId: string;
  /** Journal address of its frame — `main`, or `main/<agentId>`. What `steerTo` addresses. */
  readonly address: string;
  /** Lineage only, NOT a control-flow relationship. */
  readonly parentId?: string;
  /** Open-ended grouping. Membership in a "team" is a label, not a container — which is what
   *  lets one team mix session-level teammates with subagents. */
  readonly labels?: readonly string[];
  readonly status: AgentRefStatus;
  readonly description?: string;
  readonly updatedAt: number;
}

export interface AgentListFilter {
  readonly sessionId?: string;
  readonly kind?: AgentRefKind;
  readonly label?: string;
}

export interface AgentDirectory {
  register(ref: AgentRef): Promise<void>;
  setStatus(agentId: string, status: AgentRefStatus): Promise<void>;
  /** Drop an agent entirely. For deletion — a closed session is `parked`, not unregistered. */
  unregister(agentId: string): Promise<void>;
  get(agentId: string): Promise<AgentRef | undefined>;
  list(filter?: AgentListFilter): Promise<readonly AgentRef[]>;
}

/**
 * The durable slice of the roster: exactly what the runtime INVENTED and nothing else knows —
 * team labels (`Hub team` writes them nowhere but here) and the `type`/`description` card stated
 * when the extension was wired. Everything else on an `AgentRef` is derivable and deliberately
 * NOT persisted: a session-level agent's `sessionId` is its `agentId`, its `address` is `"main"`,
 * and its `status` after a restart is `parked` by definition — whatever a previous process
 * recorded as `running` is a lie by the time anyone reads it.
 *
 * Only `kind: "session"` agents are carded. A parked subagent is a finished delegation — not
 * addressable, only resumable by its parent — so persisting it would preserve a record, not a
 * teammate.
 */
export interface PeerCard {
  readonly type: string;
  /** The short name (see `AgentRef.name`). */
  readonly name?: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  /** The session behind this agent. Spawned teammates are addressed by their NAME, which is not
   *  the session id — omitting this would strand them after a restart. Absent on older cards,
   *  where the agent id WAS the session id. */
  readonly sessionId?: string;
}

export interface PeerCardStore {
  put(agentId: string, card: PeerCard): Promise<void>;
  remove(agentId: string): Promise<void>;
  list(): Promise<ReadonlyArray<{ readonly agentId: string; readonly card: PeerCard }>>;
}

export class MemoryPeerCardStore implements PeerCardStore {
  private readonly cards = new Map<string, PeerCard>();

  async put(agentId: string, card: PeerCard): Promise<void> {
    this.cards.set(agentId, card);
  }

  async remove(agentId: string): Promise<void> {
    this.cards.delete(agentId);
  }

  async list(): Promise<ReadonlyArray<{ readonly agentId: string; readonly card: PeerCard }>> {
    return [...this.cards.entries()].map(([agentId, card]) => ({ agentId, card }));
  }
}

/** What a card seeds back onto the roster: identity from the card, everything derivable derived. */
export function refFromCard(agentId: string, card: PeerCard): AgentRef {
  return {
    agentId,
    type: card.type,
    kind: "session",
    sessionId: card.sessionId ?? agentId,
    address: "main",
    status: "parked",
    ...(card.name !== undefined ? { name: card.name } : {}),
    ...(card.description !== undefined ? { description: card.description } : {}),
    ...(card.labels !== undefined ? { labels: card.labels } : {}),
    updatedAt: 0,
  };
}

/**
 * Keeps the card store mirroring the roster's durable slice, so callers never write both.
 *
 * The card is written from the MERGED ref read back after `register` — not from the incoming one —
 * because `register` preserves labels the caller did not restate (a session reopening without
 * `labels` must not wipe its persisted team membership). `setStatus` never touches the store:
 * status is the field that flips every turn, and it is exactly the field that is not persisted.
 */
export class CardSyncedDirectory implements AgentDirectory {
  private readonly inner: AgentDirectory;
  private readonly cards: PeerCardStore;

  constructor(inner: AgentDirectory, cards: PeerCardStore) {
    this.inner = inner;
    this.cards = cards;
  }

  async register(ref: AgentRef): Promise<void> {
    await this.inner.register(ref);
    if (ref.kind !== "session") return;
    const merged = await this.inner.get(ref.agentId);
    if (merged === undefined) return;
    await this.cards.put(merged.agentId, {
      type: merged.type,
      sessionId: merged.sessionId,
      ...(merged.name !== undefined ? { name: merged.name } : {}),
      ...(merged.description !== undefined ? { description: merged.description } : {}),
      ...(merged.labels !== undefined ? { labels: merged.labels } : {}),
    });
  }

  setStatus(agentId: string, status: AgentRefStatus): Promise<void> {
    return this.inner.setStatus(agentId, status);
  }

  async unregister(agentId: string): Promise<void> {
    await this.inner.unregister(agentId);
    await this.cards.remove(agentId);
  }

  async get(agentId: string): Promise<AgentRef | undefined> {
    const live = await this.inner.get(agentId);
    if (live !== undefined) return live;
    // Fall through to the card store on a miss: a row carded by a PREDECESSOR instance after
    // this one seeded (the replace drain window) is recovered instead of lost. Same guard as
    // `seed()` — never overwrite an entry that appeared in the meantime.
    const card = (await this.cards.list()).find((row) => row.agentId === agentId)?.card;
    if (card === undefined) return undefined;
    if ((await this.inner.get(agentId)) === undefined) await this.inner.register(refFromCard(agentId, card));
    return this.inner.get(agentId);
  }

  list(filter?: AgentListFilter): Promise<readonly AgentRef[]> {
    return this.inner.list(filter);
  }

  /** Rebuild the parked half of the roster from the card store. Never overwrites a live entry —
   *  a session that registered before seeding finished must keep its live status. */
  async seed(): Promise<void> {
    for (const { agentId, card } of await this.cards.list()) {
      if ((await this.inner.get(agentId)) !== undefined) continue;
      await this.inner.register(refFromCard(agentId, card));
    }
  }
}

/**
 * Whether `from` may see (and therefore address) `to`. DENY BY DEFAULT — there is no built-in
 * fallback that allows everything, because directory visibility IS the permission boundary: an
 * agent that cannot see a privileged peer cannot ask it to act on its behalf.
 */
export type Visibility = (from: AgentRef, to: AgentRef) => boolean;

/** Everything in one session (a root agent and the subagents beneath it). The conservative
 *  starting point. */
export function sameSessionVisibility(from: AgentRef, to: AgentRef): boolean {
  return from.sessionId === to.sessionId;
}

/** Shared labels — what a team application uses to draw its boundary. */
export function sharedLabelVisibility(from: AgentRef, to: AgentRef): boolean {
  if (from.labels === undefined || to.labels === undefined) return false;
  return from.labels.some((label) => to.labels?.includes(label) === true);
}

/** Allow anything the same session tree OR a shared label admits. */
export function anyOf(...policies: readonly Visibility[]): Visibility {
  return (from, to) => policies.some((policy) => policy(from, to));
}

export class MemoryAgentDirectory implements AgentDirectory {
  private readonly refs = new Map<string, AgentRef>();

  async register(ref: AgentRef): Promise<void> {
    const existing = this.refs.get(ref.agentId);
    // Re-registration (a session reopened) keeps labels the caller did not restate, so a revive
    // cannot silently drop team membership.
    this.refs.set(ref.agentId, existing === undefined ? ref : { ...existing, ...ref, labels: ref.labels ?? existing.labels });
  }

  async setStatus(agentId: string, status: AgentRefStatus): Promise<void> {
    const ref = this.refs.get(agentId);
    if (ref === undefined || ref.status === status) return;
    this.refs.set(agentId, { ...ref, status, updatedAt: Date.now() });
  }

  async unregister(agentId: string): Promise<void> {
    this.refs.delete(agentId);
  }

  async get(agentId: string): Promise<AgentRef | undefined> {
    return this.refs.get(agentId);
  }

  async list(filter?: AgentListFilter): Promise<readonly AgentRef[]> {
    const rows = [...this.refs.values()].filter((ref) => {
      if (filter?.sessionId !== undefined && ref.sessionId !== filter.sessionId) return false;
      if (filter?.kind !== undefined && ref.kind !== filter.kind) return false;
      if (filter?.label !== undefined && ref.labels?.includes(filter.label) !== true) return false;
      return true;
    });
    return rows.sort((a, b) => a.updatedAt - b.updatedAt);
  }
}
