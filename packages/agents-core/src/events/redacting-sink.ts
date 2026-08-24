import { redactDeep, type RedactOptions } from "../logging/redact.ts";
import type { AgentEvent, AgentEventInput, AgentEventListener, EventSink } from "./events.ts";

const ENVELOPE_KEYS = new Set(["eventId", "address", "sessionId", "type"]);

export class RedactingSink implements EventSink {
  private readonly inner: EventSink;
  private readonly options: RedactOptions;

  constructor(inner: EventSink, options: RedactOptions = {}) {
    this.inner = inner;
    this.options = options;
  }

  emit(event: AgentEventInput): void | Promise<void> {
    return this.inner.emit(redactEvent(event, this.options));
  }

  subscribe(listener: AgentEventListener): () => void {
    return this.inner.subscribe(listener);
  }

  child(addressSegment: string): EventSink {
    return new RedactingSink(this.inner.child(addressSegment), this.options);
  }
}

function redactEvent(event: AgentEventInput, options: RedactOptions): AgentEventInput {
  const envelope: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (ENVELOPE_KEYS.has(key)) envelope[key] = value;
    else body[key] = value;
  }
  return { ...redactDeep(body, options), ...envelope } as AgentEventInput;
}
