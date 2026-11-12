/**
 * The managed wire protocol, shaped after Claude Managed Agents: a session is a resource, work
 * enters it as user events (`POST /sessions/{id}/events`), and everything the agent does comes
 * back as session events — listed from history (`GET /sessions/{id}/events`) or followed live
 * (`GET /sessions/{id}/events/stream`, live-only).
 *
 * None of these types come from the framework. The worker translates runtime events into this
 * vocabulary at the boundary (`server/wire-events.ts`); a client never sees a core record.
 */

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

export type TextBlock = { readonly type: "text"; readonly text: string };

export type ManagedSessionStatus = "idle" | "running" | "rescheduling" | "terminated";

export interface ManagedSessionResource {
  readonly type: "session";
  readonly id: string;
  readonly title: string | null;
  readonly agent: { readonly type: "agent"; readonly id: string; readonly version?: string };
  readonly environment_id: string;
  readonly status: ManagedSessionStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

export interface CreateManagedSessionRequest {
  /** Host extension: choose the id instead of having one minted. Letters, digits, `_` and `-`. */
  readonly id?: string;
  readonly title?: string;
  /** An agent id, or `{ type: "agent", id, version? }` as a session resource names it. */
  readonly agent: string | (AgentRef & { readonly type?: "agent" });
  readonly environment_id: string;
  /** Messages to queue as the session is created. Without them the session starts idle. */
  readonly initial_events?: readonly UserMessageEvent[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UpdateManagedSessionRequest {
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ListManagedSessionsOptions {
  readonly limit?: number;
  readonly page?: string;
  readonly order?: "asc" | "desc";
}

export interface ListManagedSessionsResponse {
  readonly data: readonly ManagedSessionResource[];
  readonly next_page: string | null;
}

// ── Events a client sends ────────────────────────────────────────────────────────────────────

export interface UserMessageEvent {
  readonly type: "user.message";
  readonly content: readonly TextBlock[];
}

export interface UserInterruptEvent {
  readonly type: "user.interrupt";
}

/** Answers an `agent.tool_use` the session is blocked on (`tool_use_id` is that event's `id`). */
export interface UserToolConfirmationEvent {
  readonly type: "user.tool_confirmation";
  readonly tool_use_id: string;
  readonly result: "allow" | "deny";
  readonly deny_message?: string;
}

/** Answers an `agent.custom_tool_use` (`custom_tool_use_id` is that event's `id`). */
export interface UserCustomToolResultEvent {
  readonly type: "user.custom_tool_result";
  readonly custom_tool_use_id: string;
  readonly content: readonly TextBlock[];
  readonly is_error?: boolean;
}

export type ManagedInputEvent =
  | UserMessageEvent
  | UserInterruptEvent
  | UserToolConfirmationEvent
  | UserCustomToolResultEvent;

/** A sent event as stored: `processed_at` stays null until a worker has dealt with it. */
export type ManagedInputResource = ManagedInputEvent & {
  readonly id: string;
  readonly processed_at: string | null;
};

export interface SendManagedEventsRequest {
  readonly events: readonly ManagedInputEvent[];
}

export interface SendManagedEventsResponse {
  readonly data: readonly ManagedInputResource[];
}

// ── Events a session emits ───────────────────────────────────────────────────────────────────

export type ManagedStopReason =
  | { readonly type: "end_turn" }
  | { readonly type: "requires_action"; readonly event_ids: readonly string[] };

/** Tokens one model request used, as `span.model_request_end` reports them. */
export interface ManagedModelUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
}

export type ManagedOutputEvent =
  | { readonly type: "agent.message"; readonly content: readonly TextBlock[] }
  | {
      readonly type: "agent.tool_use";
      readonly name: string;
      readonly input: unknown;
      /** `ask` when the session is blocked on a `user.tool_confirmation` for this call. */
      readonly evaluated_permission?: "allow" | "ask";
    }
  | { readonly type: "agent.custom_tool_use"; readonly name: string; readonly input: unknown }
  | {
      readonly type: "agent.tool_result";
      readonly tool_use_id: string;
      readonly content: unknown;
      readonly is_error: boolean;
    }
  | { readonly type: "span.model_request_start" }
  | {
      readonly type: "span.model_request_end";
      /** The `span.model_request_start` this request began with. */
      readonly model_request_start_id: string;
      /**
       * True when the request produced no message: it failed, was retried, was cut short, or
       * the turn ended without it. A preview still open at this point will not be reconciled.
       */
      readonly is_error: boolean;
      readonly model_usage: ManagedModelUsage | null;
    }
  | { readonly type: "session.status_running" }
  | { readonly type: "session.status_idle"; readonly stop_reason: ManagedStopReason }
  | { readonly type: "session.status_rescheduled" }
  | { readonly type: "session.error"; readonly error: { readonly type: string; readonly message: string } };

/** One entry of a session's event history: what was sent and what the session emitted. */
export type ManagedEventResource = (ManagedInputEvent | ManagedOutputEvent) & {
  readonly id: string;
  readonly processed_at: string | null;
};

export interface ListSessionEventsOptions {
  readonly limit?: number;
  readonly page?: string;
  readonly order?: "asc" | "desc";
}

export interface ListSessionEventsResponse {
  readonly data: readonly ManagedEventResource[];
  /** Pass back as `page` for the next page; null on the last one. */
  readonly next_page: string | null;
}

// ── Live previews (stream-only) ──────────────────────────────────────────────────────────────

/** Event types a stream connection may ask to preview with `event_deltas[]`. */
export type ManagedPreviewableEventType = "agent.message" | "agent.thinking";

/**
 * A previewed event is about to be produced. `event.id` is the id the buffered event will carry
 * when it arrives, so a client can match the preview to it.
 */
export interface ManagedEventStartPreview {
  readonly type: "event_start";
  readonly event: { readonly type: ManagedPreviewableEventType; readonly id: string };
}

/**
 * Incremental text for the event `event_id` previews. Concatenated in arrival order per
 * `(event_id, delta.index)`, the deltas form a prefix of that event's `content[index].text`.
 */
export interface ManagedEventDeltaPreview {
  readonly type: "event_delta";
  readonly event_id: string;
  readonly delta: { readonly type: "content_delta"; readonly index: number; readonly content: TextBlock };
}

/**
 * Stream-only, best-effort, never persisted: absent from the event history, not replayed on
 * reconnect, and delivered only to connections that opted in. The buffered event they preview
 * is always the authoritative record.
 */
export type ManagedPreviewEvent = ManagedEventStartPreview | ManagedEventDeltaPreview;

/** What a stream connection carries: persisted events, plus previews when it opted in. */
export type ManagedStreamEvent = ManagedEventResource | ManagedPreviewEvent;

export function isManagedPreviewEvent(event: ManagedStreamEvent): event is ManagedPreviewEvent {
  return event.type === "event_start" || event.type === "event_delta";
}

export interface StreamSessionEventsOptions {
  readonly signal?: AbortSignal;
  /**
   * Preview these event types live as they are generated (`event_start` / `event_delta`).
   * Only `agent.message` carries deltas; `agent.thinking` is accepted for compatibility and
   * yields nothing here, since sessions do not emit `agent.thinking`.
   */
  readonly event_deltas?: readonly ManagedPreviewableEventType[];
  /**
   * Reopen a dropped connection, filling the gap from the event history and skipping events
   * already delivered. Default true.
   */
  readonly reconnect?: boolean;
}

export interface ManagedApiError {
  readonly type: "error";
  readonly error: {
    readonly type: string;
    readonly message: string;
  };
}
