# operon-managed-agents

Managed HTTP/SSE server and TypeScript client for `operon-agents`. One package contains
three public surfaces:

- `operon-managed-agents/protocol` — wire/resource types and SSE codec
- `operon-managed-agents/server` — Session host, registries and HTTP server
- `operon-managed-agents/client` — typed client SDK

The wire contract deliberately separates writes from observation. `messages.create()`
returns an acceptance receipt immediately; `events.stream()` is a session-scoped stream
that survives individual turns and therefore carries background completion and idle-wake
events too.

```ts
const session = await client.sessions.create({
  agent: "default",
  environment: "workspace",
});

const stream = await client.sessions.events.stream(session.id);
await client.sessions.messages.create(session.id, { input: "inspect this repository" });

for await (const event of stream) console.log(event);
```

The external observation API has two deliberately separate operations:

- `sessions.events.list()` pages persisted history as `AgentEvent[]`; `nextPage` is opaque.
- `sessions.events.stream()` is a pure live `AsyncIterable<AgentEvent>` with no synthetic first event.

Every event has a stable `eventId`. Durable events keep that same identity in `list()` and
`stream()`, so a reconnecting client can open the stream first, page history second, and
deduplicate the overlap without a loss window. Low-frequency lifecycle events needed to
rebuild state (`agent.*`, `turn.*`, pauses, messages and workflow journal progress) are
persisted before publication in managed sessions. High-frequency deltas and progress are
live-only: a client that joins midway reconstructs the committed structural state from
`list()` and continues transient rendering from `stream()`.

`SessionProjection` remains the standard reducer from `AgentEvent` to state-shaped UI data.
It is not exposed as a separate managed snapshot endpoint: fold the stream into a projection.

The stream replays the session's durable history first and then follows live, so one
subscription is the whole story. It carries a durable cursor — the SSE `id:` is stamped only
on events the log can find again, never on a token delta — and the client reconnects on a
dropped connection by itself, resuming after the last durable event it delivered and filtering
the overlap by `eventId`. Pass `after` to start from a cursor you kept, or `reconnect: false`
to see drops yourself.

```ts
const stream = await client.sessions.events.stream(session.id);
const projection = new SessionProjection(session.id);

for await (const event of stream) {
  projection.apply(event);
  render(projection.snapshot());
}
// stream.lastEventId is the cursor to continue from elsewhere.
```

`run()` sends one input and resolves when the turn that took **that** delivery ends — not the
first `turn.ended` in the replay, which on a session with history belongs to an older turn.

The server accepts an `authorize(request, { action, sessionId })` hook. Configure it for any
networked deployment; it can verify credentials and enforce per-session ownership. The
bundled in-memory idempotency store is atomic within one process and bounded by TTL/capacity;
distributed deployments should provide a database-backed `ManagedDeliveryIdempotencyStore`.

The service and the workers share one **work table** (`SessionWork`): one row per session that
has been appended to or is being run. `work.append` writes an input to the session's log and
wakes its row as one step — in Postgres, one transaction — and a worker's claim loop
(`worker.start()`) takes woken rows, one indexed statement per ask (`FOR UPDATE SKIP LOCKED`).
Taking the row *is* the lease: one runtime owner per session, with a fencing token, and no
dispatcher anywhere. Workers only make outbound calls; nothing needs to know which node holds
a session.

Cancel and resume are journaled commands written the same way. The holder learns of them from
its heartbeat — every lease renew reports whether anything was appended since the last one —
so a command accepted on any node reaches the turn running on any other within one renew
interval (2s by default). With no holder, the next claim reads them first.

An input is processed once it is in the conversation: the worker's cursor advances when the
session's record holds the message, not when the turn that took it finishes. A turn that fails
or dies halfway leaves the history intact up to where it stopped, and the next message
continues from there; nothing is re-run and nothing runs twice. A worker that dies leaves its
row held past the TTL; the claim loop takes such a row like any other, closes the turn it left
open (`turn.ended`, reason `failed`) and broadcasts the close, so a client waiting on it learns
within a TTL rather than whenever the next message happens to arrive.

In one process, `MemorySessionWork` — the service and the worker must share the instance.
Across nodes, `PgSessionWork` over the same Postgres the log lives in (run
`sessionWorkTableDDL()` once); no queue, no broker, no other component. An accepted input is
durable and woken before its 202; the in-process nudge after it is latency, not correctness.

Pass an idempotency key when an HTTP retry must not inject the same user message twice:

```ts
await client.sessions.messages.create(
  session.id,
  { input: "continue" },
  { idempotencyKey: requestId },
);
```
