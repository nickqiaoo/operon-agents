import type { AgentEvent, InterruptAnswer, PendingRunInterrupt } from "operon-agents";

export const MANAGED_API_VERSION = "v1" as const;

/** Stable server-side reference to executable host code. */
export interface AgentRef {
  readonly id: string;
  readonly version?: string;
}

/** Stable server-side reference to a workspace/sandbox allocation policy. */
export interface EnvironmentRef {
  readonly id: string;
}

export interface ManagedSession {
  readonly id: string;
  readonly title?: string;
  readonly agent: AgentRef;
  readonly environment: EnvironmentRef;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly state: "idle" | "running" | "interrupted" | "closed";
  readonly activeTurnId: string | null;
  readonly hasQueuedMessages: boolean;
}

export interface CreateManagedSessionRequest {
  readonly id?: string;
  readonly title?: string;
  readonly agent: AgentRef | string;
  readonly environment: EnvironmentRef | string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** `PATCH /sessions/{id}`: rename a session. Only the title is client-writable after creation. */
export interface UpdateManagedSessionRequest {
  readonly title: string;
}

export interface ListManagedSessionsResponse {
  readonly data: readonly ManagedSession[];
}

export interface CreateManagedMessageRequest {
  readonly input: string;
  /**
   * Whose words these are.
   *
   * `user` (default): the caller's own. The party holding a session's credential is its user —
   * the same way a local session's stdin is — so the model sees the text bare, as a prompt.
   *
   * `external`: another party's words the caller is relaying (a peer, a webhook, another
   * agent). The model sees them inside an `<external-message>` envelope stamped as NOT from the
   * user. Declaring this lowers trust, so it needs no extra permission; the server's `authorize`
   * hook receives the value and can require it for a credential that only ever relays.
   */
  readonly origin?: "user" | "external";
  /** `external` only: what relayed the words (default `"managed-api"`). */
  readonly source?: string;
  /** `external` only: who said them. */
  readonly actor?: string;
  /** `external` only: attributes rendered onto the envelope. */
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  readonly mode?: "auto" | "steer" | "follow_up";
}

export interface DeliveryReceiptResource {
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly acceptedAt: number;
  readonly status: "started" | "queued";
  readonly channel: "turn" | "steering" | "follow_up";
  readonly steerId?: string;
}

export interface ListSessionEventsResponse {
  /** Durable AgentEvents in store order. Store sequence remains inside the opaque page cursor;
   *  `eventId` is the stable public identity shared with events.stream(). */
  readonly data: readonly AgentEvent[];
  readonly nextPage: string | null;
}

export interface ListSessionEventsOptions {
  readonly limit?: number;
  readonly page?: string;
  readonly order?: "asc" | "desc";
  readonly address?: string;
}

export interface StreamSessionEventsOptions {
  readonly signal?: AbortSignal;
  /** Exact AgentEvent address filter, matching events.list({ address }). */
  readonly address?: string;
  /**
   * Resume after this event id. Omit to replay the session's history first, then follow live.
   * The id to pass is the last one the previous stream delivered; see
   * `ManagedSessionEventStream.lastEventId`.
   */
  readonly after?: string;
  /**
   * Reopen the stream on a dropped connection, resuming after the last durable event seen,
   * with events already delivered filtered out. Default true. A client that wants to see the
   * drop itself — to decide, log, or back off on its own terms — turns it off.
   */
  readonly reconnect?: boolean;
}

export interface ManagedApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ResumeManagedSessionRequest {
  readonly answers: Readonly<Record<string, InterruptAnswer>>;
}

/**
 * Receipt for a control command (cancel, resume). Like a delivery receipt it means the command
 * is durable, not that it has been carried out: whoever holds the session acts on it next, and
 * if nobody does, the next worker to claim the session will.
 */
export interface ControlReceiptResource {
  readonly accepted: true;
  readonly commandId: string;
  readonly sessionId: string;
  readonly acceptedAt: number;
}

export type ResumeManagedSessionResponse = ControlReceiptResource;
export type CancelManagedSessionResponse = ControlReceiptResource;

export interface InterruptionsResponse {
  readonly data: readonly PendingRunInterrupt[];
}
