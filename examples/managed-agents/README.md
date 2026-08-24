# Managed Agents server + SDK example

This example is now a thin composition root for the `operon-managed-agents` package.
The package supplies the HTTP API, independent session event stream, lazy Session recovery
and typed TypeScript client; the example supplies one Agent configuration, a durable session
repository and one named execution environment.

## Run

```bash
pnpm install && pnpm build

# terminal 1
cd examples/managed-agents
ANTHROPIC_API_KEY=sk-ant-... pnpm start

# terminal 2
pnpm client "inspect the workspace and create a short report"
```

Set `MANAGED_API_KEY` in both terminals when binding the server beyond localhost. The example
server enables bearer authentication whenever that variable is present.

The client performs three independent operations:

1. `sessions.create()` creates a durable managed Session.
2. `sessions.events.stream()` opens the long-lived Session SSE connection.
3. `sessions.messages.create()` submits work and immediately returns a delivery receipt.

Because observation is no longer tied to the prompt request, the same stream also receives
background task completion, workflow/subagent activity, injected steer messages and idle wakes.

## Raw HTTP

```bash
SESSION=$(curl -s localhost:8088/v1/sessions \
  -H "authorization: Bearer $MANAGED_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"agent":"default","environment":"workspace"}' \
  | node -e 'process.stdin.on("data",b=>console.log(JSON.parse(b).id))')

curl -N "localhost:8088/v1/sessions/$SESSION/events/stream" \
  -H "authorization: Bearer $MANAGED_API_KEY"

curl -s "localhost:8088/v1/sessions/$SESSION/messages" \
  -H "authorization: Bearer $MANAGED_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"input":"inspect the workspace"}'
```

`GET /events/stream` carries `AgentEvent` objects directly, while `GET /events` is opaque-cursor
persisted history. Durable events keep one `eventId` across both APIs, so reconnecting clients
can start consuming the stream, page history, and deduplicate the overlap. For a state-shaped
view, fold those `AgentEvent`s through `SessionProjection`; managed HTTP intentionally has no
separate snapshot endpoint.
