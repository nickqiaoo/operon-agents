/**
 * `PromptOrigin` — a structured tag on a journaled message record saying WHERE the message
 * came from. It is the persistence-layer replacement for parsing intent back out of rendered
 * text: a settle notification carries `{kind:'background_task', …}` so a reducer reads the entity
 * id/status structurally instead of regexing a `<background-task-done>` tag.
 *
 * Lives at the store layer (below `loop`) so `AgentRecordBody` can carry it without a layer
 * inversion. Fields are primitives only — no import of capabilities/background types — so this
 * stays a leaf module. `status` is a plain string (the domain's own vocabulary).
 *
 * Pragmatic subset: only the kinds agent-framework produces today. Extensible by adding a
 * member when a new kind appears — kept a CLOSED discriminated union (no open `kind`) so
 * `origin.kind === '…'` narrows and exhaustiveness is checkable.
 */

export interface UserPromptOrigin {
  readonly kind: "user";
  /** Present when the message arrived via the SteerBus: the enqueue-time correlation id. */
  readonly steerId?: string;
  /**
   * Present when the message came through a durable inbox (`inbox.received`): the delivery it
   * arrived as. Still the user's OWN words — handed over by whoever holds the session's control
   * surface (a managed API caller), exactly as app-server's stdio is the user of a local
   * session. Contrast `external`, which relays another party's words.
   */
  readonly deliveryId?: string;
}

export interface UserFollowUpPromptOrigin {
  readonly kind: "user_follow_up";
  /** Present when the message arrived via the SteerBus: the enqueue-time correlation id. */
  readonly steerId?: string;
  /** See `UserPromptOrigin.deliveryId`. */
  readonly deliveryId?: string;
}

export interface InjectionOrigin {
  readonly kind: "injection";
  /** Stable injector identity used to restore its cadence after replay. Absent on legacy records. */
  readonly injectorId?: string;
  /** The emitted form/state (e.g. "full", "sparse", "todo_reminder"). */
  readonly variant: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: "background_task";
  readonly taskId: string;
  /** The background task's terminal status, or the entity's finer status when it reports one. */
  readonly status?: string;
  readonly agentId?: string;
  readonly runId?: string;
  /** Present when the message arrived via the SteerBus: the enqueue-time correlation id. */
  readonly steerId?: string;
}

/** A message an extension enqueued (cron fires, quota warnings, …). */
export interface ExtensionMessageOrigin {
  readonly kind: "extension";
  readonly extensionId: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  /** Present when the message arrived via the SteerBus: the enqueue-time correlation id. */
  readonly steerId?: string;
}

/** LEGACY (pre-extension cron): kept so journals written by the cron capability still parse. */
export interface CronJobOrigin {
  readonly kind: "cron_job";
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
  /** Present when the message arrived via the SteerBus: the enqueue-time correlation id. */
  readonly steerId?: string;
}

export interface CronMissedOrigin {
  readonly kind: "cron_missed";
  readonly count: number;
  /** Present when the message arrived via the SteerBus: the enqueue-time correlation id. */
  readonly steerId?: string;
}

export interface CompactionSummaryOrigin {
  readonly kind: "compaction_summary";
}

/** A message copied into a fresh conversation shard when ownership is handed to another agent. */
export interface HandoffSeedOrigin {
  readonly kind: "handoff_seed";
  readonly handoffId: string;
  readonly fromAddress: string;
}

export type ExternalOriginMetadataValue = string | number | boolean | null;

/** A prompt delivered by another agent/application through the host delivery API. */
export interface ExternalPromptOrigin {
  readonly kind: "external";
  readonly source: string;
  readonly deliveryId: string;
  readonly actor?: string;
  readonly metadata?: Readonly<Record<string, ExternalOriginMetadataValue>>;
  /** Present when the message was queued through the SteerBus. */
  readonly steerId?: string;
}

export type PromptOrigin =
  | UserPromptOrigin
  | UserFollowUpPromptOrigin
  | InjectionOrigin
  | BackgroundTaskOrigin
  | ExtensionMessageOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | CompactionSummaryOrigin
  | HandoffSeedOrigin
  | ExternalPromptOrigin;

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: "user" };
