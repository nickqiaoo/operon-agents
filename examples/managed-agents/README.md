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

The client performs three independent operations, as with Claude Managed Agents:

1. `sessions.create()` creates a managed Session. Nothing runs yet.
2. `sessions.events.stream()` opens the live Session SSE connection — before sending, since the
   stream carries only what is emitted after it opens.
3. `sessions.events.send()` sends a `user.message`; the worker pulls it and the agent runs.

## Raw HTTP

```bash
SESSION=$(curl -s localhost:8088/v1/sessions \
  -H "authorization: Bearer $MANAGED_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"agent":"default","environment_id":"workspace"}' \
  | node -e 'process.stdin.on("data",b=>console.log(JSON.parse(b).id))')

curl -N "localhost:8088/v1/sessions/$SESSION/events/stream" \
  -H "authorization: Bearer $MANAGED_API_KEY"

curl -s "localhost:8088/v1/sessions/$SESSION/events" \
  -H "authorization: Bearer $MANAGED_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"inspect the workspace"}]}]}'
```

`GET /events/stream` carries managed session events (`agent.message`, `agent.tool_use`,
`session.status_idle`, …) live, while `GET /events` pages the persisted history under the same
ids, sent events included.
