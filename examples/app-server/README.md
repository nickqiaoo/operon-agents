# App-server (spawn + drive over stdio)

Drive the harness from **another process** over the app-server protocol: NDJSON
JSON-RPC 2.0 on stdio. A host `spawn`s the server binary and talks to it — the shape
several agent CLIs expose for editor integration, generalized here so a non-JS host
(Python, Rust, Go…) can drive the agent without embedding it.

This example writes **both ends** so you can see the whole loop:

- **`server.ts`** — a custom app-server entry. Wraps a `Harness` onto this process's
  stdio and runs the protocol. This is essentially the built-in `operon-app-server`
  binary, shown as user code so you can build (and customize) your own.
- **`client.ts`** — spawns `server.ts` as a child and drives it with the reference
  `AppServerClient`: handshake, open a session, stream events, answer approvals, prompt.

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm start
ANTHROPIC_API_KEY=sk-ant-... pnpm start "count the lines in package.json with bash"
```

`pnpm start` runs the client, which spawns the server for you. To run the server
standalone (it then waits for JSON-RPC on stdin), use `pnpm server`.

## What it shows

- **The seam** — the client talks to the agent only through the wire protocol, never
  by importing it. Swap the child for the installed binary and nothing else changes:
  `AppServerClient.spawn({ command: "operon-app-server", args: ["--workdir", ".", "--model", MODEL] })`.
- **`AppServerClient`** — a `Harness`-shaped wrapper over the spawned process:
  `initialize()` → `newSession()` → `prompt()`, plus `steer` / `cancel` / `resumeSession`.
- **Symmetric RPC** — the server calls the client *back*. `setApprovalHandler` answers
  tool-approval reverse-requests (here: approve file tools, reject `bash`); `onEvent`
  receives every `AgentEvent` verbatim as a notification.
- **stdout is the wire** — the server redirects `console.*` to stderr so a stray log can
  never corrupt the protocol stream. Human logs go to stderr; the client inherits it.

## The protocol is the contract

`server.ts` and `client.ts` share nothing but the wire. `operon-agents/app-server`'s
`./protocol` module (wire types + method constants) is the single source of truth a
client in any language mirrors — this TypeScript client is just the reference impl.
For in-process wiring (tests), `pairedTransports` connects an `AppServer` and an
`AppServerClient` with no child process at all.

## Next

- The in-process HTTP control plane instead of stdio → [`../managed-agents`](../managed-agents)
- Swap the machine for an E2B sandbox → [`../managed-agents`](../managed-agents)
