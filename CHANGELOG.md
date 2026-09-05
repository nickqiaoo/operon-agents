# Changelog

All six publishable packages (`operon-agents`, `operon-agents-core`, `operon-agents-peers`,
`operon-managed-agents`, `operon-sandbox`, `operon-os-sandbox`) share one version and are
released together, so this file covers all of them.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Closing a session now waits for its runs to wind down** (`operon-agents`, `operon-agents-core`).
  `HarnessSession.close()` is a state machine (open → closing → closed): it stops accepting runs,
  aborts every accepted run — the one in flight *and* any queued behind the run lock — and waits
  for them to settle, up to 5 seconds, before detaching the projection and closing the core.
  The deadline bounds the wait for runs only; the flushes and disposes that follow keep their own
  deadlines, and a run that ignores its abort is logged and left behind, not stopped. A tool's
  `finally` or a run's last journal write no longer races the capability disposers. Every
  `close()` call — `HarnessSession`, core `Session` and `Scope` alike — returns the same promise,
  so a second caller waits for the teardown instead of returning while it is still running.
- `Scope.close()` no longer lets a parent skip a child whose close is still in flight (which
  disposed the parent's entries under the child's disposers), and once closing it stops
  materializing lazy defaults: a disposer touching a never-instantiated service gets "missing"
  instead of creating an orphan the teardown never disposes. New `scope.state`.
- `cancel()` aborted only the last-begun run: with a second `prompt()` queued behind the run lock
  that was the queued one, and the running one carried on. It now aborts all of them, and a run
  cancelled while queued bails on acquiring the lock — before reconcile, context replay or
  `agent.started`. `resume()` and `promptStream()` gained the closed check `prompt()` had; a
  caller parked at the reshape barrier's gate fails with the closed error when the session
  closes instead of hanging on a gate nobody will release.
- **Opening a session is a transaction** (`operon-agents`). A failure anywhere after the workspace
  is acquired — log read, `session` hook, `Session.open`, agent build — tears down what was built
  (projection, session scope, workspace hold; every step attempted, cleanup failures logged, the
  original error rethrown). A half-open leftover used to keep a workspace alive after its last real
  session closed. `resumeSession` for one id now shares a single in-flight open (reconcile and
  failure cleanup included) instead of building two instances of which only one was registered,
  waits for a closing instance rather than opening a twin beside it, and a close unregisters only
  its own instance. `closeSession` / `harness.close()` wait for in-flight opens first.
- The workspace skill scan follows the harness default machine (`T.MachineFactory`) with the same
  precedence `Session.open` resolves; it used to fall back to the host's disk, so a harness whose
  sessions execute remotely handed the model the local catalog.

## [0.1.0-alpha.5] — 2026-09-05

### Added

- **Tracing carries the conversation, not just its shape** (`operon-agents-core`). A processor
  (or the bridge) can opt into a content mode — `"delta"` or `"full"` — and every span then holds
  what a debugger needs to replay a run: the system prompt, tool list and model params as the
  model received them (new live-only `model.request` event, emitted after every hook), the
  request messages (`delta` = what the model had not yet answered, `full` = the whole context),
  the model's output parts, tool call arguments and results, user prompts as instant `message`
  spans, and retries / resets as span events. Turn spans record how they ended, tool spans carry
  the tool's own error text, generation usage now includes cache and cost. The root span of a run
  is named after its first user prompt. `OTelTracingProcessor` maps content to the GenAI semantic
  conventions (`gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.tool.call.arguments` / `.result`) as JSON, capped by `contentMaxChars` (32 000), images
  reduced to their size, with opt-in `redact`. Default stays `"none"`: existing processors see the
  same metadata-only spans as before.
- A trace now waits for a background sub-agent that outlives its run (`agent.ended` of the root
  while a nested agent is still running) instead of dropping the agent's later spans.
- **Product telemetry as an opt-in capability** (`operon-agents-core`, `operon-agents`). A typed
  event registry (`FRAMEWORK_TELEMETRY_EVENTS`: session / turn / tool / sub-agent / compaction /
  guardrail / skill / steer / error counts) where every property carries a description and an
  extra or missing property at a `track()` call site is a compile error; a `TelemetryService`
  with environmental context (`withContext`) and product registries (`withRegistry`); a built-in
  projection from the session's `AgentEvent` stream, subscribed by the core `Session` when
  `HarnessOptions.telemetry` (or `T.Telemetry`) is set; outbound redaction (secrets, emails, URLs,
  absolute paths); and `PostHogAppender`, which either owns a `posthog-node` client
  (`{ apiKey, host, getDistinctId }`) or wraps a product's own sink (`{ client }`). Without an
  appender nothing is sent; the framework never mints an identity and never picks an endpoint.
  New subpath `operon-agents/telemetry`.

### Changed

- `BackgroundOutput` with `block=true` now returns as soon as the turn is cancelled instead of
  holding a waiter past it, and refuses to block on a task that is waiting for the user (a pending
  question) — the tool text tells the model to end the turn and rely on the completion notice.

## [0.1.0-alpha.4] — 2026-09-04

The composition story finished: everything with a lifetime now lives in a scope, and there are
three of them — harness, workspace, session. Extensions get the same three tiers, which is what
lets a per-workspace extension (peers) exist at all. Breaking for hosts that compose a harness
by hand and for extension authors.

### Changed

- **BREAKING — one `Scope` tree replaces hand-wired assembly** (`operon-agents-core`,
  `operon-agents`). Every object with a lifetime is registered in a `Scope` under a typed,
  tier-declaring token (`T.Machine`, `T.Goal`, `T.McpServers`, …). Lookups walk up the chain, a
  child registration overrides its parent's, `provide` is a default a prior `register` beats, and
  `close()` tears children down first and entries in reverse — one teardown path for capabilities,
  session infrastructure, workspace resources and extension services. `createHarness` takes three
  composition hooks — `harness` / `workspace` / `session` — in place of `machine`, `repository`,
  `logger`, `modelRuntime`, `capabilities` and `maxContextTokens`; `harness.scope` is public. A
  capability declares `provides: Provision[]` (`{ token, create(ctx), dispose }`) instead of
  `service` + `openSession` / `closeSession`, and `Session.open(scope, …)` replaces the
  string-keyed service map, its eleven getters and `CapabilityMissingError` with
  `session.get(T.X)` / `require(T.X)`. Hosts that passed `capabilities` move to `session`, which
  is handed the session's scope and returns the same capability list.
- **BREAKING — the workspace tier: one scope per working directory** (`operon-agents`). Sessions
  sharing a key (`dir::<workDir>` by default, `private::<id>` for an isolated one, or an explicit
  `createSession({ workspaceKey })`) share a scope that is ref-counted and closed with its last
  session. The local preset puts the things that were per-session and shouldn't be there: MCP
  connections, the skill scan, and the MCP OAuth credential store — one set per directory instead
  of one per conversation. An explicit `workspaceKey` is persisted with the session, so resume and
  fork land back in the same workspace (resuming with a NEW key is a generation change, never an
  in-place replace); derived keys are not persisted.
- **BREAKING — scope tiers are a compile error, not just a runtime one** (`operon-agents-core`).
  `Token<T, K>` carries its tier as a literal type and `Scope<K>` its own, so `register` /
  `provide` / `replace` / `unregister` only accept a token declared for that tier, and
  `child<C extends Below<K>>` narrows (harness → workspace | session, workspace → session).
  `ProvisionContext` / `RunContext` carry `Scope<"session">`; `McpServersHandle.connect` takes an
  `McpConnectContext` (`{ scope, sessionId }`) rather than a `ProvisionContext`, because a
  workspace connects its servers before any session exists.
- **BREAKING — an extension's halves are named for the tier they run at, and there is a new
  `workspace` half** (`operon-agents`). `create` → `harness`, `setup` → `session`, and
  `ExtensionSetupContext` → `ExtensionSessionContext` (the session-tier EVENT context that used
  to hold that name is now `ExtensionSessionEventContext`). The new `workspace(host)` half runs
  once per workspace key — when the first session opens under it, or immediately in every open
  workspace when the definition is loaded — and its result is registered under the extension's
  `id` in THAT workspace's scope, so each working directory gets its own instance, disposed with
  the last session under it. A definition carries at most one shared half, `harness` or
  `workspace` (there is no `tier` option — the tier is the name of the half), so `ctx.shared` and
  the extension's service live at exactly one tier and the session half need not know which.
  `ExtensionWorkspaceContext` gives the half the workspace's `key` / `workDir`, a `createSession`
  that defaults INTO this workspace, its `uses` handles resolved from it, and a per-workspace
  `dataDir` (`<extension data>/workspaces/<key>`). A reload re-runs the half in every open
  workspace.
- **BREAKING — `harness.services.handle` refuses a workspace-tier name** (`operon-agents`). The
  by-name registry now tracks which names a `workspace` half publishes (`declareWorkspace`), and
  those are reached with `harness.workspaceService<T>(name, { workDir } | { workspaceKey })` — a
  lazy handle that resolves on call and reports `missing` for a workspace that is not open —
  plus `harness.openWorkspaces()` to enumerate them. `has(name)` still answers for both tiers;
  `handle(name)` throws for a workspace-tier name instead of silently resolving nothing. A
  session's `uses` / `ctx.services` handles resolve from the session scope upward, so a consumer
  reaches either tier unchanged.
- **BREAKING — peers is a per-workspace network** (`operon-agents-peers`). `peers()` is now a
  `workspace` half: every working directory gets its own roster, mailbox and budget, and a
  teammate spawned by a lead is born in the lead's workspace. The budget therefore counts per
  workspace, not per process. `PeerOptions.repo` takes a factory given each workspace's host
  (the file form builds its repo in that workspace's `dataDir`); passing a repo INSTANCE still
  works and makes every workspace share one roster, which is now a deliberate choice rather than
  the only shape. Hosts reach a network with `harness.workspaceService(PEERS_SERVICE, { workDir })`.
- **Skills follow the workspace's execution machine, not the host's disk** (`operon-agents`).
  The `workspace` hook runs BEFORE the skill scan, so a host can register `T.WorkspaceMachineFactory`
  (or its own `T.SkillRegistry`) and have the catalog scanned through the machine whose Bash the
  model will actually use. A machine FACTORY (one machine per session) publishes no shared
  registry — each session scans through its own `T.Machine` — and a session opened with
  `createSession({ machine })` ignores the workspace's registry for the same reason.
- **MCP: `createSession({ mcpServers })` is honoured, layered over the workspace's**
  (`operon-agents-core`, `operon-agents`). The option was carried to the capability factory and
  then dropped: the default factory viewed the workspace's shared connections and ignored the
  session's own configs, so a host that gives each conversation its own server (a REPL kernel
  keyed by conversation id) silently got nothing. `mcpSessionCapability(configs?, options?)` now
  takes that overlay — its servers are built, connected and shut down with the session, while the
  workspace half is still only viewed — and `defaultCapabilities` takes `sessionMcpServers`, which
  the local preset fills from `SessionCapabilityContext.mcpServers`. A name the session reuses
  SHADOWS the workspace server of that name for this session (`list`, `listTools`, `reconnect` and
  the model's `mcp__<name>__<tool>` tools all resolve to the session's); the workspace connection
  underneath keeps running for every other session.
- **`SessionPort` hands out workflow journals, not the `WorkflowManager`**
  (`operon-agents-core`). The kernel's Workflow tool only ever called `newJournal`; the port now
  exposes `newWorkflowJournal(runId, parentToolCallId)` and the manager class stays behind
  `session.workflow`, off the kernel's interface.

## [0.1.0-alpha.3] — 2026-09-02

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

[0.1.0-alpha.5]: https://github.com/nickqiaoo/operon-agents/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/nickqiaoo/operon-agents/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/nickqiaoo/operon-agents/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/nickqiaoo/operon-agents/releases/tag/v0.1.0-alpha.2
