import type { AgentEventBody } from "../events/events.ts";

/**
 * Sink for events emitted from inside the loop.
 *
 * ONE sink is threaded through run-turn → turn-step → tool-call. Each layer dispatches the
 * REAL `AgentEventBody` directly (`tool_execution_start`, `message_update`, …) — there is no
 * intermediate vocabulary to translate. The Runner provides the sink and its only job is to
 * add the `{ address, sessionId }` envelope (`emit(state, body)`). This mirrors the upstream
 * pi-agent design, where the loop emits AgentEvents through a single sink.
 *
 * (The loop has no `state`, so it cannot add the envelope itself — that is the sink's job.)
 *
 * The returned promise resolves once the event is published. Most emitters fire and forget; one
 * that must order something after delivery (a nested call announced before its approval is
 * asked) awaits it.
 */
export type LoopEventDispatcher = (event: AgentEventBody) => void | Promise<void>;
