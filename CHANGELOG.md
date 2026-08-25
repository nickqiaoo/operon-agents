# Changelog

All six publishable packages (`operon-agents`, `operon-agents-core`, `operon-agents-peers`,
`operon-managed-agents`, `operon-sandbox`, `operon-os-sandbox`) share one version and are
released together, so this file covers all of them.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
