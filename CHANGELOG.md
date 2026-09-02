# Changelog

All six publishable packages (`operon-agents`, `operon-agents-core`, `operon-agents-peers`,
`operon-managed-agents`, `operon-sandbox`, `operon-os-sandbox`) share one version and are
released together, so this file covers all of them.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Peers: teammate names are unique per team, not per roster** (`operon-agents-peers`). A
  teammate's roster id is now `<team label>/<name>` (`AgentRef.name` / `PeerCard.name` carry
  the short name), so two teams can each spawn a `dba`. `Hub send` and `Team send` resolve the
  short name (`Team send` takes `team` to disambiguate; a new `ambiguous` receipt reason refuses
  to guess), a member addresses its creator as `lead` (reserved as a teammate name) and is shown
  it under that name, and `PeerNetwork.disbandTeam(label)` takes a team off the roster.
  `buildMemberTool` takes the roster id plus the short name. Existing card stores keep working:
  members carded under a bare name resolve by exact id.
- **MCP: a host can list a server's tools** (`operon-agents-core`, `operon-agents`).
  `Session.listMcpTools(name)` (and `McpServersHandle.listTools`) returns what a connected
  server offers, so a host can SHOW its tools rather than only hand them to the model.
  Distinct from `toolProvider().listTools`, which namespaces names and substitutes an auth
  tool mid-OAuth; this returns the server's own list and degrades to empty for an unknown
  or disconnected server, the way `listMcpServers` does.
- **Extensions: `create` sees `host.services`** (`operon-agents`). The process half receives
  the handles of its `uses` services, the way `setup` does — a file-loaded bundle can take its
  configuration from a host-registered service instead of baking it in.
- **Managed API: a delivery is the caller's own words unless it says otherwise**
  (`operon-managed-agents`, `operon-agents`, `operon-agents-core`). `messages.create` journaled
  every input as an `external` origin, so the model saw even a chat window's messages inside an
  `<external-message>` envelope stamped "NOT a message from the user" — while the same caller
  held `sessions.resume`, the real approval channel. The party holding a session's credential is
  its user, the way app-server's stdio is; the default is now `origin: "user"`, rendered bare.
  Relayed words (a peer, a webhook) declare `origin: "external"`, which `source`, `actor` and
  `metadata` now require. The `authorize` hook receives `origin` on `messages.create`, so a
  credential that only relays can be held to it. Existing callers change behaviour: their inputs
  lose the envelope. Types: `UserPromptOrigin.deliveryId`, `InboxOrigin`, `AcceptedOrigin` added;
  `delivery.accepted.source` is now optional (absent for a user delivery).

## [0.1.0-alpha.2] — 2026-08-25

### Fixed

- **MCP: `tools/call` no longer fails JSON-RPC validation on a real server**
  (`operon-agents-core`). The SDK transport sent `arguments: null` and `_meta: null`, but both
  fields are `.optional()` — not nullable — in the MCP schemas, so a server that actually parses
  the wire message rejected every tool call with `-32700 Parse error: Invalid JSON-RPC message`
  before the tool ran. Both keys are now omitted when there is nothing to send. A mock transport
  cannot catch this, so the regression test (`e2e-mcp-http-calltool`) runs against a real
  streamable-HTTP MCP server.

- **Auto-approval: a tripped circuit breaker recovers on its own**
  (`operon-agents-core`). Once the judge model had failed `maxConsecutiveErrors` times running,
  the breaker stayed open forever: the only line that cleared it lived past the short-circuit it
  had installed. A transient provider outage therefore demoted `auto` to `manual` for the rest of
  the process, with a restart the only way out. The breaker now half-opens — after a backoff, one
  probe call is let through; a success clears it, a failure re-trips it with twice the delay, up
  to a cap — so an outage costs one call per backoff window instead of one per tool call. Tunable
  via the new `breakerProbeDelayMs` (default 30s) and `breakerMaxProbeDelayMs` (default 5min)
  options on `LlmAutoApprover`.

## 0.1.0-alpha.1 — 2026-08-24

First public release from the open-source repository, with the CI and publish workflows
(trusted publishing via OIDC, release tagging) in place.

## 0.1.0-alpha.0 — 2026-08-24

Initial npm placeholder release.

[0.1.0-alpha.2]: https://github.com/nickqiaoo/operon-agents/releases/tag/v0.1.0-alpha.2
