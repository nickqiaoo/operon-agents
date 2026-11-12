# operon-managed-agents

Managed HTTP/SSE server and TypeScript client for `operon-agents`, with an API shaped after
Claude Managed Agents. One package contains three public surfaces:

- `operon-managed-agents/protocol` — wire/resource types and SSE codec
- `operon-managed-agents/server` — session service, worker, work table and HTTP server
- `operon-managed-agents/client` — typed client SDK

## The API

| Route | Client |
| --- | --- |
| `POST /v1/sessions` | `sessions.create({ agent, environment_id, title?, metadata?, initial_events? })` |
| `GET /v1/sessions` | `sessions.list({ limit?, page?, order? })` |
| `GET /v1/sessions/{id}` | `sessions.retrieve(id)` |
| `POST /v1/sessions/{id}` | `sessions.update(id, { title?, metadata? })` |
| `POST /v1/sessions/{id}/archive` | `sessions.archive(id)` |
| `DELETE /v1/sessions/{id}` | `sessions.delete(id)` |
| `POST /v1/sessions/{id}/events` | `sessions.events.send(id, { events })` |
| `GET /v1/sessions/{id}/events` | `sessions.events.list(id, { limit?, page?, order? })` |
| `GET /v1/sessions/{id}/events/stream` | `sessions.events.stream(id, { event_deltas? })` |

Work enters a session as **user events** — `user.message`, `user.interrupt`,
`user.tool_confirmation`, `user.custom_tool_result` — and everything the agent does comes back
as **session events**: `agent.message`, `agent.tool_use`, `agent.custom_tool_use`,
`agent.tool_result`, `span.model_request_start` / `span.model_request_end` (one pair per model
request, the end carrying `model_usage` and `is_error`), `session.status_running`,
`session.status_idle` (with a `stop_reason` of
`end_turn` or `requires_action`), `session.status_rescheduled` and `session.error`. Every
event has an `id` and a `processed_at`: a sent event comes back with `processed_at: null` and
shows a timestamp once a worker has dealt with it. Errors are Anthropic-shaped:
`{ type: "error", error: { type, message } }`.

```ts
const session = await client.sessions.create({ agent: "default", environment_id: "workspace" });

// Live-only: open the stream before sending, or what happens in between is missed.
const stream = await client.sessions.events.stream(session.id);
await client.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: "inspect this repository" }] }],
});

for await (const event of stream) console.log(event.type);
```

Creating a session without `initial_events` starts nothing and provisions nothing. A
`user.message` sent while the agent runs is taken at its next step boundary; one sent while
the session waits on a confirmation is held until the confirmation is answered. A
`requires_action` idle names the blocking `agent.tool_use` events in `stop_reason.event_ids`;
answer each with `{ type: "user.tool_confirmation", tool_use_id, result: "allow" | "deny" }`,
or an `agent.custom_tool_use` with `{ type: "user.custom_tool_result", custom_tool_use_id,
content }`; when the paused call asked questions (`AskUserQuestion`), the text answers each of
them as a freeform answer.
`user.interrupt` stops the run, and what was sent before it but not yet taken is dropped.

`sessions.events.stream()` carries only what is emitted after it opens. On a dropped connection
the client reconnects by itself, fills the gap from `sessions.events.list()` and skips what it
already delivered; pass `reconnect: false` to see drops yourself.

### Live previews

By default `agent.message` arrives whole, once the model has finished it. To render text as it is
generated, opt in per connection with `event_deltas` (on the wire, `event_deltas[]=agent.message`,
repeated per type), as in Claude Managed Agents:

```ts
const stream = await client.sessions.events.stream(session.id, { event_deltas: ["agent.message"] });
const previews = new Map<string, string[]>();
for await (const event of stream) {
  if (event.type === "event_start") previews.set(event.event.id, []);
  else if (event.type === "event_delta") {
    const blocks = previews.get(event.event_id);
    if (blocks) blocks[event.delta.index] = (blocks[event.delta.index] ?? "") + event.delta.content.text;
  } else if (event.type === "agent.message") previews.delete(event.id); // authoritative; render this
  else if (event.type === "span.model_request_end" || event.type === "session.status_rescheduled") {
    previews.clear(); // still open = never delivered: drop or mark it
  }
}
```

`event_start` names the id the buffered `agent.message` will have, and every `event_delta`
carries it; concatenated per `delta.index`, the deltas are a prefix of that block's text. Order
on one connection is `session.status_running` → `span.model_request_start` → `event_start` →
`event_delta`* → `agent.message` → `span.model_request_end`. Previews are best effort and live only: never in `events.list()`, never
replayed on reconnect, not delivered for a message already in progress when the connection
opened, and shed (the rest of that message's deltas) when a connection falls too far behind.
A preview can outlive its message: the message is persisted only once the model has finished
it, so a request that fails, is retried or is cut short after streaming leaves a preview that is
never reconciled. Its `span.model_request_end` still arrives, with `is_error: true`, after any
message the request did produce — so a preview still open at the end of its request is over.
If the worker itself goes away mid-request, no end comes; `session.status_rescheduled` says the
next worker starts the request over. Only `agent.message` and `agent.thinking` are accepted,
at most 100 values, otherwise the stream answers 400; `agent.thinking` yields nothing, since
sessions do not emit it. Previews reach other processes only through a cross-process
broadcaster (`RedisEventBroadcaster`).

`run(client, sessionId, text)` sends one message and resolves when the agent is done with
**that** message — not at the idle of a turn that was already running when it was sent — and
answers `requires_action` through `onInterrupt`, or rejects at once without one.

Pass an idempotency key when an HTTP retry must not send the same events twice:

```ts
await client.sessions.events.send(session.id, { events }, { idempotencyKey: requestId });
```

The server requires an `authorize(request, { action, sessionId })` hook. Configure it for any
networked deployment; it can verify credentials and enforce per-session ownership.
`SessionService({ validateCreate })` refuses an unknown agent or environment id before a
session is recorded. The bundled in-memory idempotency store is atomic within one process;
distributed deployments should provide a shared `ManagedDeliveryIdempotencyStore`.

## How work reaches a worker

The API and the workers share exactly one thing: the **work table** (`SessionWork`). It holds
each session's managed event log — what was sent and what the session emitted, in the managed
vocabulary — and its lease. The API never writes into the framework's journal and never holds a
reference to a worker, not even in one process.

- **Accepting** an event persists it and wakes its session in one commit, before the response.
- **Idle workers claim.** `worker.start()` runs a claim loop that takes woken sessions, one
  indexed statement per ask (`FOR UPDATE SKIP LOCKED` in Postgres). Taking the row *is* the
  lease: one runtime owner per session, with a fencing token, and no dispatcher.
- **Holders pull.** A worker holding a session polls its pending events every
  `inputPollIntervalMs` (500ms by default) while the agent runs, and hands them to the Harness
  through its public interface: `steerTo` for a message, `cancel` for an interrupt, `respond`
  for an answer. The first claim creates the runtime session; later ones reopen it.
- **Output** is translated to managed events on the worker, recorded in the history under the
  lease, and broadcast (`MemoryEventBroadcaster` in one process, `RedisEventBroadcaster` across
  nodes) for the SSE endpoint to forward.

A message is **processed** once it is in the conversation, not when it was pulled: a worker that
dies holding it leaves it pending, and the next holder delivers it. One that dies after the
conversation took it is recognised by the next holder in the transcript, marked, and not
delivered twice; if the turn it started never finished, the next holder continues it
(`session.status_rescheduled`). A worker that dies leaves its lease to lapse; the session reads
`rescheduling` meanwhile, and the next claim tells watchers the turn stopped.

In one process, `MemorySessionWork`. Across nodes, `PgSessionWork` (run `sessionWorkTableDDL()`
once); no queue, no broker, no other component. `test/e2e-pg-real.ts` runs its statements
against a real Postgres when `MANAGED_PG_URL` is set.

A worker serves many tenants by default, and refuses what would leak between them or run outside
the sandbox: a session whose environment does not come from the environment registry, a harness
holding process-wide MCP connections or an OAuth service, MCP over stdio, and a token read from
the process environment. Isolation is stated once, on the harness, not on each open: a
multi-tenant worker requires `config.policy.strictIsolation: true` and
`config.eventPublication: "committed"` and refuses to construct on a harness without them. It also
refuses any session on that harness it did not open itself under a lease, so an extension cannot
create or wake one behind its back. A self-hosted, one-owner deployment says so —
`new SessionWorker({ profile: "single-tenant", … })` — and the worker logs that it did.

```ts
const harness = createHarness({
  config: {
    defaults: { model: "anthropic/claude-opus-4-8" },
    policy: { strictIsolation: true },   // every session on its own environment, http-only MCP
    eventPublication: "committed",       // an event is durable before anyone sees it
  },
  infrastructure: () => ({ sessionRepository }),
});
```

What a host decides per tenant goes through the registries, which the worker asks on every open
and which are told whose session they resolve for: `resolve(ref, { sessionId, ownerKey, metadata })`.
The agent registry returns `{ config, bindings }` — the session's configuration as data, and the
live objects it runs on — and the worker passes both on every open, the first included, so the
configuration is the host's to keep: change what the registry returns and the next open runs on it.
`ownerKey` is stamped by the service and trustworthy; `metadata` came from the client. Per-user MCP credentials — a vault —
are a provider the agent registry hands out, asked on every connect:

```ts
const agents: ManagedAgentRegistry = {
  resolve: (_ref, { ownerKey }) => ({
    // The complete set of MCP servers this session sees.
    config: { mcp: { servers: { linear: { transport: "http", url: "https://mcp.linear.app/mcp" } } } },
    bindings: {
      mcpCredentials: {
        credentialsFor: async ({ url }) => {
          const token = await vault.tokenFor(ownerKey!, url); // the host's store, refresh, lock
          return token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } };
        },
        invalidate: ({ url }) => vault.refresh(ownerKey!, url), // on a 401; the connect retries once
      },
    },
  }),
};
```

The engine never stores, refreshes or logs a credential, and since the MCP client runs in the
worker, a credential never enters the sandbox. The rules and their reasons are in
`docs/server-profile.md`.
