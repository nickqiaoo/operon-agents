/**
 * Telemetry event registry — the single source of truth for what the framework counts.
 *
 * Every event is declared once, with a payload interface AND a description for every property.
 * Two type-level devices keep the registry from rotting:
 *
 *  - `properties: { [K in keyof P]-?: string }` — a payload property without a description does
 *    not compile. Documentation is part of the type.
 *  - `Exact<Expected, Actual>` on `track()` — an extra property at the call site does not compile.
 *    TypeScript's structural subtyping would otherwise let "one more field" through, and that is
 *    precisely how user data leaks into analytics.
 *
 * Red lines (see docs/telemetry.md §2): properties are counts, durations, enums and framework-owned
 * ids. Never prompts, tool args/results, paths, urls, model output. `session_id` / `address` /
 * `agent` are CONTEXT — stamped by the service, never passed at a call site.
 */

export type TelemetryPrimitive = string | number | boolean | null;

/** A payload: primitives only; `undefined` means "absent" and is dropped before fan-out. */
export type TelemetryProperties = Record<string, TelemetryPrimitive | undefined>;

/** Where the event's identity comes from. `session` events get `session_id` from context. */
export type TelemetryEventScope = "session" | "global";

/** Property names reserved for context. The registry rejects them as payload keys. */
export const RESERVED_TELEMETRY_KEYS: readonly string[] = ["session_id", "address", "agent", "distinct_id"];

/** Property names that are a content leak by construction. The registry test rejects them. */
export const FORBIDDEN_TELEMETRY_KEYS: readonly string[] = ["args", "arguments", "result", "content", "path", "cwd", "url", "prompt", "text", "output"];

export interface TelemetryEventDefinition<P extends TelemetryProperties = TelemetryProperties> {
  readonly owner: string;
  readonly comment: string;
  readonly scope: TelemetryEventScope;
  /** One human-readable line per payload property; `-?` makes optional properties mandatory here. */
  readonly properties: { readonly [K in keyof P]-?: string };
  /** Phantom carrier for the payload type; never set at runtime. */
  readonly payload?: P;
}

export interface TelemetryEventSpec<P extends TelemetryProperties> {
  readonly owner: string;
  readonly comment: string;
  readonly properties: { readonly [K in keyof P]-?: string };
}

/** A context-free event (a product-level "app opened", say). */
export function defineEvent<P extends TelemetryProperties>(spec: TelemetryEventSpec<P>): TelemetryEventDefinition<P> {
  return { ...spec, scope: "global" };
}

/** An event that belongs to a session: `session_id` arrives from context, never from the payload. */
export function defineSessionEvent<P extends TelemetryProperties>(spec: TelemetryEventSpec<P>): TelemetryEventDefinition<P> {
  return { ...spec, scope: "session" };
}

export type TelemetryRegistry = Readonly<Record<string, TelemetryEventDefinition>>;

export type PayloadOf<D> = D extends TelemetryEventDefinition<infer P> ? P : never;

/**
 * Exact-match check: `Actual` must be assignable to `Expected` AND carry no key `Expected` lacks.
 * Resolves to `never` on violation, which makes the `track()` argument uninhabitable — a compile
 * error at the call site rather than a silently wider payload.
 */
export type Exact<Expected, Actual> = Actual extends Expected ? (Exclude<keyof Actual, keyof Expected> extends never ? Actual : never) : never;

// ── The framework's own vocabulary ────────────────────────────────────────────────────────────────
// Everything below is derived from the `AgentEvent` stream by `projection.ts`. Products add their
// own registries with the same helpers and share the service (`service.withRegistry(...)`).

export type SessionStartedEvent = {
  /** `true` when the session was reopened from a store rather than created. */
  resumed: boolean;
}

export type TurnStartedEvent = {
  turn_id: string;
  /** `PromptOrigin.kind` (`user`, `user_follow_up`, `cron_job`, …) or `unknown`. */
  origin: string;
}

export type TurnFinishedEvent = {
  turn_id: string;
  reason: "completed" | "cancelled" | "failed";
  duration_ms: number;
  step_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Model id of the last assistant message in the turn; `null` when no model answered. */
  model: string | null;
}

export type ToolCallEvent = {
  turn_id: string | null;
  tool_name: string;
  outcome: "success" | "error";
  duration_ms: number;
}

export type ToolSuspendedEvent = {
  turn_id: string | null;
  tool_name: string;
  /** Whether the suspension carried an input request (approval / question) for the host. */
  has_request: boolean;
}

export type StepRetryEvent = {
  turn_id: string;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  /** Short, enum-ish retry reason (first 64 chars), or `null`. */
  reason: string | null;
}

export type SubagentSpawnedEvent = {
  /** Sub-agent profile name (`coder`, `explore`, …). */
  agent_name: string;
  /** Nesting depth: number of address segments below the root agent. */
  depth: number;
}

export type CompactionEvent = {
  before_tokens: number;
  after_tokens: number;
  compacted_count: number;
}

export type GuardrailBlockedEvent = {
  stage: "input" | "output" | "tool_input" | "tool_output";
  guardrail: string;
}

export type SkillActivatedEvent = {
  skill_name: string;
  trigger: "user-slash" | "model-tool" | "nested-skill";
}

export type SteerQueuedEvent = {
  channel: "steering" | "follow_up";
  /** `PromptOrigin.kind` of the queued message. */
  origin: string;
}

export type TurnErrorEvent = {
  turn_id: string | null;
  /** Error text after redaction, capped at 200 chars. */
  message: string;
}

export const FRAMEWORK_TELEMETRY_EVENTS = {
  session_started: defineSessionEvent<SessionStartedEvent>({
    owner: "operon-agents",
    comment: "A session's root agent started for the first time in this process.",
    properties: {
      resumed: "true when the session was reopened from a store rather than created fresh",
    },
  }),
  turn_started: defineSessionEvent<TurnStartedEvent>({
    owner: "operon-agents",
    comment: "A turn began. Pair with turn_finished on turn_id.",
    properties: {
      turn_id: "Per-session turn id; pair with session_id (context) to locate the turn",
      origin: "PromptOrigin.kind that triggered the turn (user, user_follow_up, cron_job, …) or unknown",
    },
  }),
  turn_finished: defineSessionEvent<TurnFinishedEvent>({
    owner: "operon-agents",
    comment: "A turn ended, for any reason. One per turn_started.",
    properties: {
      turn_id: "Per-session turn id; pair with session_id (context) to locate the turn",
      reason: "Why the turn ended; mirrors AgentEvent turn.ended.reason",
      duration_ms: "Wall-clock from turn.started to turn.ended",
      step_count: "LLM steps taken (turn.step.started count)",
      tool_call_count: "tool.call.started count within the turn",
      input_tokens: "Sum of assistant-message usage.input over the turn",
      output_tokens: "Sum of assistant-message usage.output over the turn",
      cache_read_tokens: "Sum of assistant-message usage.cacheRead over the turn",
      cache_write_tokens: "Sum of assistant-message usage.cacheWrite over the turn",
      model: "Model id of the last assistant message in the turn, or null",
    },
  }),
  tool_call: defineSessionEvent<ToolCallEvent>({
    owner: "operon-agents",
    comment: "A tool call completed (success or error). Emitted on tool.result.",
    properties: {
      turn_id: "Turn the call ran in, or null when it ran outside a turn",
      tool_name: "Tool identifier (builtin name or MCP server-prefixed name); never its arguments",
      outcome: "success or error, from tool.result.isError",
      duration_ms: "Wall-clock from tool.call.started to tool.result",
    },
  }),
  tool_suspended: defineSessionEvent<ToolSuspendedEvent>({
    owner: "operon-agents",
    comment: "A tool paused the turn waiting on the host (approval, question, detach).",
    properties: {
      turn_id: "Turn the tool ran in, or null",
      tool_name: "Tool identifier",
      has_request: "true when the suspension carried an input request for the host",
    },
  }),
  step_retry: defineSessionEvent<StepRetryEvent>({
    owner: "operon-agents",
    comment: "An LLM step is being retried after a transient failure.",
    properties: {
      turn_id: "Turn the step belongs to",
      attempt: "1-based attempt number about to run",
      max_attempts: "Configured retry ceiling",
      delay_ms: "Backoff before this attempt",
      reason: "Short retry reason (first 64 chars) or null",
    },
  }),
  subagent_spawned: defineSessionEvent<SubagentSpawnedEvent>({
    owner: "operon-agents",
    comment: "A sub-agent started under the root agent.",
    properties: {
      agent_name: "Sub-agent profile name (coder, explore, plan, or a custom profile)",
      depth: "Nesting depth below the root agent (1 = direct child)",
    },
  }),
  compaction: defineSessionEvent<CompactionEvent>({
    owner: "operon-agents",
    comment: "Context compaction completed.",
    properties: {
      before_tokens: "Context tokens before compaction",
      after_tokens: "Context tokens after compaction",
      compacted_count: "Number of messages folded into the summary",
    },
  }),
  guardrail_blocked: defineSessionEvent<GuardrailBlockedEvent>({
    owner: "operon-agents",
    comment: "A guardrail blocked input, output, or a tool call.",
    properties: {
      stage: "Which stage was blocked: input, output, tool_input, tool_output",
      guardrail: "Guardrail name",
    },
  }),
  skill_activated: defineSessionEvent<SkillActivatedEvent>({
    owner: "operon-agents",
    comment: "A skill was activated.",
    properties: {
      skill_name: "Skill name as registered; never its arguments or path",
      trigger: "How it was activated: user-slash, model-tool, nested-skill",
    },
  }),
  steer_queued: defineSessionEvent<SteerQueuedEvent>({
    owner: "operon-agents",
    comment: "A steer or follow-up message was queued for a running turn.",
    properties: {
      channel: "steering (interrupt the current step) or follow_up (after the turn)",
      origin: "PromptOrigin.kind of the queued message",
    },
  }),
  turn_error: defineSessionEvent<TurnErrorEvent>({
    owner: "operon-agents",
    comment: "A live error event surfaced on the session stream.",
    properties: {
      turn_id: "Active turn at the address the error surfaced on, or null",
      message: "Error text after redaction, capped at 200 chars",
    },
  }),
} as const satisfies TelemetryRegistry;

export type FrameworkTelemetryEvents = typeof FRAMEWORK_TELEMETRY_EVENTS;
