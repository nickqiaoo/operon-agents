# Changelog

All seven publishable packages (`operon-agents`, `operon-agents-core`, `operon-agents-peers`,
`operon-managed-agents`, `operon-sandbox`, `operon-os-sandbox`, `operon-code-mode`) share one
version and are released together, so this file covers all of them.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha.10] — 2026-09-29

### Fixed

- A local-harness session created with its own `workDir` and no `environment` now runs in that
  directory and scans skills there, instead of running at the harness's default `workDir`
  (`operon-agents`).

## [0.1.0-alpha.9] — 2026-09-29

### Added

- **A compaction request belongs to the frame that asked for it** (`operon-agents-core`).
  `beforeStep` runs for every agent in a session, so the single pending slot on
  `CompactionService` was consumed by whichever frame stepped next: a subagent would compact ITS
  context because the main agent asked, and the main agent's context stayed as it was with the
  request gone. `request`/`pending`/`cancel`/`consume` now take an address (defaulting to the
  root agent, which is what `session.controls().compact()` and `/compact` mean).
  `completedRevision` stays session-wide deliberately — it only invalidates a prompt-context
  cache, where being coarse costs one recomputation rather than a wrong answer.

- **Plan and goal tools are the root agent's** (`operon-agents-core`). A subagent could call
  `ExitPlanMode` — putting a plan up for approval to a human it is not talking to, and switching
  the whole session's mode, its parent's included — or rewrite the conversation's goal. `plan`
  now drops both of its tools for a non-root frame, and `goal` drops `UpdateGoal` /
  `SetGoalBudget` while keeping `GetGoal`, since knowing what the session is for helps a
  subagent do its part. Neither store was keyed: that state really is the session's, and this is
  a visibility question rather than an ownership one.

  **Breaking (types only)**: `ToolFilter` now receives a second argument,
  `ToolFilterContext { address, isRootAgent }` — it narrows the toolset for a turn and could not
  previously see whose turn it was. Existing one-argument filters keep compiling.

- **A todo list belongs to the agent writing it** (`operon-agents-core`). `TodoStore` is keyed by
  journal address instead of holding one list, so a subagent planning its own work no longer
  replaces the main agent's list — measured before the fix: the parent wrote two items, spawned a
  subagent, and the session's list became the subagent's one item, silently (the parent's own
  transcript still carried its last result, so nothing looked wrong until its next read, and the
  sparse `TodoListInjector` reminder would read another agent's list back to it).

  The store is still a single session-lived object: it owns nothing that needs closing, so it was
  never a resource. What is per-frame is the DATA, indexed by `ctx.address` — which every tool
  context already carries, and which the journal is already sharded by, so `reconstruct` folds
  each shard back into its own frame and resume restores both. New:
  `latestToolDetailsByAddress`. The rule this is the first application of — resources go in a
  scope, state gets a key — is written down in
  [docs/state-and-lifetime.md](./docs/state-and-lifetime.md).

- **A detachable capability's hooks can fail without failing the run** (`operon-agents-core`).
  `CapabilityContract` promised that a `detachable` capability's hooks are timed and isolated,
  but only extensions got that — through their own runtime. The assembler now wraps every hook
  of a `detachable` capability: each call has a budget (`Capability.hookTimeoutMs`, default 30s),
  and a throw or an overrun is announced as a `warning` event when it happens and read as "no
  opinion" (`undefined`), which every hook slot already treats as "carry on unchanged". An
  `invariant` capability's hooks are used as written. `CapabilityDiagnostic.phase` gains `"hook"`,
  and `assembleCapabilities` takes a `report` callback for mid-run diagnostics.

  The Runner no longer swallows a `beforeRun` hook's throw on top of that. It used to skip any
  failing input hook with a warning — an invariant one included, which its contract forbids. A
  detachable hook is isolated by the assembler anyway; an invariant one's throw now fails the run,
  with the run's capabilities stopped as for any other failure.

- **A capability reaches what only extensions could** (`operon-agents-core`). Four things an
  extension got from its own runtime are now plain parts of a capability, so a behaviour no
  longer has to be written as an extension to use them:
  - `SessionContext.state` — durable key/value state, partitioned by capability name. It lives
    under the `extension:<name>:` prefix extensions already used, so their state reads back.
  - `SessionContext.records()` / `record(name, data?)` — named records in the main
    conversation: earlier processes first, then this session's, never counted twice. `record`
    works at any point in the session, not only during a run.
  - `Capability.commands` — slash commands the capability adds to the session's command set.
  - `Capability.provider` — `headers` / `payload` / `response` hooks on the HTTP request. They
    compose across capabilities (and after any callback already in `providerOptions`) instead of
    the last writer silently replacing the rest, and a detachable capability's are isolated like
    its loop hooks, with `response` capped at 1s since it runs before the body streams.

  `SessionContext` is now built per capability — the three data members are its own view — so a
  hand-built context (tests) must supply them; `testSessionContext` does.

- **A capability can join or leave a session that is already open** (`operon-agents-core`).
  `Session.attachCapability(capability)` opens a `detachable` capability in a live session and
  `detachCapability(name)` closes and removes one. With no run in flight the change is immediate;
  otherwise it waits until the last run has stopped its capabilities, so a run never sees its set
  change under it and the next run assembles the new one. An attach rejects — leaving nothing
  behind — when `openSession` throws, when the name is taken or not a colon-free slug, or when the
  capability is `invariant` (its policies were folded into the permission manager at open, so it
  can neither come nor go). Nothing reaches the teardown of a closing session half-applied.

  To know when a run is over, the Runner now tells the session (`enterRun` / `exitRun`) — which
  also closed two ways a run could leak its started capabilities: a journal flush that failed at
  the end of the run skipped `stop()`, and a failure between assembly and the run's main body
  (replaying the conversation, writing the resume state) skipped the whole teardown.

- **Capability services replace the session facade** (`operon-agents-core`, `operon-agents`).
  `Session` had 34 methods that each looked a capability service up and forwarded one call to it
  — `session.createGoal`, `session.listSkills`, `session.stopBackgroundTask`, … — and
  `HarnessSession` wrapped every one of them again. Both layers are gone, replaced by one
  accessor per capability: `session.goal`, `session.plan`, `session.todo`, `session.task`,
  `session.skills`, `session.plugins`, `session.compaction`, `session.workflow` (REQUIRE tier:
  they throw naming the capability that provides them), plus `session.background` and
  `session.mcp` (PROBE tier, `| undefined`, because their listings legitimately degrade to empty).

  The operations moved to the services that own the state: `GoalStore.create/pause/resume/cancel/
  changeBudget`, `PlanMode.setEnabled`, `BackgroundManager.listSubagents/listWorkflows/
  reconcileSubagents`, `PluginManager.installSummary`. Event emission went with them — a goal
  transition announces itself because the store announces it, not because a facade method
  remembered to, so a caller reaching the store by any route gets the same events.

  Note that optional chaining does NOT guard a REQUIRE accessor: `session.goal?.x` still throws
  when the capability is absent. Feature-test with `session.service("goal")`.

  **Breaking**: every facade method listed above is gone; `session/invoke` over the app-server
  protocol now names operations as `"<service>.<op>"` (`"skills.listSkills"`).

- **MCP transport admission** (`operon-agents-core`, `operon-agents`). A host now states which MCP
  transports it is willing to run: `createMcpServers` and `mcpServersCapability` take
  `allowedTransports`, and `defaultCapabilities` takes
  `allowedMcpTransports`. Anything else is refused with `McpTransportNotPermittedError` while the
  server set is being BUILT, rather than when the connection is attempted — `attempt()` turns a
  failure into a `failed` status and a warning, which is right for "the server is down" and wrong
  for "this host will not run that". A server host should pass `["http"]`: an stdio server is a
  child process of the harness, so it does not follow the session's environment into a sandbox, does
  not survive the replica model a server is deployed under, and carries its secrets in process
  environment. Omitting the option keeps both transports, so nothing changes for a local host, and
  servers disabled with `enabled: false` are exempt. See `docs/architecture.md` §6.3 for which
  capabilities follow the environment and which stay with the host.

### Changed

- The MCP OAuth callback page is now Operon-branded, and a failed sign-in shows the reason (`operon-agents-core`).
- The MCP client name and the dynamic-registration `client_name` are now `Operon` (`operon-agents-core`).

- **Scopes and tokens are gone; a session is handed what it runs on** (all packages).
  `Scope`, `token()`, `Tokens`, `HarnessTokens` and the workspace tier are removed. Every object
  used to sit in a scope under a typed token and be found by walking up harness → workspace →
  session; in practice capabilities reached across that registry at 14 places, none of them for
  another capability's service, and the workspace tier cost a second set of lifetime rules, a
  second provision kind and a reference-counted hold on every open — to share MCP connections and
  a skill scan per directory instead of per process. There are now exactly two lifetimes:

  - **Process** — what `createHarness({ harness })` returns as `HarnessParts` (repository,
    logger, model runtime, default environment, one MCP connection set, one skill scan, tracing),
    plus each extension's `harness` half in `ServiceRegistry`. `HarnessParts.close()` is the one
    seam by which a preset tears down what it opened.
  - **Session** — what each capability opens. A capability is handed the session at
    `openSession(ctx: SessionContext)` (environment, store, events, steer, controls, logger, the
    memoized log) and publishes one `service`; `closeSession` runs in reverse open order, each
    under a deadline, failures isolated. A capability now declares a `contract`: `invariant`
    (permission, compaction — may not be absent, only these may contribute `policies`, a failed
    open fails the session and undoes what was already opened) or `detachable` (everything else).

  **Breaking**:
  - `Session.open(scope, opts)` → `Session.open(opts)`.
  - `createHarness({ harness: (scope) => …, workspace, session: (scope, ctx) => … })` →
    `{ harness: () => HarnessParts, session: (ctx) => Capability[] }`. There is no `workspace`
    hook, no extension `workspace` half, and no `workspaceKey`; a host that needs per-tenant
    isolation runs a harness per tenant.
  - A capability's `provides` entries become `openSession` / `closeSession` / `service`, and
    every capability states `contract`. Services are read as `session.service(name)` /
    `session.requireService(name)` or through the named accessors.
  - Test helpers: `testHarnessScope`, `testSessionScope` and `wireTestSession` are replaced by
    `sessionOptionsFrom` and `testSessionContext` (`operon-agents-core/internal`).

- **Each extension is its own capability** (`operon-agents`). The extension API is unchanged —
  `ExtensionDefinition`, `session(api, ctx)`, the `harness` half, `uses`, `params` and every event
  keep their shape. What changed is underneath: an extension used to be one of N guests inside a
  single `extensions` capability with its own handler table, timeouts, attach queue, state and
  command registry. Each is now mounted as its own `detachable` capability, named by its id, so it
  is assembled, isolated, attached and detached exactly like `goal` or `plan`; `ExtensionRuntime`
  keeps only the translation between the engine and the extension API. `attachExtension` /
  `detachExtension` are `Session.attachCapability` / `detachCapability` underneath, and an
  extension's state and records are the engine's per-capability data under the same
  `extension:<id>:` prefix, so existing sessions read back.

  **Breaking**:
  - `extensionsCapability(definitions)` returns `Capability[]` — spread it into `capabilities`.
    `extensionCapability(definition)` builds one.
  - `session.service("extensions")` is gone. `session.service(id)` is what that extension
    published with `api.expose` (as `extensionHandle(id)` always was).
  - An extension's id may not be the name of a capability the session already has (`goal`,
    `plan`, …): the session refuses to open, naming it, rather than one displacing the other.
  - `actions.record` journals into the session's main conversation rather than the shard of
    whichever frame was active, and works outside a run too.
  - `Capability.closeSession` receives why it runs: `"close"` or `"detach"`.

- **`mcpSessionCapability` is folded into `mcpServersCapability`** (`operon-agents-core`). The two
  had converged: the session one already handled "no shared connections to view" by owning its
  servers outright, which is exactly what the other did. The topology now follows from what the
  host passes — a view over `options.sharedServers`, its own controllers when there is no shared
  set, or the former overlaid by the latter. `configs` still means "the servers this session owns"
  in every case. Substitute `mcpServersCapability` for `mcpSessionCapability`; the arguments are
  unchanged.

- **`createLocalSession` is gone; use `createLocalHarness`** (`operon-agents`). It opened a harness
  per call and then dropped the reference, so nothing could ever close it: `session.close()` only
  unregisters the session from its harness, while the cron timer, the shared MCP connections and
  the rotating log handle all belong to the harness and come down in `harness.close()`. A
  single-session script now reads `const harness = await createLocalHarness({ … })`, then
  `await harness.createSession()`, and closes the harness at the end — `harness.close()` closes its
  sessions first, so it is the only call a script needs.

- **`Machine` is now `Environment`** (all seven packages). The type that says WHERE a session's
  tools run — its commands, its file I/O, the cwd paths resolve against — was called `Machine`,
  which reads as a host or a box. What a session is actually handed is an execution environment: a
  local process tree, an SSH connection, a vendor sandbox, a git worktree rooted in a copy. The
  rename is mechanical and complete, and ships with NO compatibility aliases — an alpha is where
  that is cheap. What to substitute:

  - `Machine` → `Environment`, `MachineFactory` → `EnvironmentFactory`, and every backend with them:
    `BaseMachine`, `LocalMachine`, `NullMachine`, `SshMachine` (+`SshMachineOptions`,
    `SshMachineExtraOptions`), `SandboxMachine`, `SandboxedLocalMachine`, `GitWorkTreeMachine`,
    `E2BMachine` (+`E2BMachineOptions`, `E2BMachineState`), `CloudflareMachine`
    (+`CloudflareMachineOptions`) — each `Machine` becomes `Environment`.
  - Tokens: `T.Machine`, `T.MachineFactory`, `T.WorkspaceMachineFactory`, `T.SessionMachineFactory`
    → `T.Environment`, `T.EnvironmentFactory`, `T.WorkspaceEnvironmentFactory`,
    `T.SessionEnvironmentFactory`.
  - The option, field and parameter spelled `machine` is now `environment`:
    `createSession({ machine })`, `new Harness({ machine })`, `HarnessSession.machine`,
    `ToolRunContext.machine`, `E2BWorkspace.machine`, `EnvironmentResolution.machine` (managed
    hosts), and the `SessionStore` state key `"machine"`.
  - Source files follow: `tool/machine*.ts` → `tool/environment*.ts`, `tool/support/machine-ops.ts`
    → `environment-ops.ts`, `{e2b,cloudflare}/machine.ts` → `environment.ts`, and
    `shared/sandbox-machine.ts` → `shared/sandbox-environment.ts`.

  One name had to move out of the way. The interface describing the OS and shell a backend runs on
  (`osKind`, `osArch`, `osVersion`, `shellName`, `shellPath`) was itself called `Environment`, held
  by a field named `osEnv`. It is now **`OsInfo`** on **`osInfo`**, and `detectEnvironment` is
  `detectOsInfo`. That is what it always described — platform facts about a backend, not the
  environment a session's tools run in — so the collision resolved in the direction it should have
  been named in the first place.

## [0.1.0-alpha.8] — 2026-09-16

### Added

- **A full terminal client** (`operon-agents-tui`, `operon-pi-tui`, both private). The debugging
  TUI was ~1.6k lines with an approval dialog and a status line; it is now a real client, ported
  from Kimi Code CLI (MIT) whose interface is built on the same `@earendil-works/pi-tui` baseline
  ours was. The rendering layer is vendored as `operon-pi-tui`; everything that touches the engine
  was rewritten against our types. What it gained: a multi-line editor with bracketed paste,
  `@` file and `/` command completion, input history, an external-editor key, inline image paste,
  and a `!` shell mode that runs on the session's own machine; markdown, LaTeX, syntax-highlighted
  code and diffs; per-tool result renderers; a queue that steers into the running turn; a
  two-line status line with the context gauge, git badge and a custom `status_line` command;
  dialogs for approvals (with a full-screen diff preview), questions, the model, thinking level,
  permission mode, theme, editor, sessions, tasks and plugins; `/status`, `/usage`, `/context`,
  `/mcp`, `/plugins`, `/goal`, `/init`, `/fork`, `/title`, `/export-md`, `/copy` and `/continue`;
  the todo and background-task panels; a theme system with custom JSON themes; terminal
  notifications, progress and title. A resumed session is rebuilt from its journal
  (`session.getRecords`) through the same hooks that render a live turn. Preferences live in
  `~/.operon/tui.toml`.
- **Host-configured model endpoints** (`operon-agents`). `<homeDir>/providers.toml` declares
  endpoints the built-in catalog does not know — a local server, a gateway, a proxy — as a URL plus
  how to authenticate, and their model lists are fetched from the endpoint
  (`GET {base_url}/models`) rather than declared, because only it knows what it serves.
  `createLocalHarness` reads the file, so every local host sees the same providers; pass
  `modelRuntime` to share one registry between the model a host resolves and the models its
  sessions can switch to, or `loadConfiguredProviders: false` to ignore the file. The pieces are
  public as `createModelRuntimeFromConfig`, `loadProviderConfigs` and `providerFromConfig`, and
  `operon-agents-core` now re-exports the engine's provider-construction surface (`createProvider`,
  `envApiKeyAuth`, `lazyApi`) so a host can build one by hand. An unreachable endpoint warns and
  does not fail startup.
- **`HarnessSession`: `machine`, `listCommands`, `getTodos`** and **`Harness.renameSession`**
  (`operon-agents`). `machine` is where the session's tools run, so a host can run a command in the
  same place the agent does; `listCommands` is the session's own command set (engine plus
  extensions) for a palette; `getTodos` reads the todo list a UI panel shows. `renameSession` sets
  a session's title, which `SessionRepository.rename` carries to every backing (memory, disk,
  Postgres, Redis).
- **Richer tool `display` payloads** (`operon-agents-core`). Beyond a title, the built-in tools now
  state what an approval panel has to draw: `Bash` its `command`, `Edit` its `path` plus
  `before`/`after`, `Write` its `path` and `content`, `Read` its `path`, `Glob`/`Grep` their
  `pattern` and `path`, `FetchURL` its `url`, `WebSearch` its `query`. A client renders a diff or a
  command block from the display instead of re-parsing raw arguments.

- **Code Mode** (`operon-code-mode`, new package; `operon-agents-core`). The model writes a
  TypeScript program that calls its tools, and one `RunCode` call does what would otherwise take
  a model round-trip per tool call — read N files and grep each, branch on a result, aggregate.
  The program runs in QuickJS compiled to WebAssembly, in-process: it can reach nothing but
  `tools.*` (no filesystem, network, `require` or `process` exist on that side), and every
  `tools.X(args)` is a nested call the engine runs through its own pipeline, so permissions,
  hooks and the `Machine` apply exactly as for a direct call — including when Bash lives in
  E2B or under os-sandbox. `createHarness({ extensions: [codeMode()] })`; `mode: "only"` shrinks
  the direct tool surface to a keep-set. The engine gained one entry for it:
  `ToolRunContext.dispatch` (a `NestedToolDispatcher`) lets a running tool call other tools as
  nested calls, whose `tool.call.started` / `tool.result` events carry `parentToolCallId`. A
  nested call that needs an approval nobody can give pauses the run: RunCode journals the calls
  already made and suspends with the request (`request.kind: "approval"`); on resume the program
  re-runs with those calls replayed, the asking call dispatched with the answer, and the rest live
  — from another process too. A tool that suspends for input fails inside a program with a message
  telling the model to call it directly. For this, `NestedToolDispatcher.call` reports an
  unobtainable approval as `interrupt` and accepts the answer as `options.approval`. A long
  program can run detached (`run_in_background`, or `session.detachTool` while it runs) as a
  `code` background task whose log file `BackgroundOutput` reads; attached, its `console.log`
  lines stream as `tool.progress`. The TUI folds a program's nested calls under its card and the
  codex chat UI shows them as progress on its item. `pnpm --filter operon-code-mode evals`
  measures model calls, tokens, adoption and correctness with and without the extension.
- **Managed API: `sessions.update`** (`operon-managed-agents`). `PATCH /v1/sessions/{id}` renames
  a session; the new `sessions.update` authorization action guards it.

### Changed

- **Skill activation returns `steerId` instead of `turnId`.** Match it to
  `steer.queued.steerId` and `message.appended.origin.steerId` to track the queued skill
  message. The removed field contained a synthetic wake ID, not an actual turn ID.

- **Edit applies through a changed file when the match is still unambiguous** (`operon-agents-core`).
  An edit to a file that changed on disk after its Read — a formatter run through Bash, a codegen
  step, the user in an editor — was refused outright, costing a full re-read even when the change
  was nowhere near the edited text. When `old_string` still matches exactly once in the file as it
  is now, the edit applies and the result says the file holds changes the model has not seen.
  A match that vanished or stopped being unique still asks for a Read, and so does every
  `replace_all`, which would rewrite occurrences the model never saw. Unlike Claude Code this is
  not tied to the path's permission rule: what the approver is shown is `old_string`/`new_string`
  either way. The write's compare-and-swap now expects the version and text Edit itself just
  read rather than the ledger's older record, which also closes the window between the check and
  the write, and the file is read once per edit instead of twice.

- **The file freshness ledger keeps a digest, not the file** (`operon-agents-core`, breaking). A
  full read used to retain the whole text (up to 10 MB per file) in an unbounded map, so a long
  session held every file it had ever read. A record now keeps a SHA-256 of the normalized text,
  and the ledger is an LRU capped at `LEDGER_MAX_ENTRIES` (5000); a file that falls out reads as
  not read yet, which asks for a Read rather than waving an edit through. Freshness is still
  mtime-first — the digest only replaces the text in the content review that runs when the mtime
  moved or the backend has none. API: `FileReadRecord.content` → `contentHash`;
  `recordRead` takes a `RecordReadInput` whose `content` is hashed on the way in;
  `WriteTextIfUnchangedOptions.expectedContent` → `expectedContentHash`, computed with
  `hashFileContent` (`operon-agents-core/internal`); `CONTENT_RETENTION_MAX_BYTES` is gone.

- **The TUI's `/model` picker offers configured providers only.** It listed the engine's whole
  registry — over a thousand models across every provider it can speak to — which is a catalog, not
  a choice. It now asks the engine which providers actually have credentials on this machine
  (`Models.getAvailable()`): 16 models with one `ANTHROPIC_API_KEY`, 54 with two keys, instead of
  1220. The model the session was started with is always offered even when no registry knows it, so
  a custom endpoint stays selectable; `/model <provider/model>` still switches to anything the
  engine can name; and a machine with nothing configured falls back to the full list rather than an
  empty one.

- **A provider failure is no longer silent in the TUI.** A run that fails before reaching the model
  (no credentials for the provider just switched to, a rejected key, a rate limit) arrives as an
  assistant message with `stopReason: "error"` and the reason on `errorMessage` — there is no
  `error` event and `turn.ended` carries no text. The client read only user messages, so the turn
  stopped with nothing said. It now surfaces that message, and a failed turn always reports
  something even when nothing upstream supplied a reason.

- **`HarnessSession.activateSkill` keeps both call forms.** It forwarded
  `Parameters<Session["activateSkill"]>`, which collapses to the last overload, so
  `activateSkill(name, args)` did not typecheck through the harness even though it worked. It now
  declares both overloads. `ActivateSkillRequest`, `SkillActivationResult` and
  `SkillActivationTrigger` are exported.

- **Third-party input is validated by schema, and a rejection names the field**
  (`operon-managed-agents`, `operon-agents`, `operon-agents-core`). Four places read input
  written by someone else and checked it by hand, field by field: the managed API's request
  bodies (`session-service.ts`), the app-server's JSON-RPC params (which were cast, not checked),
  plugin manifests and marketplace indexes, and extension `manifest.json`. Each now parses with a
  zod schema pinned to its wire type, so a malformed request or file is refused with a message
  like `metadata.build: metadata values must be strings, numbers, booleans or null` instead of
  being silently dropped or blowing up later. Behaviour is otherwise unchanged: a plugin
  manifest still loads with its valid fields when an optional one is malformed (now with a
  warning naming it), a bare `ApprovalResponse` is still accepted as a resume answer, and
  unknown manifest fields still pass through. `zod` moves from a dev to a runtime dependency of
  `operon-managed-agents`.
- **OTel span attributes are namespaced `operon_agents.*`** (`operon-agents-core`).
  `OTelTracingProcessor` named the framework's own attributes `agent_framework.*` — the
  project's previous name — and its default tracer `agent-framework`. They are now
  `operon_agents.*` (`operon_agents.span.type`, `operon_agents.turn.id`,
  `operon_agents.usage.cost_usd`, …) and `operon-agents`. The `gen_ai.*` semantic-convention
  attributes are unchanged. A collector query or dashboard filtering on the old prefix needs
  the new one.
- **One way into a session: every message is a steer, and every steer is journaled**
  (`operon-agents-core`, `operon-agents`, `operon-agents-peers`, `operon-managed-agents`).
  `deliver()` / `dispatchAccepted()` and the `inbox.received` record they wrote duplicated the
  SteerBus one concept over — a second identity (`deliveryId` beside `steerId`), a second receipt,
  a second event (`delivery.accepted` beside `steer.queued`), and a second copy of the bus's
  idle-wake decision — for one bit of difference: acceptance was written down before dispatch.
  The bus now does that for every producer. `SteerBus.steer()` hands the enqueue to the owning
  session, which journals it as the `steer.queued` lifecycle record before anything can consume
  it, and the receipt gained `journaled`, a promise that settles on durability — so a user's
  follow-up typed mid-turn is now as crash-safe as a managed API delivery was. `steerTo` returns
  the `SteerReceipt` (undefined when refused) and takes `{ id }` to name the steer, which is what
  `operon-agents-peers` now does with its message id; `steer()` / `followUp()` return the receipt
  too. New: `SteerBus.requeue()` / `HarnessSession.requeue()` put a message whose record already
  exists back on a bus without journaling it again (what a managed worker does with what it finds
  in the log), `HarnessSession.whenIdle()`, and the pure `buildSteerMessage` /
  `steerQueuedRecord` / `steerMessageFromRecord` helpers so a writer without a session object
  produces the identical record. `SteerMessage` carries its `channel` and the persisted
  `PromptOrigin`. Removed: `deliver`, `dispatchAccepted`, `DeliveryOptions`, `DeliveryMode`,
  `AcceptedOrigin`, `DeliveryReceipt`, `InboxOrigin`, the `inbox.received` record, the
  `delivery.accepted` event, and `deliveryId` on every origin — `origin.steerId` is the one
  identity from enqueue to consumption. `<external-message>` names it `id="…"`. Logs written
  before this change still replay (the reducer never read `inbox.received`), but their
  unconsumed inputs are not requeued.
- **Managed API: `messages.create` returns the steer** (`operon-managed-agents`). The receipt is
  `{ steerId, sessionId, acceptedAt, channel }` (`MessageReceiptResource`; `deliveryId`, `status`
  and the `"turn"` channel are gone — a receipt never knew whether a turn had started). `mode` is
  `"steer"` (default) or `"follow_up"`; `"auto"` was the same thing as `"steer"`. Clients anchor
  on `origin.steerId`, as `run()` and the examples now do. The worker requeues what it reads
  from the log instead of re-dispatching it, and waits on the session going idle rather than on
  a per-input completion.

### Fixed

- **Resumed sessions accept messages while running and wake for input received during
  teardown.** A failed resume or another durable pause keeps messages queued until resumed;
  a service barrier continues to defer the wake until released.

- **Tracing: a run that pauses is exported** (`operon-agents-core`). A durable pause
  (`turn.paused` — an approval, an `AskUserQuestion`) stops a run without an `agent.ended`, and
  the continuation starts as a new run; `eventSinkTracingBridge` kept the paused run's agent,
  turn and tool spans open and its trace live, so none of them ever reached an exporter and the
  processor held them until shutdown. The bridge now ends them at the pause: the turn with
  reason `paused`, the suspended tool calls marked `paused` (not failed), the agent span closed
  and the trace ended; the resumed run is the next trace of the same session.

- **A headless session's `AskUserQuestion` now pauses durably instead of being dismissed**
  (`operon-agents`, `operon-agents-core`). `QuestionResponder` gained `isLiveQuestioner?()`, the
  question-side twin of `Responder.isLiveApprover`; the harness responder answers `false` while no
  question handler is set, and the tool then suspends (`turn.paused` with the questions on the
  pending list, answered through `resume`) rather than reporting "User dismissed the question".
  Before, a managed session -- nobody attached, driven over the API -- could never ask: the
  harness always supplied a responder, so the tool's headless path was unreachable. A live client
  that registered a question handler is unchanged; one that registered none but set an approval
  handler now pauses on a question too.

### Added

- `examples/linear-github`: an engineer delegated Linear issues that asks in the issue thread,
  opens a pull request, and continues from `@mention`s in PR review comments -- Chat SDK's Linear
  and GitHub adapters bridged to `operon-managed-agents`. Sessions run in E2B sandboxes when
  `E2B_API_KEY` is set (one per session, reconnected on open, paused on close), in host
  directories otherwise; the faux-model end-to-end test runs in both modes. The issue names the
  repository: a session's environment id is `owner/name`, from the issue's label in Linear's
  `repo` label group (`GITHUB_REPO` when it has none), and one server works every repository
  its GitHub App is installed on.

## [0.1.0-alpha.7] — 2026-09-08

### Changed

- **Deferred tool loading is on by default and keeps the cached prompt prefix stable while the
  MCP catalog changes** (`operon-agents-core`). Capability/MCP tools are offered through
  `SearchTool` on every model that supports native deferred tools (`deferTools: false` opts
  out); the tool's description no longer lists the catalog, and the tool is present from the
  first request even before any server connects. A server connecting, disconnecting, reconnecting
  or changing a tool's definition mid-conversation is announced in a system reminder appended at
  the tail of the history (journaled with a `tool_catalog_delta` origin) instead of rewriting the
  request's tool definitions; a definition already loaded stays declared for the tool references
  in history after its server leaves (wire-only, not executable) and a changed definition arrives
  under a versioned name. On Anthropic, a placeholder `defer_loading` tool keeps the API's
  deferred-tool mode on before the first search, so the first connection does not flip the prompt.
  Full compaction drops the load points it removes (the model is re-told what to search) except
  for definitions the kept tail still calls, which ride on the compaction summary's origin
  (`loadedTools`, also in the `context.apply_compaction` record and `history.compacted` event);
  micro compaction keeps load points as is, and both survive durable replay. Calling a deferred tool that is not
  loaded now returns guidance to load it with `SearchTool` (with the input schema for reference)
  instead of `unknown tool`. The catalog is refreshed before every model request, so a server
  that connects during a turn is visible at the next step.

## [0.1.0-alpha.6] — 2026-09-05

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
- `prompt()` / `resume()` register their run synchronously again when no barrier gate is held, so
  a `cancel()` or `close()` on the very next line finds it (an unconditional await had opened a
  gap in which the run was invisible and went on to call the model). `createSession` and
  `forkSession` register their in-flight open like `resumeSession` does, so a resume for an id
  being created joins that open instead of building a second instance over the same store.
- `promptStream()` now schedules the idle wake on settling, like `prompt()`: input queued as the
  run ended (a background notification at `agent.ended`) starts its follow-up turn instead of
  sitting queued until the next prompt.
- `Runner.runStream` subscribes to the session's events only once it holds the run lock
  (`operon-agents-core`): a stream queued behind another run no longer replays that run's prompt
  and answer before its own.
- Scopes the harness tears down itself — a workspace whose last session left, a failed open's
  session scope, the harness scope on `harness.close()` — now dispose each service under a 5s
  deadline and log the stragglers, like the core session already did; one hung MCP shutdown no
  longer hangs `session.close()` / `harness.close()`. `harness.close()` returns the same promise
  on every call and refuses new `createSession` / `resumeSession` / `forkSession` while closing.
- `Runner` closes the session scope it created when the `session` hook or `Session.open` fails
  (`operon-agents-core`); it used to stay attached to the runner's scope with whatever the hook
  had registered.
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
