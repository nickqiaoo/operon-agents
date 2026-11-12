/**
 * A TypeScript client for the managed API, shaped after the Claude SDK's managed-agents surface:
 * `sessions.create/retrieve/list/update/archive/delete` and
 * `sessions.events.send/list/stream`.
 */
import { parseSse, type SseFrame } from "../protocol/sse.ts";
import type {
  CreateManagedSessionRequest,
  ListManagedSessionsOptions,
  ListManagedSessionsResponse,
  ListSessionEventsOptions,
  ListSessionEventsResponse,
  ManagedEventResource,
  ManagedPreviewableEventType,
  ManagedSessionResource,
  ManagedStreamEvent,
  SendManagedEventsRequest,
  SendManagedEventsResponse,
  StreamSessionEventsOptions,
  UpdateManagedSessionRequest,
} from "../protocol/types.ts";
import { isManagedPreviewEvent } from "../protocol/types.ts";
import { ManagedApiClientError, throwApiError } from "./errors.ts";

export interface ManagedAgentsClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface SendManagedEventsOptions {
  /** Retries with the same key are accepted once. */
  readonly idempotencyKey?: string;
}

/** How many delivered event ids to remember for filtering a reconnect's overlap. */
const DEDUPE_WINDOW = 4096;
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;
/** How many history pages a reconnect reads back looking for where it left off. */
const MAX_GAP_PAGES = 20;

type Connect = () => Promise<AsyncIterator<SseFrame>>;
type History = (page: string | undefined) => Promise<ListSessionEventsResponse>;

/**
 * A session's live events as one continuous iterable, across however many connections it takes.
 *
 * The server's stream is live-only, so a dropped connection loses whatever was emitted while it
 * was down. By default this reconnects and fills that gap from the event history — newest first,
 * back to the last output it delivered — skipping ids it has already delivered.
 *
 * Opened with `event_deltas`, it also yields the live previews (`event_start` / `event_delta`)
 * as they come. Those are never deduplicated or recovered: a drop loses the deltas in flight,
 * and the buffered `agent.message` they preview arrives complete either way.
 */
export class ManagedSessionEventStream<E extends ManagedStreamEvent = ManagedEventResource> implements AsyncIterable<E> {
  private frames: AsyncIterator<SseFrame> | undefined;
  private readonly buffered: ManagedEventResource[] = [];
  private consumed = false;
  /** The newest history event this stream has accounted for — where a gap fill stops. */
  private anchor: string | undefined;
  private readonly delivered = new Set<string>();
  private attempts = 0;

  private readonly connect: Connect;
  private readonly history: History;
  private readonly options: { readonly reconnect: boolean; readonly signal?: AbortSignal };

  constructor(
    connect: Connect,
    history: History,
    first: AsyncIterator<SseFrame>,
    anchor: string | undefined,
    options: { readonly reconnect: boolean; readonly signal?: AbortSignal },
  ) {
    this.connect = connect;
    this.history = history;
    this.options = options;
    this.frames = first;
    this.anchor = anchor;
  }

  [Symbol.asyncIterator](): AsyncIterator<E> {
    if (this.consumed) throw new Error("a session event stream can only be consumed once");
    this.consumed = true;
    return {
      next: () => this.next(),
      return: async () => {
        await this.frames?.return?.(undefined);
        this.frames = undefined;
        return { done: true, value: undefined };
      },
    };
  }

  private async next(): Promise<IteratorResult<E>> {
    for (;;) {
      const queued = this.buffered.shift();
      if (queued !== undefined) {
        if (this.accept(queued)) return { done: false, value: queued as E };
        continue;
      }
      if (this.frames === undefined) return { done: true, value: undefined };
      let result: IteratorResult<SseFrame>;
      try {
        result = await this.frames.next();
      } catch (error) {
        if (!(await this.reopen())) throw error;
        continue;
      }
      if (result.done) {
        if (!(await this.reopen())) return { done: true, value: undefined };
        continue;
      }
      this.attempts = 0;
      const event = result.value.data as ManagedStreamEvent;
      if (typeof event !== "object" || event === null) continue;
      if (isManagedPreviewEvent(event)) return { done: false, value: event as E };
      if (typeof event.id !== "string") continue;
      if (this.accept(event)) return { done: false, value: event as E };
    }
  }

  private accept(event: ManagedEventResource): boolean {
    if (this.delivered.has(event.id)) return false;
    this.delivered.add(event.id);
    if (this.delivered.size > DEDUPE_WINDOW) {
      const oldest = this.delivered.values().next().value;
      if (oldest !== undefined) this.delivered.delete(oldest);
    }
    // Sent events are echoed when processed, out of their place in the history; only what the
    // session emitted marks how far the history has been seen.
    if (!event.type.startsWith("user.")) this.anchor = event.id;
    return true;
  }

  /** Reconnect after a drop, then queue what the history holds that the drop cost us. */
  private async reopen(): Promise<boolean> {
    this.frames = undefined;
    const aborted = (): boolean => this.options.signal?.aborted === true;
    for (;;) {
      if (!this.options.reconnect || aborted()) return false;
      const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempts, RECONNECT_BACKOFF_MS.length - 1)]!;
      this.attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (aborted()) return false;
      try {
        // Subscribe first, then read back: anything emitted in between is in one or the other.
        this.frames = await this.connect();
        this.buffered.push(...await this.gap());
        return true;
      } catch (error) {
        await this.frames?.return?.(undefined).catch(() => undefined);
        this.frames = undefined;
        // A definite answer — gone, forbidden, malformed — will not change by asking again.
        if (error instanceof ManagedApiClientError && error.status < 500) throw error;
      }
    }
  }

  private async gap(): Promise<ManagedEventResource[]> {
    const missed: ManagedEventResource[] = [];
    let page: string | undefined;
    for (let pages = 0; pages < MAX_GAP_PAGES; pages += 1) {
      const result = await this.history(page);
      for (const event of result.data) {
        if (event.id === this.anchor) return missed.reverse();
        if (!this.delivered.has(event.id)) missed.push(event);
      }
      if (result.next_page === null) break;
      page = result.next_page;
    }
    return missed.reverse();
  }
}

export class ManagedSessionsClient {
  private readonly root: ManagedAgentsClient;

  constructor(root: ManagedAgentsClient) {
    this.root = root;
  }

  create(request: CreateManagedSessionRequest): Promise<ManagedSessionResource> {
    return this.root.request("/sessions", { method: "POST", body: request });
  }

  list(options: ListManagedSessionsOptions = {}): Promise<ListManagedSessionsResponse> {
    return this.root.request(`/sessions${query(options)}`);
  }

  retrieve(sessionId: string): Promise<ManagedSessionResource> {
    return this.root.request(path(sessionId));
  }

  update(sessionId: string, request: UpdateManagedSessionRequest): Promise<ManagedSessionResource> {
    return this.root.request(path(sessionId), { method: "POST", body: request });
  }

  archive(sessionId: string): Promise<ManagedSessionResource> {
    return this.root.request(`${path(sessionId)}/archive`, { method: "POST" });
  }

  delete(sessionId: string): Promise<{ readonly id: string; readonly type: "session_deleted" }> {
    return this.root.request(path(sessionId), { method: "DELETE" });
  }

  readonly events = {
    send: (
      sessionId: string,
      request: SendManagedEventsRequest,
      options: SendManagedEventsOptions = {},
    ): Promise<SendManagedEventsResponse> =>
      this.root.request(`${path(sessionId)}/events`, {
        method: "POST",
        body: request,
        ...(options.idempotencyKey !== undefined ? { headers: { "idempotency-key": options.idempotencyKey } } : {}),
      }),

    list: (sessionId: string, options: ListSessionEventsOptions = {}): Promise<ListSessionEventsResponse> =>
      this.root.request(`${path(sessionId)}/events${query(options)}`),

    /**
     * Follow live events. Open it BEFORE sending: a stream carries only what is emitted after it
     * opens. Resolves once subscribed.
     */
    stream: (async (sessionId: string, options: StreamSessionEventsOptions = {}): Promise<ManagedSessionEventStream<ManagedStreamEvent>> => {
      const deltas = new URLSearchParams();
      for (const type of options.event_deltas ?? []) deltas.append("event_deltas[]", type);
      const search = deltas.size === 0 ? "" : `?${deltas.toString()}`;
      const connect: Connect = async () => {
        const response = await this.root.raw(`${path(sessionId)}/events/stream${search}`, {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          headers: { accept: "text/event-stream" },
        });
        if (!response.ok) return throwApiError(response);
        if (response.body === null) throw new Error("event stream response has no body");
        return parseSse(response.body)[Symbol.asyncIterator]();
      };
      const history: History = (page) => this.events.list(sessionId, { order: "desc", limit: 100, ...(page !== undefined ? { page } : {}) });
      const reconnect = options.reconnect ?? true;
      const first = await connect();
      // Where the history stood when we subscribed: a gap fill after a drop stops here.
      const anchor = reconnect ? (await history(undefined).catch(() => undefined))?.data.find((e) => !e.type.startsWith("user."))?.id : undefined;
      return new ManagedSessionEventStream<ManagedStreamEvent>(connect, history, first, anchor, {
        reconnect,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    }) as StreamEvents,
  };
}

/**
 * `sessions.events.stream`. Typed by whether previews were asked for: without `event_deltas`
 * the stream carries persisted events only, each with an `id`.
 */
export interface StreamEvents {
  (
    sessionId: string,
    options: StreamSessionEventsOptions & { readonly event_deltas: readonly ManagedPreviewableEventType[] },
  ): Promise<ManagedSessionEventStream<ManagedStreamEvent>>;
  (sessionId: string, options?: Omit<StreamSessionEventsOptions, "event_deltas">): Promise<ManagedSessionEventStream>;
}

function path(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

function query(options: { readonly limit?: number; readonly page?: string; readonly order?: string }): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.page !== undefined) params.set("page", options.page);
  if (options.order !== undefined) params.set("order", options.order);
  return params.size === 0 ? "" : `?${params.toString()}`;
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

export class ManagedAgentsClient {
  readonly sessions: ManagedSessionsClient;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultHeaders: Readonly<Record<string, string>>;

  constructor(options: ManagedAgentsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.defaultHeaders = {
      ...options.headers,
      ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
    };
    this.sessions = new ManagedSessionsClient(this);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(path, options);
    if (!response.ok) return throwApiError(response);
    return await response.json() as T;
  }

  raw(path: string, options: RequestOptions = {}): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...this.defaultHeaders,
        ...options.headers,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }
}
