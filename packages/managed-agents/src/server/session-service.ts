/**
 * The managed API surface: session resources, and the events sent to and emitted by them.
 *
 * Nothing here touches the framework. A session is a managed record (`metadata`) plus its
 * managed event log (`work`); creating one writes the record, sending events writes the inbox,
 * and reading history reads the log. The runtime session behind it is created by the first
 * worker that claims it, opened by every later one, and never by this object.
 *
 * The practical consequence is that this object is stateless and horizontally scalable: any
 * replica serves any request for any session, it holds no reference to a worker, and it does
 * not know or care whether a worker runs in the same process. Work reaches a worker the same
 * way in every deployment: persisted here, pulled there.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentRef,
  CreateManagedSessionRequest,
  EnvironmentRef,
  ListManagedSessionsOptions,
  ListManagedSessionsResponse,
  ListSessionEventsOptions,
  ListSessionEventsResponse,
  ManagedEventResource,
  ManagedInputResource,
  ManagedPreviewableEventType,
  ManagedSessionResource,
  ManagedSessionStatus,
  SendManagedEventsRequest,
  ManagedStreamEvent,
  SendManagedEventsResponse,
  UpdateManagedSessionRequest,
} from "../protocol/types.ts";
import type { EventBroadcaster } from "./broadcast.ts";
import { ManagedConflictError, ManagedInvalidRequestError, ManagedSessionNotFoundError } from "./errors.ts";
import {
  MemoryManagedDeliveryIdempotencyStore,
  type ManagedDeliveryIdempotencyStore,
} from "./idempotency.ts";
import {
  MemoryManagedSessionMetadataStore,
  type ManagedSessionMetadata,
  type ManagedSessionMetadataStore,
} from "./metadata.ts";
import {
  CreateSessionRequestSchema,
  SendEventsRequestSchema,
  UpdateSessionRequestSchema,
  parseRequest,
} from "./request-schemas.ts";
import type { SessionWork } from "./work.ts";

export interface SessionServiceOptions {
  /**
   * The managed event log and work table. Every accepted event goes through `work.append`,
   * which persists it and wakes the session in one step — so "accepted" means "a worker will
   * pull it", not "a worker was told". MUST be the table the workers claim from.
   */
  readonly work: SessionWork;
  readonly metadataStore?: ManagedSessionMetadataStore;
  /**
   * Partition every session this service creates, and every session `list()` returns, under one
   * owner. A multi-tenant deployment builds one service per tenant so `list()` cannot reach
   * across tenants. Partition, not permission: addressing a session by id is still the
   * authorization hook's decision.
   */
  readonly ownerKey?: string;
  /** Collapses retried sends carrying the same key. Defaults to an in-process store, which is
   *  only correct for a single node — a multi-node deployment must supply a shared one. */
  readonly idempotencyStore?: ManagedDeliveryIdempotencyStore;
  /** Where workers publish live events. Required for `stream`; history works without it. */
  readonly broadcaster?: EventBroadcaster;
  /**
   * Refuse a session before it is recorded — an agent or environment id this deployment does not
   * have, a client that may not use it. Throw a `ManagedServerError` (e.g. `ManagedInvalidRequestError`)
   * to refuse with that status. A catalog check only: resolving an environment, booting anything
   * or opening the runtime belongs to the worker.
   */
  readonly validateCreate?: (request: CreateValidationContext) => void | Promise<void>;
}

export interface CreateValidationContext {
  readonly sessionId: string;
  readonly agent: AgentRef;
  readonly environment: EnvironmentRef;
  readonly ownerKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StreamEventsOptions {
  /** Event types to preview on this connection (the stream's `event_deltas[]`). */
  readonly eventDeltas?: readonly ManagedPreviewableEventType[];
}

export class SessionService {
  private readonly work: SessionWork;
  private readonly metadata: ManagedSessionMetadataStore;
  private readonly ownerKey: string | undefined;
  private readonly idempotency: ManagedDeliveryIdempotencyStore;
  private readonly broadcaster: EventBroadcaster | undefined;
  private readonly validateCreate: SessionServiceOptions["validateCreate"];

  constructor(options: SessionServiceOptions) {
    this.work = options.work;
    this.metadata = options.metadataStore ?? new MemoryManagedSessionMetadataStore();
    this.ownerKey = options.ownerKey;
    this.idempotency = options.idempotencyStore ?? new MemoryManagedDeliveryIdempotencyStore();
    this.broadcaster = options.broadcaster;
    this.validateCreate = options.validateCreate;
  }

  /**
   * Register a session. Without `initial_events` this starts no work and provisions nothing;
   * with them, the messages are queued exactly as a later `sendEvents` would queue them.
   *
   * The agent and environment are recorded, not resolved — resolving them needs what a worker
   * holds, and doing it here would make creation depend on execution being available.
   */
  async create(request: CreateManagedSessionRequest): Promise<ManagedSessionResource> {
    const input = parseRequest(CreateSessionRequestSchema, request);
    const sessionId = input.id ?? `sesn_${randomUUID().replaceAll("-", "")}`;
    await this.validateCreate?.({
      sessionId,
      agent: input.agent,
      environment: { id: input.environment_id },
      ...(this.ownerKey !== undefined ? { ownerKey: this.ownerKey } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    const now = Date.now();
    const claimed = await this.metadata.create({
      version: 1,
      sessionId,
      agent: input.agent,
      environment: { id: input.environment_id },
      createdAt: now,
      updatedAt: now,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(this.ownerKey !== undefined ? { ownerKey: this.ownerKey } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    if (!claimed) throw new ManagedConflictError(`session "${sessionId}" already exists`);
    if (input.initial_events !== undefined && input.initial_events.length > 0) {
      await this.accept(sessionId, input.initial_events);
    }
    return this.retrieve(sessionId);
  }

  async retrieve(id: string): Promise<ManagedSessionResource> {
    return this.toResource(await this.requireMetadata(id));
  }

  async list(options: ListManagedSessionsOptions = {}): Promise<ListManagedSessionsResponse> {
    const limit = options.limit ?? 20;
    const descending = (options.order ?? "desc") === "desc";
    const visible = (await this.metadata.list())
      .filter((m) => m.deletedAt === undefined && (this.ownerKey === undefined || m.ownerKey === this.ownerKey))
      .sort((a, b) => (a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId)) * (descending ? -1 : 1));
    const after = options.page === undefined ? -1 : visible.findIndex((m) => m.sessionId === decodePage(options.page!));
    if (options.page !== undefined && after < 0) throw new ManagedInvalidRequestError("page does not name a session in this listing");
    const page = visible.slice(after + 1, after + 1 + limit);
    const hasMore = after + 1 + limit < visible.length;
    return {
      data: await Promise.all(page.map((m) => this.toResource(m))),
      next_page: hasMore ? encodePage(page.at(-1)!.sessionId) : null,
    };
  }

  async update(id: string, request: UpdateManagedSessionRequest): Promise<ManagedSessionResource> {
    const input = parseRequest(UpdateSessionRequestSchema, request);
    const metadata = await this.requireMetadata(id);
    const next: ManagedSessionMetadata = {
      ...metadata,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: Date.now(),
    };
    await this.metadata.update(next);
    return this.toResource(next);
  }

  /** Stop accepting events. A running session must be interrupted and idle first. */
  async archive(id: string): Promise<ManagedSessionResource> {
    const metadata = await this.requireMetadata(id);
    if (metadata.archivedAt !== undefined) return this.toResource(metadata);
    if ((await this.status(id)) === "running") {
      throw new ManagedConflictError(`session "${id}" is running; interrupt it and wait for idle before archiving`);
    }
    const now = Date.now();
    const next = { ...metadata, archivedAt: now, updatedAt: now };
    await this.metadata.update(next);
    return this.toResource(next);
  }

  /**
   * Delete a session: gone from the API at once, history included. A running session must be
   * interrupted and idle first.
   *
   * The runtime session behind it is the worker's to remove, not this object's — so the record
   * stays as a tombstone and the session is woken; the worker that claims it deletes the
   * runtime session and then the tombstone.
   */
  async delete(id: string): Promise<void> {
    const metadata = await this.requireMetadata(id);
    if ((await this.status(id)) === "running") {
      throw new ManagedConflictError(`session "${id}" is running; interrupt it and wait for idle before deleting`);
    }
    await this.metadata.update({ ...metadata, deletedAt: Date.now() });
    await this.work.purge(id);
    await this.work.wake(id);
  }

  /**
   * Accept events for a session. The write is awaited, so the response means the events survive
   * a crash — not that anything has acted on them yet. Each comes back with its id and
   * `processed_at: null`; the history shows it processed once a worker has dealt with it.
   */
  async sendEvents(
    id: string,
    request: SendManagedEventsRequest,
    idempotencyKey?: string,
  ): Promise<SendManagedEventsResponse> {
    const input = parseRequest(SendEventsRequestSchema, request);
    const metadata = await this.requireMetadata(id);
    if (metadata.archivedAt !== undefined) throw new ManagedConflictError(`session "${id}" is archived`);
    const run = (): Promise<SendManagedEventsResponse> => this.accept(id, input.events);
    return idempotencyKey === undefined ? run() : this.idempotency.run(id, idempotencyKey, run);
  }

  async listEvents(id: string, options: ListSessionEventsOptions = {}): Promise<ListSessionEventsResponse> {
    await this.requireMetadata(id);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new ManagedInvalidRequestError("limit must be an integer between 1 and 1000");
    }
    const order = options.order ?? "asc";
    let cursor: string | undefined;
    if (options.page !== undefined) {
      const decoded = decodeEventPage(options.page);
      if (decoded.order !== order) throw new ManagedInvalidRequestError("page was issued for a different order");
      cursor = decoded.sequence;
    }
    const page = await this.work.listEvents(id, { limit, order, ...(cursor !== undefined ? { page: cursor } : {}) });
    return {
      data: page.data,
      next_page: page.next === undefined ? null : encodeEventPage({ sequence: page.next, order }),
    };
  }

  /**
   * Follow a session's events from now on. Live-only, like Claude's stream: a client that needs
   * what came before reads `listEvents`, and one that reconnects fills the gap the same way.
   * The subscription is open when this resolves, so events sent after it are not missed.
   * Previews (`event_start` / `event_delta`) are delivered only for `eventDeltas`.
   */
  async stream(id: string, signal: AbortSignal, options: StreamEventsOptions = {}): Promise<AsyncIterable<ManagedStreamEvent>> {
    await this.requireMetadata(id);
    if (this.broadcaster === undefined) throw new Error("event streaming requires an EventBroadcaster");
    const queue = new EventQueue();
    const gate = new PreviewGate(new Set(options.eventDeltas ?? []));
    const unsubscribe = this.broadcaster.subscribe(id, (event) => {
      if (gate.admit(event, queue.backlog)) queue.push(event);
    });
    const close = (): void => {
      unsubscribe();
      queue.close();
    };
    if (signal.aborted) close();
    else signal.addEventListener("abort", close, { once: true });
    return {
      [Symbol.asyncIterator]: () => {
        const inner = queue[Symbol.asyncIterator]();
        return {
          next: () => inner.next(),
          return: async () => {
            signal.removeEventListener("abort", close);
            close();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private async accept(id: string, events: readonly SendManagedEventsRequest["events"][number][]): Promise<SendManagedEventsResponse> {
    const acceptedAt = Date.now();
    const data: ManagedInputResource[] = events.map((event) => ({
      ...event,
      id: `sevt_${randomUUID().replaceAll("-", "")}`,
      processed_at: null,
    }));
    await this.work.append(id, data.map((event) => ({ event, acceptedAt })));
    return { data };
  }

  /**
   * Read from the session's own events, not from who holds it: a worker keeps its lease for a
   * moment after the turn ends, and that is not work.
   *
   *  - `running`: something sent is still unprocessed (unless all of it waits on a confirmation
   *    nobody gave), or the last status the session reported is running and a worker holds it.
   *  - `rescheduling`: it reported running, but nobody holds it — its worker died mid-turn, and
   *    the next claim will close or continue the turn.
   *  - `idle` otherwise, including paused on `requires_action`.
   */
  private async status(id: string): Promise<ManagedSessionStatus> {
    const [pending, latest] = await Promise.all([this.work.pending(id), this.work.latestStatus(id)]);
    const blocked = latest?.type === "session.status_idle" && latest.stop_reason.type === "requires_action";
    const actionable = blocked
      ? pending.some((entry) => entry.event.type !== "user.message")
      : pending.length > 0;
    if (actionable) return "running";
    if (latest?.type === "session.status_running" || latest?.type === "session.status_rescheduled") {
      return (await this.work.peek(id)) ? "running" : "rescheduling";
    }
    return "idle";
  }

  private async toResource(metadata: ManagedSessionMetadata): Promise<ManagedSessionResource> {
    return {
      type: "session",
      id: metadata.sessionId,
      title: metadata.title ?? null,
      agent: { type: "agent", id: metadata.agent.id, ...(metadata.agent.version !== undefined ? { version: metadata.agent.version } : {}) },
      environment_id: metadata.environment.id,
      status: metadata.archivedAt !== undefined ? "terminated" : await this.status(metadata.sessionId),
      metadata: metadata.metadata ?? {},
      created_at: new Date(metadata.createdAt).toISOString(),
      updated_at: new Date(metadata.updatedAt).toISOString(),
      archived_at: metadata.archivedAt === undefined ? null : new Date(metadata.archivedAt).toISOString(),
    };
  }

  private async requireMetadata(id: string): Promise<ManagedSessionMetadata> {
    const metadata = await this.metadata.get(id);
    // A tombstone is gone as far as a client can tell; only the cleaning worker still reads it.
    if (metadata === undefined || metadata.deletedAt !== undefined) throw new ManagedSessionNotFoundError(id);
    return metadata;
  }
}

function encodePage(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function decodePage(page: string): string {
  return Buffer.from(page, "base64url").toString("utf8");
}

function encodeEventPage(cursor: { readonly sequence: string; readonly order: "asc" | "desc" }): string {
  return Buffer.from(JSON.stringify({ v: 1, s: cursor.sequence, o: cursor.order }), "utf8").toString("base64url");
}

function decodeEventPage(page: string): { readonly sequence: string; readonly order: "asc" | "desc" } {
  try {
    const parsed = JSON.parse(Buffer.from(page, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed["v"] === 1 && typeof parsed["s"] === "string" && /^\d+$/.test(parsed["s"]) && (parsed["o"] === "asc" || parsed["o"] === "desc")) {
      return { sequence: parsed["s"], order: parsed["o"] };
    }
  } catch {
    // Reported below.
  }
  throw new ManagedInvalidRequestError("invalid page cursor");
}

/**
 * A bounded async queue bridging a push callback to a `for await` loop.
 *
 * Bounded on purpose: a subscriber that cannot keep up must not turn an unbounded buffer into
 * memory growth. Overflow drops the OLDEST events — everything a worker publishes is also in
 * the history, so a client that fell behind recovers it from there.
 */
class EventQueue implements AsyncIterable<ManagedStreamEvent> {
  private readonly items: ManagedStreamEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ManagedStreamEvent>) => void> = [];
  private closed = false;
  private readonly capacity: number;

  constructor(capacity = 1024) {
    this.capacity = capacity;
  }

  get backlog(): number {
    return this.items.length;
  }

  push(event: ManagedStreamEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    if (this.items.length >= this.capacity) this.items.shift();
    this.items.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ManagedStreamEvent> {
    return {
      next: (): Promise<IteratorResult<ManagedStreamEvent>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Past this many undelivered events, a connection sheds deltas rather than fall further behind. */
const PREVIEW_SHED_BACKLOG = 256;
/** Previews a connection tracks at once; a turn has one open at a time, so this is slack. */
const MAX_OPEN_PREVIEWS = 64;

/**
 * Which previews one connection gets, per Claude's live-preview contract:
 *  - only the types it asked for, and only previews it saw start — a connection opened while a
 *    message is being generated gets no deltas for that message;
 *  - best effort: behind by too much, it stops delivering an event's deltas for good, so what
 *    it did deliver is still a prefix of the message's text.
 */
class PreviewGate {
  private readonly wanted: ReadonlySet<ManagedPreviewableEventType>;
  private readonly open = new Set<string>();

  constructor(wanted: ReadonlySet<ManagedPreviewableEventType>) {
    this.wanted = wanted;
  }

  admit(event: ManagedStreamEvent, backlog: number): boolean {
    switch (event.type) {
      case "event_start":
        if (!this.wanted.has(event.event.type)) return false;
        this.open.add(event.event.id);
        if (this.open.size > MAX_OPEN_PREVIEWS) this.open.delete(this.open.values().next().value!);
        return true;
      case "event_delta":
        if (!this.open.has(event.event_id)) return false;
        if (backlog >= PREVIEW_SHED_BACKLOG) {
          this.open.delete(event.event_id);
          return false;
        }
        return true;
      case "session.status_idle":
        // The turn is over: a preview still open was discarded with its attempt.
        this.open.clear();
        return true;
      default:
        this.open.delete(event.id);
        return true;
    }
  }
}
