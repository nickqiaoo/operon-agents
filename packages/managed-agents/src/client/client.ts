import type { AgentEvent, InterruptAnswer } from "operon-agents";
import { parseSse, type SseFrame } from "../protocol/sse.ts";
import type {
  CancelManagedSessionResponse,
  CreateManagedMessageRequest,
  CreateManagedSessionRequest,
  DeliveryReceiptResource,
  InterruptionsResponse,
  ListSessionEventsOptions,
  ListSessionEventsResponse,
  ListManagedSessionsResponse,
  ManagedSession,
  ResumeManagedSessionResponse,
  StreamSessionEventsOptions,
} from "../protocol/types.ts";
import { ManagedApiClientError, throwApiError } from "./errors.ts";

export interface ManagedAgentsClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface CreateManagedMessageOptions {
  readonly idempotencyKey?: string;
}

/** Opens one SSE connection, resuming after `after` when given. */
type StreamConnector = (after: string | undefined) => Promise<AsyncIterator<SseFrame>>;

/** How many delivered event ids to remember for filtering a reconnect's overlap. */
const DEDUPE_WINDOW = 2048;
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;

/**
 * A session's events as one continuous iterable, across however many connections it takes.
 *
 * A dropped connection is not the end of the session, so by default it is not the end of the
 * iteration either: the stream reopens after the last durable event it delivered and filters
 * out what the overlap repeats. The cursor is the SSE `id:` the server stamps on durable events
 * only, so resuming never points at a live-only event (a token delta) that the log cannot find.
 */
export class ManagedSessionEventStream implements AsyncIterable<AgentEvent> {
  private readonly connect: StreamConnector;
  private readonly reconnect: boolean;
  private readonly signal: AbortSignal | undefined;
  private frames: AsyncIterator<SseFrame> | undefined;
  private consumed = false;
  private cursor: string | undefined;
  private readonly delivered = new Set<string>();
  private attempts = 0;

  constructor(
    connect: StreamConnector,
    first: AsyncIterator<SseFrame>,
    options: { readonly after?: string; readonly reconnect?: boolean; readonly signal?: AbortSignal },
  ) {
    this.connect = connect;
    this.frames = first;
    this.cursor = options.after;
    this.reconnect = options.reconnect ?? true;
    this.signal = options.signal;
  }

  /** The last resume cursor this stream delivered — pass it as `after` to continue elsewhere. */
  get lastEventId(): string | undefined {
    return this.cursor;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.consumed) throw new Error("managed session event stream can only be consumed once");
    this.consumed = true;
    return {
      next: () => this.next(),
      return: async () => {
        await this.frames?.return?.(undefined);
        this.frames = undefined;
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        if (this.frames?.throw !== undefined) await this.frames.throw(error);
        else await this.frames?.return?.(undefined);
        this.frames = undefined;
        throw error;
      },
    };
  }

  private async next(): Promise<IteratorResult<AgentEvent>> {
    for (;;) {
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
      const frame = result.value;
      if (frame.event !== "session.event") continue;
      const event = frame.data as AgentEvent;
      if (this.delivered.has(event.eventId)) continue;
      this.remember(event.eventId);
      if (frame.id !== undefined) this.cursor = frame.id;
      return { done: false, value: event };
    }
  }

  /** Reconnect after a drop. False when reconnecting is off or the caller has aborted. */
  private async reopen(): Promise<boolean> {
    this.frames = undefined;
    const aborted = (): boolean => this.signal?.aborted === true;
    if (!this.reconnect || aborted()) return false;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempts, RECONNECT_BACKOFF_MS.length - 1)]!;
    this.attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (aborted()) return false;
    try {
      this.frames = await this.connect(this.cursor);
      return true;
    } catch (error) {
      // A definite answer — gone, forbidden, malformed — will not change by asking again.
      if (error instanceof ManagedApiClientError && error.status < 500) throw error;
      // The server is still away: try again after the next backoff step, not forever at once.
      return this.reopen();
    }
  }

  private remember(eventId: string): void {
    this.delivered.add(eventId);
    if (this.delivered.size > DEDUPE_WINDOW) {
      const oldest = this.delivered.values().next().value;
      if (oldest !== undefined) this.delivered.delete(oldest);
    }
  }
}

export class ManagedSessionsClient {
  private readonly root: ManagedAgentsClient;

  constructor(root: ManagedAgentsClient) {
    this.root = root;
  }

  create(request: CreateManagedSessionRequest): Promise<ManagedSession> {
    return this.root.request("/sessions", { method: "POST", body: request });
  }

  list(): Promise<ListManagedSessionsResponse> {
    return this.root.request("/sessions");
  }

  retrieve(sessionId: string): Promise<ManagedSession> {
    return this.root.request(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  messages = {
    create: (
      sessionId: string,
      request: CreateManagedMessageRequest,
      options: CreateManagedMessageOptions = {},
    ): Promise<DeliveryReceiptResource> =>
      this.root.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: request,
        ...(options.idempotencyKey !== undefined
          ? { headers: { "idempotency-key": options.idempotencyKey } }
          : {}),
      }),
  };

  events = {
    list: (sessionId: string, options: ListSessionEventsOptions = {}): Promise<ListSessionEventsResponse> => {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.page !== undefined) query.set("page", options.page);
      if (options.order !== undefined) query.set("order", options.order);
      if (options.address !== undefined) query.set("address", options.address);
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return this.root.request(`/sessions/${encodeURIComponent(sessionId)}/events${suffix}`);
    },
    stream: async (sessionId: string, options: StreamSessionEventsOptions = {}): Promise<ManagedSessionEventStream> => {
      const connect: StreamConnector = async (after) => {
        const query = new URLSearchParams();
        if (options.address !== undefined) query.set("address", options.address);
        const suffix = query.size === 0 ? "" : `?${query.toString()}`;
        const response = await this.root.raw(`/sessions/${encodeURIComponent(sessionId)}/events/stream${suffix}`, {
          signal: options.signal,
          headers: {
            accept: "text/event-stream",
            ...(after !== undefined ? { "last-event-id": after } : {}),
          },
        });
        if (!response.ok) return throwApiError(response);
        if (response.body === null) throw new Error("event stream response has no body");
        return parseSse(response.body)[Symbol.asyncIterator]();
      };
      return new ManagedSessionEventStream(connect, await connect(options.after), {
        ...(options.after !== undefined ? { after: options.after } : {}),
        ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    },
  };

  cancel(sessionId: string): Promise<CancelManagedSessionResponse> {
    return this.root.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
  }

  delete(sessionId: string): Promise<void> {
    return this.root.requestVoid(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  interruptions(sessionId: string): Promise<InterruptionsResponse> {
    return this.root.request(`/sessions/${encodeURIComponent(sessionId)}/interruptions`);
  }

  resume(sessionId: string, answers: Readonly<Record<string, InterruptAnswer>>): Promise<ResumeManagedSessionResponse> {
    return this.root.request(`/sessions/${encodeURIComponent(sessionId)}/resume`, { method: "POST", body: { answers } });
  }
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

  async requestVoid(path: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.raw(path, options);
    if (!response.ok) return throwApiError(response);
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
