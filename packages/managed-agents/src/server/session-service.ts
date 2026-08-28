/**
 * The managed API surface: reads and writes of session state.
 *
 * Every method here is a store operation. Nothing opens a session, assembles capabilities,
 * connects an MCP server or boots a sandbox — that is what running a turn does, and running is
 * the worker's job (`SessionWorker`), reached by writing to the log rather than by calling in.
 *
 * The practical consequence is that this object is stateless and horizontally scalable: any
 * replica can serve any request for any session, because the session is not "somewhere" — it is
 * in the store. A gateway in front of it needs no lease lookup and no owner affinity; it is a
 * plain reverse proxy.
 *
 * What this deliberately does NOT have is an `open()`. A resource API that can only be reached
 * by first reviving a runtime makes every read a potential sandbox wake-up, which is how a
 * simple event-stream subscription ends up billing for compute.
 */
import {
  agentEventFromRecord,
  INTERRUPTION_STATE_KEY,
  newAgentEventId,
  flattenPendingInterrupts,
  parseInterruptionState,
  watchRecordsByPolling,
  SessionRepositoryConflictError,
  type AgentEvent,
  type AgentRecord,
  type DeleteSessionOptions,
  type ExternalOriginMetadataValue,
  type InterruptAnswer,
  type PendingRunInterrupt,
  type SessionRepository,
  type SessionStore,
  type SessionSummary,
} from "operon-agents";
import type {
  AgentRef,
  ControlReceiptResource,
  CreateManagedMessageRequest,
  CreateManagedSessionRequest,
  DeliveryReceiptResource,
  EnvironmentRef,
  ManagedSession,
  UpdateManagedSessionRequest,
} from "../protocol/types.ts";
import { CONTROL_RECORD_NAME, hasUnprocessedInbox, type ControlCommand } from "./inbox.ts";
import type { SessionWork } from "./work.ts";
import {
  MemoryManagedSessionMetadataStore,
  type ManagedSessionMetadata,
  type ManagedSessionMetadataStore,
} from "./metadata.ts";
import type { ManagedEnvironmentRegistry } from "./registries.ts";
import type { EventBroadcaster } from "./broadcast.ts";
import {
  MemoryManagedDeliveryIdempotencyStore,
  type ManagedDeliveryIdempotencyStore,
} from "./idempotency.ts";
import { ManagedConflictError, ManagedInvalidRequestError, ManagedSessionNotFoundError } from "./errors.ts";

export interface SessionServiceOptions {
  readonly repository: SessionRepository;
  /**
   * Where inputs and commands are written. Every accepted input goes through `work.append`,
   * which puts it in the session's log and wakes the session for a worker as one step — so
   * "accepted" means "will be claimed", not "is on disk somewhere a worker might look". MUST be
   * the same table the workers claim from.
   */
  readonly work: SessionWork;
  /** Resolves an environment to the durable `workDir` a session is created under. The machine
   *  half of a resolution belongs to the worker; nothing here executes. */
  readonly environments: ManagedEnvironmentRegistry;
  readonly metadataStore?: ManagedSessionMetadataStore;
  /**
   * Partition every session this service creates, and every session `list()` returns, under one
   * owner. A multi-tenant deployment builds one service per tenant so `list()` cannot reach
   * across tenants.
   *
   * Partition, not permission: `get`/`appendEvent` still resolve any id the repository holds.
   * Enforcing who may address a session stays with the authorization hook.
   */
  readonly ownerKey?: string;
  /** Collapses retried deliveries carrying the same key. Defaults to an in-process store, which
   *  is only correct for a single node — a multi-node deployment must supply a shared one. */
  readonly idempotencyStore?: ManagedDeliveryIdempotencyStore;
  /**
   * Low-latency delivery for `watchEvents`. Without one, the stream polls the store and carries
   * only what was persisted — correct, but a poll interval behind and missing live-only events
   * such as token deltas. With one, the store is used to backfill and the broadcast carries the
   * live tail.
   */
  readonly broadcaster?: EventBroadcaster;
  /**
   * How long a stream may be silent before the stall check runs.
   *
   * With the live channel, a worker dying mid-turn is invisible to a subscriber: the stream is
   * attached to this service, not to the worker, so it does not break — it simply goes quiet,
   * which is indistinguishable from a model thinking. The work table's lease (`work.peek`) is
   * what tells the two apart.
   */
  readonly stallCheckMs?: number;
}

export interface ListPersistedEventsOptions {
  readonly limit: number;
  readonly after?: string;
  readonly order?: "asc" | "desc";
  readonly address?: string;
}

export interface PersistedEventPage {
  readonly data: readonly AgentEvent[];
  readonly next?: string;
}

export interface WatchEventsOptions {
  /**
   * Resume after the event with this id — the public cursor, the one an SSE `id:` line carries.
   * Only durable events are valid here (see `isDurableAgentEvent`); an id the log does not
   * contain replays from the beginning, because guessing a position is worse than a duplicate
   * the client can dedupe.
   */
  readonly after?: string;
  readonly address?: string;
  readonly signal?: AbortSignal;
}

export class SessionService {
  private readonly repository: SessionRepository;
  private readonly environments: ManagedEnvironmentRegistry;
  private readonly metadata: ManagedSessionMetadataStore;
  private readonly ownerKey: string | undefined;
  private readonly work: SessionWork;
  private readonly idempotency: ManagedDeliveryIdempotencyStore;
  private readonly broadcaster: EventBroadcaster | undefined;
  private readonly stallCheckMs: number;

  constructor(options: SessionServiceOptions) {
    this.repository = options.repository;
    this.environments = options.environments;
    this.metadata = options.metadataStore ?? new MemoryManagedSessionMetadataStore();
    this.ownerKey = options.ownerKey;
    this.work = options.work;
    this.idempotency = options.idempotencyStore ?? new MemoryManagedDeliveryIdempotencyStore();
    this.broadcaster = options.broadcaster;
    this.stallCheckMs = options.stallCheckMs ?? 20_000;
  }

  /**
   * Is this session waiting on work nobody is doing?
   *
   * BOTH conditions are required, and each alone is a false positive waiting to happen: an idle
   * session has no holder and that is fine, and a session mid-turn has unprocessed input right
   * up until the cursor advances. Only "there is work AND nobody holds it" is unambiguous.
   *
   * Undefined when it cannot be determined (the table cannot be asked), because reporting a
   * problem on missing evidence is worse than reporting nothing.
   */
  private async isStranded(id: string): Promise<boolean | undefined> {
    try {
      if (await this.work.peek(id)) return false;
      // Waiting on a person is not waiting on a worker.
      if ((await this.summary(id)).durableState === "interrupted") return false;
      const store = await this.openStore(id);
      try {
        // Unprocessed INBOX, not "cursor behind the log head": every turn writes records after
        // the input it answered, so the head is past the cursor on every session that has ever
        // run. Only inputs and commands after the cursor mean there is work.
        return await hasUnprocessedInbox(store);
      } finally {
        await store.close?.();
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Register a session. Creating it starts no work and provisions nothing: the record exists in
   * the repository and a worker picks it up the first time there is something to process.
   *
   * The agent reference is recorded, not resolved — turning it into an `Agent` needs the model
   * and tool configuration a worker holds, and doing it here would make creation depend on
   * execution being available.
   */
  async create(input: CreateManagedSessionRequest): Promise<ManagedSession> {
    assertCreateSessionRequest(input);
    const agent = agentRef(input.agent);
    const environment = environmentRef(input.environment);
    const resolved = await this.environments.resolve(environment);
    const now = Date.now();
    const sessionId = input.id ?? managedSessionId();
    // Metadata is the write-ahead identity record: after the repository commits, a crash must
    // never leave a durable session the managed layer cannot resolve on restart.
    const claimed = await this.metadata.create({
      version: 1,
      sessionId,
      agent,
      environment,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: now,
      updatedAt: now,
    });
    if (!claimed) throw new ManagedConflictError(`session "${sessionId}" already exists`);
    try {
      const handle = await this.repository.create({
        id: sessionId,
        workDir: resolved.workDir,
        ...(this.ownerKey !== undefined ? { ownerKey: this.ownerKey } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
      await handle.store.close?.();
    } catch (error) {
      await this.metadata.delete(sessionId).catch(() => undefined);
      if (error instanceof SessionRepositoryConflictError) throw new ManagedConflictError(error.message);
      throw error;
    }
    return {
      id: sessionId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      agent,
      environment,
      createdAt: now,
      updatedAt: now,
      state: "idle",
      activeTurnId: null,
      hasQueuedMessages: false,
    };
  }

  async get(id: string): Promise<ManagedSession> {
    const metadata = await this.requireMetadata(id);
    const summary = await this.summary(id);
    return this.toManagedSession(summary, metadata);
  }

  /**
   * Rename a session. The title lives in the session's own `meta` state, so the write goes
   * through the store — the same path `create` takes — and reaches the repository catalog via
   * the store's observer before this resolves. Like `interruptions`, it opens the store beside
   * whoever may be running the session: `meta` is written by nobody during a turn.
   */
  async update(id: string, input: UpdateManagedSessionRequest): Promise<ManagedSession> {
    assertUpdateSessionRequest(input);
    const metadata = await this.requireMetadata(id);
    await this.summary(id);
    const handle = await this.repository.open(id);
    if (handle === undefined) throw new ManagedSessionNotFoundError(id);
    try {
      const meta = await handle.store.getState("meta");
      if (!isRecord(meta)) throw new Error(`session "${id}" has no meta state`);
      await handle.store.putState("meta", { ...meta, title: input.title, updatedAt: Date.now() });
    } finally {
      await handle.store.close?.();
    }
    return this.toManagedSession(await this.summary(id), metadata);
  }

  async list(): Promise<readonly ManagedSession[]> {
    const summaries = await this.repository.list(
      this.ownerKey !== undefined ? { ownerKey: this.ownerKey } : undefined,
    );
    const metadataById = await this.metadata.getMany(summaries.map((summary) => summary.id));
    const result: ManagedSession[] = [];
    for (const summary of summaries) {
      const metadata = metadataById.get(summary.id);
      if (metadata === undefined) continue;
      result.push(this.toManagedSession(summary, metadata));
    }
    return result;
  }

  async listEvents(id: string, options: ListPersistedEventsOptions): Promise<PersistedEventPage> {
    await this.requireMetadata(id);
    const store = await this.openStore(id);
    try {
      let cursor = options.after;
      // Read ahead until one extra PROJECTABLE event is found. Records such as metadata,
      // permission and config are intentionally absent from AgentEvent; they must not create a
      // second managed-only event vocabulary merely to make pages look full.
      const wanted = options.limit + 1;
      const events: { readonly sequence: string; readonly event: AgentEvent }[] = [];
      let exhausted = false;
      while (events.length < wanted && !exhausted) {
        const page = await store.readRecordPage({
          limit: Math.max(64, wanted - events.length),
          ...(cursor !== undefined ? { after: cursor } : {}),
          ...(options.order !== undefined ? { order: options.order } : {}),
          ...(options.address !== undefined ? { address: options.address } : {}),
        });
        for (const stored of page.data) {
          cursor = stored.sequence;
          const event = agentEventFromRecord(stored.record, id);
          if (event !== undefined) events.push({ sequence: stored.sequence, event });
          if (events.length === wanted) break;
        }
        if (events.length === wanted) break;
        if (page.next === undefined) exhausted = true;
        else cursor = page.next;
      }
      const pageItems = events.slice(0, options.limit);
      return {
        data: pageItems.map((item) => item.event),
        ...(events.length > options.limit && pageItems.length > 0
          ? { next: pageItems[pageItems.length - 1]!.sequence }
          : {}),
      };
    } finally {
      await store.close?.();
    }
  }

  /**
   * Follow a session's events from a cursor.
   *
   * Order of operations matters and is the whole reason this is not two loops glued together:
   * the broadcast subscription is opened FIRST and buffered, the store is read second, and only
   * then does the buffer drain. Reading first and subscribing after leaves a window in which
   * events land in neither — the exact race a client cannot detect, because the stream simply
   * appears to skip.
   *
   * Duplicates across the seam are removed by event id: an event may legitimately arrive from
   * both sides when it was persisted just as the backfill was catching up.
   *
   * Without a broadcaster this degrades to polling the store, which carries only persisted
   * events. That is correct, just later and thinner.
   */
  async *watchEvents(id: string, options: WatchEventsOptions = {}): AsyncIterable<AgentEvent> {
    await this.requireMetadata(id);
    if (this.broadcaster === undefined) {
      yield* this.watchStore(id, options);
      return;
    }

    const queue = new EventQueue();
    const matches = (event: AgentEvent): boolean =>
      options.address === undefined || event.address === options.address;
    const unsubscribe = this.broadcaster.subscribe(id, (event) => {
      if (matches(event)) queue.push(event);
    });
    const stopSubscription = (): void => {
      unsubscribe();
      queue.close();
    };
    options.signal?.addEventListener("abort", stopSubscription, { once: true });

    try {
      const seen = new Set<string>();
      // Backfill. The subscription is already buffering everything produced meanwhile.
      // Events from the live side that the backfill has not reached yet are the overlap; the
      // cursor only bounds how far back the backfill starts, never what the live side carries.
      const backfill = new AbortController();
      const onAbort = (): void => backfill.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for await (const event of this.watchStore(id, {
          ...options,
          signal: backfill.signal,
          untilCaughtUp: true,
        })) {
          seen.add(event.eventId);
          yield event;
        }
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.signal?.aborted === true) return;

      // Hand over to the live tail, dropping anything the backfill already produced.
      let warnedStranded = false;
      for await (const event of queue.withIdleTicks(this.stallCheckMs)) {
        if (event === IDLE) {
          // Silence is only meaningful if the session is supposed to be busy.
          if (warnedStranded) continue;
          const stranded = await this.isStranded(id);
          if (stranded !== true) continue;
          warnedStranded = true;
          yield {
            type: "warning",
            message:
              "This session has unprocessed input but no runner holds it — it is waiting to be " +
              "picked up. Work resumes automatically once a worker claims it.",
            address: options.address ?? "main",
            sessionId: id,
            eventId: `evt_stalled_${String(Date.now())}`,
          } as unknown as AgentEvent;
          continue;
        }
        warnedStranded = false;
        if (seen.size > 0 && seen.has(event.eventId)) continue;
        // The overlap window closes once the first non-duplicate arrives; keeping the set around
        // after that would grow without bound for the life of the connection.
        if (seen.size > 0) seen.clear();
        yield event;
      }
    } finally {
      options.signal?.removeEventListener("abort", stopSubscription);
      stopSubscription();
    }
  }

  /** Read the log, either to the current head (`untilCaughtUp`) or indefinitely. */
  private async *watchStore(
    id: string,
    options: WatchEventsOptions & { readonly untilCaughtUp?: boolean },
  ): AsyncIterable<AgentEvent> {
    const store = await this.openStore(id);
    try {
      // The public cursor is an event id; the store's is a sequence. Translate once, up front.
      let cursor = options.after === undefined
        ? undefined
        : await sequenceOfEvent(store, options.after, options.address);
      if (options.untilCaughtUp === true) {
        for (;;) {
          if (options.signal?.aborted === true) return;
          const page = await store.readRecordPage({
            limit: 256,
            ...(cursor !== undefined ? { after: cursor } : {}),
            ...(options.address !== undefined ? { address: options.address } : {}),
          });
          for (const stored of page.data) {
            cursor = stored.sequence;
            const event = agentEventFromRecord(stored.record, id);
            if (event !== undefined) yield event;
          }
          if (page.data.length < 256) return;
        }
      }
      const watch = store.watch?.bind(store) ?? ((o: Parameters<typeof watchRecordsByPolling>[1]) =>
        watchRecordsByPolling(store, o));
      for await (const stored of watch({
        ...(cursor !== undefined ? { after: cursor } : {}),
        ...(options.address !== undefined ? { address: options.address } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })) {
        const event = agentEventFromRecord(stored.record, id);
        if (event !== undefined) yield event;
      }
    } finally {
      await store.close?.();
    }
  }

  async interruptions(id: string): Promise<readonly PendingRunInterrupt[]> {
    await this.requireMetadata(id);
    const store = await this.openStore(id);
    try {
      const raw = await store.getState(INTERRUPTION_STATE_KEY);
      return raw === null ? [] : flattenPendingInterrupts(parseInterruptionState(raw));
    } finally {
      await store.close?.();
    }
  }

  /**
   * Accept an input and return a receipt. The write is awaited, so the receipt means the input
   * survives a crash — not merely that it reached a process.
   *
   * Acceptance is all this does. Whether the input steers a turn already in flight or starts a
   * fresh one is decided when a worker processes it, which can be an arbitrary moment later.
   */
  async appendEvent(
    id: string,
    request: CreateManagedMessageRequest,
    idempotencyKey?: string,
  ): Promise<DeliveryReceiptResource> {
    assertCreateMessageRequest(request);
    if (idempotencyKey !== undefined) {
      return this.idempotency.run(id, idempotencyKey, () => this.acceptEvent(id, request));
    }
    return this.acceptEvent(id, request);
  }

  private async acceptEvent(
    id: string,
    request: CreateManagedMessageRequest,
  ): Promise<DeliveryReceiptResource> {
    const summary = await this.summary(id);
    await this.requireMetadata(id);
    if (summary.durableState === "interrupted") {
      throw new ManagedConflictError(`session "${id}" is interrupted; resume it before delivering new work`);
    }
    const acceptedAt = Date.now();
    const deliveryId = managedDeliveryId();
    const mode = request.mode ?? "auto";
    await this.work.append(id, {
      type: "inbox.received",
      // Assigned here because this writes through a plain repository handle, not through a
      // session's publishing store (which stamps one on the way past). Without it the record
      // is unprojectable — invisible to `listEvents` and to every client, whose reconnect
      // protocol dedupes on exactly this id.
      eventId: newAgentEventId(),
      time: acceptedAt,
      address: "main",
      input: request.input,
      // Whose words, not which transport: the caller is this session's user unless it says it is
      // relaying someone else's. `mode` is the record's own field, so the origin never carries
      // `user_follow_up` — the worker files a `user` delivery by mode when it dispatches.
      origin: request.origin === "external"
        ? {
            kind: "external",
            source: request.source ?? "managed-api",
            deliveryId,
            ...(request.actor !== undefined ? { actor: request.actor } : {}),
            ...(request.metadata !== undefined
              ? { metadata: request.metadata as Readonly<Record<string, ExternalOriginMetadataValue>> }
              : {}),
          }
        : { kind: "user", deliveryId },
      mode,
    } satisfies AgentRecord);
    return {
      deliveryId,
      sessionId: id,
      acceptedAt,
      status: "queued",
      channel: mode === "follow_up" ? "follow_up" : mode === "steer" ? "steering" : "turn",
    };
  }

  /**
   * Ask whoever is running this session to stop, or — if nobody is — discard what is waiting.
   *
   * Written to the log like an input, and for the same reason: the process running the turn
   * may be anywhere, and the only address every node shares is the store. The holder learns of
   * it from its next heartbeat and reads it; with no holder the next worker to claim the
   * session reads it first and skips the inputs it precedes.
   */
  async requestCancel(id: string, options: { readonly actor?: string } = {}): Promise<ControlReceiptResource> {
    return this.appendControl(id, {
      kind: "cancel",
      commandId: managedCommandId(),
      requestedAt: Date.now(),
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
    });
  }

  /**
   * Answer a durable interruption. The answers are journaled with the command, so a worker
   * that dies mid-continuation leaves nothing for the client to resend: the next holder reads
   * the same record and continues from the last durable pause.
   */
  async answerInterruption(
    id: string,
    answers: Readonly<Record<string, InterruptAnswer>>,
    options: { readonly actor?: string } = {},
  ): Promise<ControlReceiptResource> {
    if ((await this.summary(id)).durableState !== "interrupted") {
      throw new ManagedConflictError(`session "${id}" has no interrupted run to resume`);
    }
    return this.appendControl(id, {
      kind: "resume",
      commandId: managedCommandId(),
      requestedAt: Date.now(),
      answers,
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
    });
  }

  private async appendControl(id: string, command: ControlCommand): Promise<ControlReceiptResource> {
    await this.requireMetadata(id);
    await this.summary(id);
    await this.work.append(id, {
      type: "custom",
      name: CONTROL_RECORD_NAME,
      time: command.requestedAt,
      address: "main",
      data: command,
    } satisfies AgentRecord);
    return { accepted: true, commandId: command.commandId, sessionId: id, acceptedAt: command.requestedAt };
  }

  /**
   * Soft by default: the durable record and its managed metadata are retained, and every route
   * that resolves a session starts returning 404. `{ purge: true }` destroys both — deliberately
   * not reachable over HTTP, so retention stays a decision the host makes on its own schedule.
   */
  async delete(id: string, options?: DeleteSessionOptions): Promise<void> {
    await this.requireMetadata(id);
    await this.repository.delete(id, options);
    if (options?.purge === true) await this.metadata.delete(id);
  }

  /** Undo a soft delete. Throws when the session was purged (its metadata is gone). */
  async restore(id: string): Promise<void> {
    await this.requireMetadata(id);
    await this.repository.restore(id);
  }

  private async openStore(id: string): Promise<SessionStore> {
    const handle = await this.repository.open(id);
    if (handle === undefined) throw new ManagedSessionNotFoundError(id);
    return handle.store;
  }

  private async requireMetadata(id: string): Promise<ManagedSessionMetadata> {
    const metadata = await this.metadata.get(id);
    if (metadata === undefined) throw new ManagedSessionNotFoundError(id);
    return metadata;
  }

  private async summary(id: string): Promise<SessionSummary> {
    const summary = await this.repository.get(id);
    // `get` on the repository deliberately still returns a soft-deleted session — it is the
    // audit read. The managed API is the other side of that line: to a client, deleted is gone.
    if (summary === undefined || summary.deletedAt !== undefined) throw new ManagedSessionNotFoundError(id);
    return summary;
  }

  private toManagedSession(summary: SessionSummary, metadata: ManagedSessionMetadata): ManagedSession {
    return {
      id: summary.id,
      ...(summary.title !== undefined ? { title: summary.title } : {}),
      agent: metadata.agent,
      environment: metadata.environment,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      state: summary.durableState === "interrupted" ? "interrupted" : "idle",
      activeTurnId: null,
      hasQueuedMessages: false,
    };
  }
}

function agentRef(value: AgentRef | string): AgentRef {
  if (typeof value === "string") {
    if (!value.trim()) throw new ManagedInvalidRequestError("agent id must not be empty");
    return { id: value };
  }
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    throw new ManagedInvalidRequestError("agent must be an id string or an object with a non-empty id");
  }
  if (value.version !== undefined && typeof value.version !== "string") {
    throw new ManagedInvalidRequestError("agent version must be a string");
  }
  return value;
}

function environmentRef(value: EnvironmentRef | string): EnvironmentRef {
  if (typeof value === "string") {
    if (!value.trim()) throw new ManagedInvalidRequestError("environment id must not be empty");
    return { id: value };
  }
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    throw new ManagedInvalidRequestError("environment must be an id string or an object with a non-empty id");
  }
  return value as EnvironmentRef;
}

function assertCreateSessionRequest(input: unknown): asserts input is CreateManagedSessionRequest {
  if (!isRecord(input)) throw new ManagedInvalidRequestError("request body must be an object");
  if (input.id !== undefined && (typeof input.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.id))) {
    throw new ManagedInvalidRequestError("session id may contain only letters, digits, underscores and hyphens");
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    throw new ManagedInvalidRequestError("title must be a string");
  }
  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    throw new ManagedInvalidRequestError("metadata must be an object");
  }
  agentRef(input.agent as AgentRef | string);
  environmentRef(input.environment as EnvironmentRef | string);
}

function assertUpdateSessionRequest(input: unknown): asserts input is UpdateManagedSessionRequest {
  if (!isRecord(input)) throw new ManagedInvalidRequestError("request body must be an object");
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new ManagedInvalidRequestError("title must be a non-empty string");
  }
}

function assertCreateMessageRequest(input: unknown): asserts input is CreateManagedMessageRequest {
  if (!isRecord(input)) throw new ManagedInvalidRequestError("request body must be an object");
  if (typeof input.input !== "string" || !input.input.trim()) {
    throw new ManagedInvalidRequestError("input must not be empty");
  }
  if (input.origin !== undefined && input.origin !== "user" && input.origin !== "external") {
    throw new ManagedInvalidRequestError("origin must be user or external");
  }
  if (input.origin !== "external" && (input.source !== undefined || input.actor !== undefined || input.metadata !== undefined)) {
    throw new ManagedInvalidRequestError('source, actor and metadata describe a relayed delivery; set origin: "external"');
  }
  if (input.source !== undefined && (typeof input.source !== "string" || !input.source.trim())) {
    throw new ManagedInvalidRequestError("source must be a non-empty string");
  }
  if (input.actor !== undefined && typeof input.actor !== "string") {
    throw new ManagedInvalidRequestError("actor must be a string");
  }
  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    throw new ManagedInvalidRequestError("metadata must be an object");
  }
  if (input.mode !== undefined && input.mode !== "auto" && input.mode !== "steer" && input.mode !== "follow_up") {
    throw new ManagedInvalidRequestError("mode must be auto, steer or follow_up");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let managedIdCounter = 0;
function managedSessionId(): string {
  managedIdCounter += 1;
  return `ms_${Date.now().toString(36)}_${managedIdCounter.toString(36)}`;
}

let deliveryCounter = 0;
function managedDeliveryId(): string {
  deliveryCounter += 1;
  return `delivery_${Date.now().toString(36)}_${deliveryCounter.toString(36)}`;
}

let commandCounter = 0;
function managedCommandId(): string {
  commandCounter += 1;
  return `cmd_${Date.now().toString(36)}_${commandCounter.toString(36)}`;
}

/**
 * Find the log position of a public event id, scanning backwards because a resume cursor is
 * almost always near the tail. Undefined when the log has no such event — a live-only id, or
 * one from a session this is not — in which case the caller replays from the start.
 */
async function sequenceOfEvent(store: SessionStore, eventId: string, address?: string): Promise<string | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await store.readRecordPage({
      limit: 256,
      order: "desc",
      ...(cursor !== undefined ? { after: cursor } : {}),
      ...(address !== undefined ? { address } : {}),
    });
    for (const stored of page.data) {
      if ((stored.record as AgentRecord).eventId === eventId) return stored.sequence;
    }
    if (page.next === undefined) return undefined;
    cursor = page.next;
  }
}

/**
 * A bounded async queue bridging a push callback to a `for await` loop.
 *
 * Bounded on purpose: a subscriber that cannot keep up must not turn an unbounded buffer into
 * memory growth. Overflow drops the OLDEST events, because the newest are what a live view
 * needs — and anything dropped that was persisted is still recoverable from the log.
 */
const IDLE = Symbol("idle");

class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;
  private readonly capacity: number;

  constructor(capacity = 1024) {
    this.capacity = capacity;
  }

  push(event: AgentEvent): void {
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

  /**
   * The same stream, but yielding `IDLE` whenever nothing has arrived for `ms`.
   *
   * A quiet stream is ambiguous — the model may be thinking, or whoever was running may be gone.
   * The tick is what gives a consumer a chance to find out; it carries no information itself.
   */
  async *withIdleTicks(ms: number): AsyncIterable<AgentEvent | typeof IDLE> {
    for (;;) {
      const next = this[Symbol.asyncIterator]().next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), ms);
        timer.unref?.();
      });
      const winner = await Promise.race([next, idle]);
      if (winner === IDLE) {
        yield IDLE;
        // The pending `next` stays pending and resolves on the following loop's race.
        continue;
      }
      if (timer !== undefined) clearTimeout(timer);
      if (winner.done === true) return;
      yield winner.value;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<AgentEvent>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
