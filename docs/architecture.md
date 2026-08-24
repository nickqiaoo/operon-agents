# operon-agents Architecture: The Onion, Kernel and Hosts, Capabilities and Extensions

> This is the **top-level map** of the framework. After reading it you should be able to answer: how
> many layers is the code in, what does each own, why was it cut this way, and which layer does my
> requirement belong to?
> Beyond this map, the source is the reference: the header comments on the files named throughout
> carry the detail that would otherwise live in a companion note.

---

## 0 · In one sentence

**A host-agnostic execution kernel wrapped in four rings: engine-level detachable modules
(capabilities), a process-level runtime (the harness), user-space behavior (extensions), and
deployment hosts (local / managed) — with every choice about *where it runs, where it is stored, and
which model it calls* pushed out to adapters in the outermost ring.** Dependencies point inward only,
and inner rings know nothing of outer ones. That is the onion.

---

## 1 · The onion: six rings and the direction of dependency

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │  ⑥ Adapters / substrate  sandbox(E2B·Cloudflare) os-sandbox   │
                    │     Machine impls · Store backends(disk/pg/redis/memory)      │
                    │     · model vendors                                           │
                    │  ┌─────────────────────────────────────────────────────────┐ │
                    │  │  ⑤ Hosts / products    local: app-server · TUI · desktop │ │
                    │  │                        server: managed-agents           │ │
                    │  │  ┌───────────────────────────────────────────────────┐  │ │
                    │  │  │  ④ Behavior  extension (value channel/file channel)│  │ │
                    │  │  │     cron · peers · shared browser · telemetry …   │  │ │
                    │  │  │  ┌─────────────────────────────────────────────┐  │  │ │
                    │  │  │  │  ③ Process runtime  Harness(packages/agents)│  │  │ │
                    │  │  │  │     session fleet · ServiceRegistry ·        │  │  │ │
                    │  │  │  │     extension runtime · loader/barrier ·     │  │  │ │
                    │  │  │  │     composition root (local)                 │  │  │ │
                    │  │  │  │  ┌───────────────────────────────────────┐  │  │  │ │
                    │  │  │  │  │  ② Engine extension point: capability │  │  │  │ │
                    │  │  │  │  │     compaction · permission policy ·  │  │  │  │ │
                    │  │  │  │  │     background · skills · plan · mcp… │  │  │  │ │
                    │  │  │  │  │  ┌─────────────────────────────────┐  │  │  │  │ │
                    │  │  │  │  │  │  ① Kernel   agents-core          │  │  │  │  │ │
                    │  │  │  │  │  │   Runner·Session·Engine          │  │  │  │  │ │
                    │  │  │  │  │  │   runTurn·executeStep·runCalls   │  │  │  │  │ │
                    │  │  │  │  │  │   protocol · LoopHooks · 3 seams │  │  │  │  │ │
                    │  │  │  │  │  │   (ChatModel/SessionStore/Machine)│  │  │  │  │ │
                    │  │  │  │  │  │                                   │  │  │  │  │ │
                    │  │  │  │  │  └─────────────────────────────────┘  │  │  │  │ │
                    │  │  │  │  └───────────────────────────────────────┘  │  │  │ │
                    │  │  │  └─────────────────────────────────────────────┘  │  │ │
                    │  │  └───────────────────────────────────────────────────┘  │ │
                    │  └─────────────────────────────────────────────────────────┘ │
                    └──────────────────────────────────────────────────────────────┘
                       Dependency direction: outer → inner. Inner rings never import outer
                       rings and do not know their names.
```

| Ring | Package / directory | Responsibility in one line | Explicitly **not** responsible for |
|---|---|---|---|
| ① Kernel | `agents-core` (`agent/`, `loop/`, `protocol/`, `tool/`, `store/` contracts, `permission/`, `events/`) | The **semantics** of the agent loop: the turn/step/tool-call cycle, interruption and resume, the single point of permission enforcement, the contracts for events and persistence | Knows nothing of "another session", of what cron or todo are; does not load files; does not choose backends |
| ② Capability | `agents-core/src/capabilities/`, `mcp/`, `plugins/` | Detachable modules that **change run semantics**, participating in the loop via `LoopHooks`/tools/injectors/gates/policies | Not cross-session, not hot-reloadable, never "skipped" (present means in effect) |
| ③ Harness | `packages/agents` (`harness.ts`, `extensions/`, `local.ts`) | The process-level runtime: session fleet, service registry, extension runtime and loader, deployment presets | Contains no new engine behavior (pure composition of core primitives) |
| ④ Extension | `packages/agents/src/cron/`, `agents-peers`, `examples/*-extension` | Behavior **on top of** the engine: tools, injection, commands, events, shared resources; attachable, time-limited, absent-tolerant | Carries no vetoing or safety logic |
| ⑤ Host | `packages/agents/src/app-server/`, `agents-tui`, `managed-agents` | Exposes the harness to a person or a network: stdio JSON-RPC / SSE+HTTP / terminal | Does not change the engine; only injects backends |
| ⑥ Adapter | `sandbox`, `os-sandbox`, `store/{disk,pg,redis}.ts`, `llm/` providers | Implements the three ports the kernel defines (Machine / SessionStore / ChatModel) | Contains no business logic |

**Why an onion rather than a flat set of packages**: this framework serves two deployments at once
(local interactive, server managed). What genuinely diverges between them is storage, process model,
extensibility, permission interaction, and execution substrate — and **none of those five is the agent
loop itself**; they are the five rows of the table above. Push what varies outward, lock what does not
inward, and 80% of the logic is written once while the 20% of specialization grows in the outer rings, with no
`if (mode === "server")` anywhere in between (the code comments call this **Invariant 7: there is no
mode in the engine**).

---

## 2 · ① The kernel: the execution path and three seams

### 2.1 A five-layer execution path, with state that never settles on objects

```
Runner.run(agent, input)           one run: open/close Session, run lock, ownership resolution, guardrail, teardown
 └─ Engine.run(agent, ctx, state)  turn loop: handoff, injection, assembling tools/hooks, interruption decisions
     └─ runTurn()                  step loop: maxSteps, steer drain, HITL resume
         └─ executeStep()          one model call: streaming retry, event decomposition, guardrail, append assistant message
             └─ runCalls()         one batch of tool calls: parse → authorize → schedule → execute → settle
```

Each layer does one thing, and **all state flows through the `(agent, context, state)` parameters**;
`Engine` itself holds no run state (see the class comment in `runner.ts`). Sub-agents derive a child
frame through `deriveChild`, which is the **only** place in the project that mints a child frame.

> **Why**: concurrent sub-agents, usage accounting, the interruption tree, and workflow parallelism
> are all built on the single concept of a frame. Because a frame is a value rather than object state,
> nothing has to maintain shadow state and the question "which object holds the truth" never arises.

### 2.2 Three seams: the kernel knows only interfaces

| Seam | Interface | Implementations in the kernel | Implementations outside |
|---|---|---|---|
| Execution substrate | `Machine` (`tool/machine.ts`) | `LocalMachine`, `NullMachine`, SSH | `operon-sandbox` (direct E2B/Cloudflare vendor SDKs), `operon-os-sandbox` (Seatbelt/bubblewrap wrapping LocalMachine) |
| Persistence | `SessionStore` + `SessionRepository` (`store/`) | memory, disk (JSONL) | pg, redis — **four backends, one contract** |
| Model | `ChatModel` / `ModelRuntime` (`llm/`) | provider registry | each vendor |

The design stance of `Machine` deserves its own note: `RunCommandOptions` expresses **intent**
(timeoutMs, maxOutputBytes, onOutput) which each backend honors with its own native means, rather than
handing POSIX process mechanics to the caller to assemble — an assembly that works only on the local
backend and fails silently on a sandbox. `RunCommandResult.exitCode` may be `undefined` and
`terminated` may be `false`, so the type forces callers to face the case where the backend cannot
confirm, instead of fabricating a zero.

`SessionStore` has the shape **① a linear append log + ② KV current state + ③ optional
watch/flush/rewrite**. The log is flat, sharded by address, append-only; history is obtained by
folding it one way through `reduceHistory`, and live and replay paths share the same fold function
(`HistoryFold`), so **the two paths cannot drift apart semantically**.

### 2.3 Invariants the kernel establishes

These belong to the kernel rather than a host, because skipping any one of them once is an incident:

- **Single owner**: runs on the same session are serialized (`withRunLock`; Invariant 2 in the code
  comments), and across processes this is guaranteed by the work table's lease plus a fencing token
  (`SessionWork`, see §6.2; the kernel's own `SessionLock` is the in-process form of the same
  contract).
- **A single point of permission enforcement**: `PermissionManager` is a session-level singleton and
  `buildAuthorizer` is the sole authorization entry. The current frame's transcript and tool table
  that `auto` mode needs are bound per turn through a closure and never hung on the manager shared by
  concurrent frames; approval auditing has exactly one landing point. Four modes:
  `manual | workspace | yolo | auto`.
- **Durable interruption**: "absence of an answerer makes it durable" — with a live approver present
  the loop asks one by one, otherwise `pauseRun` persists to disk; a tool's `ctx.suspend()` is always
  durable. If even one tool in a batch awaits approval, **the whole batch does not run** (repark),
  which keeps the paused frame intact. That is what makes "start → hit an approval → kill the process
  → reopen tomorrow → answer by approvalId → continue where it stopped" hold
  (`examples/durable-interruption`).
- **Everything the model can see goes through `ConversationContext`**, with `messages` read-only; the
  journal is written serially in a chain, each write caught individually, and errors accumulate to be
  thrown once at `flush()`.
- **Events and records are separate**: low-frequency structural events (`agent.*`, `turn.*`, messages,
  pauses) carry a stable `eventId` and are replayable (in `committed` mode they are persisted before
  publication; `immediate` mode preserves local latency), while high-frequency deltas go only to live.
  `SessionProjection` establishes the snapshot/live boundary atomically on a single thread, so a late
  consumer (a UI opening, an SSE reconnect) finds each event either in the snapshot or in the live
  stream — **never dropped, never duplicated**.

---

## 3 · ② Capability: the detachable part of the engine

### 3.1 The contract

```ts
interface Capability {
  name;  tools?;  toolProviders?;  toolFilters?;        // add/remove tools
  hooks?: Partial<LoopHooks>;                            // participate in the step machine (10 slots)
  injectors?;  policies?;  gates?;  service?;            // injection, permission rules, arbitration, named service
  start?(ctx, signal); stop?(signal);                    // per run
  openSession?(ctx); closeSession?();                    // per session
}
```

The ten `LoopHooks` slots: `beforeRun / beforeStep / afterStep / beforeModelRequest /
afterModelResponse / prepareToolExecution / authorizeToolExecution / finalizeToolResult /
shouldContinueAfterStop / recoverStepError`. This is **the kernel's only extension surface** —
permissions, compaction and guardrails all attach through those ten slots, and there is no second
mechanism.

### 3.2 Assembly (`capabilities/assembler.ts`)

At the start of every run, `assembleCapabilities()` composes a set of capabilities into one
`AssembledCapabilities`:

- `start()` times out at 10s and `stop()` at 5s, and **a timeout means an abort signal plus that
  capability being absent** — none of its contributions are registered (fault isolation). A broken
  capability costs the run a feature rather than hanging it;
- duplicate names are skipped and recorded as a diagnostic;
- each hook is composed with **the semantics of its own slot** (`compose-hooks.ts`): `beforeStep` runs
  in order and short-circuits on the first block; `authorizeToolExecution` is won by the first
  non-undefined result; `finalizeToolResult` passes down a chain; `afterStep` and
  `shouldContinueAfterStop` all run and are OR-ed.

> **Why define composition per slot instead of a generic middleware chain**: each slot poses a
> different question — "should this be blocked" is a short-circuit problem, "how is the result
> rewritten" is a chaining problem, "should there be another round" is an OR problem. A uniform
> `next()` chain hides those differences in each implementor's hands and makes the composed result
> depend on registration order. Fixing the semantics per slot puts the behavior under the framework's
> guarantee, independent of order.

### 3.3 Gates: the only "reverse question" between capabilities

Every extension point has the engine asking a capability. The sole exception is compaction — it
decides for itself that the context has grown too large, so anyone wanting a say must be asked by
**it**. `CapabilityGates` is a **named table** (currently holding only `compaction`), not a string
bus: that interface is the complete list of "things another capability may veto", and adding an entry
means changing core. The comment says it outright: if it ever grows longer than a hand, that is the
signal to design a real middleware mechanism.

### 3.4 The kernel knows no capability by name

compaction, background, goal, plan, task, todo, skills, workflow, user-hooks, mcp and plugins are all
assembled per session. `defaultCapabilities()` (`harness.ts`) is the local host's default list; a
server does not install the local-only ones. `Session` has exactly two levels of access to them:
**PROBE** (`session.goal` returns `undefined` when not enabled) and **REQUIRE** (`compact()` throws
`CapabilityMissingError` when not enabled).

---

## 4 · ③ Harness: the process-level runtime, and why this layer exists

Core's world holds only "one session, one run". The following have no representation in core at all,
which is why an outer ring is required:

| Only the harness has this | Where it shows up |
|---|---|
| **Another session** | `ExtensionHost.newSession / fork / openSession / listSessions`; the peers spawn factory |
| **A process-level shared instance** | `ServiceRegistry` (`extensions/services.ts`) — indirect handles, lease counting, one generation serving only its own |
| **Extension runtime** | `ExtensionRuntime` (`extensions/runtime.ts`) projects capability hooks **one by one** into extension events, giving each hook a timeout and fault isolation |
| **File loading** | `extensions/loader.ts`: file → import → value → attach; manual approval accounted by mtime |
| **Model provider registry** | `modelRuntime`, global to the harness |
| **Deployment presets** | `createLocalHarness` in `local.ts`: disk sessions, LocalMachine, rolling logs, file-based MCP credentials, disk agent profiles, the cron extension |

The comment on `createHarness()` pins down its nature: **"pure composition of core primitives — no new
engine behavior"**. The harness is not a second engine; it is a composition root.

> **Why there is a local preset but no server preset** (see the header comment in `local.ts`): a
> server preset would save three lines while forcing every session to share one `McpOAuthService` —
> and therefore one credential store with no tenant dimension. What a server should inject is the
> host's own business; `examples/managed-agents` shows how to call `createHarness` directly.

---

## 5 · ④ Extension: behavior on top of the engine

### 5.1 One definition, three parts

```ts
interface ExtensionDefinition<TShared, TParams, TServices> {
  id: string;                                         // durable identity (slug); state/records are scoped by it
  create?(host): TShared;                             // process half: once per harness, the return value is the service (registered under id)
  uses?: (keyof TServices)[];                         // whose services this consumes: validated at registration, resolved into setup
  setup(api, { shared, params, services }): cleanup;  // session half: once per session
}
```

There is no second type, no `tier` option and no `getService`: providing is `create`, consuming is
`uses`, registration happens once (the `createHarness({ extensions })` array or `extensionDir`), and
per-session variation is `createSession({ params })`. `setup` only ever sees **handles** (`ctx.shared`
/ `ctx.services`) and never holds an instance — which is the precondition for hot replacement.

### 5.2 `ExtensionAPI`: two channels, four seams

- **`api.on(name, handler)` — decision points** (15 events: `run.start / step.start / step.end /
  run.settled / model.request / model.response / tool.call / tool.authorize / tool.result /
  compaction.before / provider.headers / provider.payload / provider.response / session.start /
  session.end`). The return value participates in the loop; physically it is a `LoopHooks` slot.
- **`api.onEvent(listener)` — observation.** Read-only, straight through to `EventSink`, fault-isolated
  and torn down with the extension. They are separate because some things exist only on the event
  stream (a sub-agent's `agent.started` fires for every frame, while `run.start` fires only for the
  top level).
- **Four general-purpose seams** (see `extensions/types.ts`): `registerCommand` (commands),
  `emitEvent` (events), `expose` (a control-plane handle) and `records()` (reading provenance back);
  plus `api.state` (durable KV), `registerTool` and `registerInjector`. The host **never writes glue
  for an individual extension** — moving cron out of core used each of the four seams once, and the
  four cron-specific RPCs in app-server were replaced by one generic `runCommand`.

### 5.3 Guardrails: an extension is a user-space program

| | capability | extension |
|---|---|---|
| Presence | necessarily present | may be absent (not loaded or detached is normal) |
| Timeout | unbounded | 30s at decision points, 1s for observers; a timeout means it is skipped |
| Failure | the run fails | isolated: logged, and the run continues |
| Position in the pipeline | anywhere | fixed, occupying one slot |
| Consumed by name by the engine | possible via the `service` slot | no (it reaches the host through `expose`) |
| Attach/detach | fixed at session creation | attach/detach at run boundaries, reload from file |

Read the guardrails the other way around: **the correctness of a run may never depend on any
extension.** The framework promises that a bad extension cannot drag down a run, and the price is that
extensions cannot carry vetoing logic. By OS analogy: a capability is a kernel module, an extension is
a user-space program.

### 5.4 Two delivery channels, the same object

```
                 ┌── value channel: createHarness({ extensions: [def] })
                 │   server side: compiled into the host, shipped with the process, changing code = rolling restart
ExtensionDefinition ─┤
                 └── file channel: extensionDir/<id>/{manifest.json, index.js}
                     client side: a single esbuild bundle, load/reload/unload
```

The only differences between the channels are who hands the definition to the framework and where the
configuration comes from. **The server's stability comes from there being no mechanism at all behind
the registry** (no replace, no loader, no barrier); **the client's liveness comes from that same
registry wired to a loader and a barrier**. The manifest carries only what must be known *before*
importing code (`id`/`entry`/`engine`/presentation fields); `create` and `uses` are always read from
the definition, avoiding two sources of truth.

### 5.5 Hot replacement: handles plus a barrier, one generation serving only its own

Two layers:

1. **Replacing the implementation** (the interface did not change): `ServiceRegistry.replace()` swaps
   the table entry atomically, drains leases on the old instance, and disposes it — with zero session
   participation.
2. **Replacing the shape** (method signatures or the tool set changed): `harness.replaceExtension()`
   goes through the **boundary rendezvous barrier** — take the mutex → install a run gate on every
   session → wait for all of them to reach a run boundary → detach the old and attach the new while
   everything is at rest → release. On timeout it **abandons the change, releases, and reports the
   stuck sessions**; it never aborts a user's in-flight run.

> **Why not rolling replacement**: to save a single global pause, rolling replacement invents a
> two-generation window, and that window spawns three problems — split brain, generation-aware
> factories, and the terminal state of stragglers. All three are artifacts of coexistence. Once the
> barrier restores the "no coexistence" rule, all three disappear together, and the result is
> **guaranteed by mechanism rather than by the discipline of service authors**. Our sacrifice runs the
> opposite way from a multi-tenant server's (which would bound the wait and force the change through):
> we abandon the change to protect the run. That difference is precisely the difference in guarantee
> tier between "single-user local" and "multi-tenant server".
>
> **Why no topological sort is needed**: the dependency graph is a depth-1 bipartite graph
> (session-level consumers → process-level services, one direction), and only one service is replaced
> at a time. The flat model retains the option of upgrading to graph algorithms (roughly 250
> incremental lines), whereas an engine model cannot be taken apart in reverse — the asymmetry favors
> the flat model.

### 5.6 "The seam in core, the behavior in an extension" — the most useful third pattern

When a feature is 99% behavior and the remaining 1% is out of reach, do not promote it to a
capability: add **the narrowest possible seam** to core and leave the body in an extension. peers is
the model case — core gained only `steerTo`, `SteerOrigin` and idle wake-up, while the entire
inter-agent communication system (store-backed mailboxes, deny-by-default visibility, rate limiting)
went into the engine at zero lines, "built entirely on public seams". The bar for opening a seam: at
least two imaginable consumers, and core remains ignorant of who uses it.

---

## 6 · ⑤ Hosts: two exposures of the same harness

### 6.1 The local host (the main theatre)

- `app-server`: NDJSON JSON-RPC over stdio, the protocol a desktop client uses to drive the harness;
  the generic `runCommand` RPC carries extension commands.
- `agents-tui`: a terminal client (internal debugging only).
- All local conventions are gathered in `createLocalHarness`: interactive approval (a human is
  present), extension hot reloading, cron.

### 6.2 The server host `managed-agents` (positioned as a product substrate)

Three parts, with hard boundaries between them:

| Part | Responsibility | Key properties |
|---|---|---|
| `SessionService` | The API surface: **entirely store operations**. It opens no sessions, installs no capabilities, connects no MCP, starts no sandbox | Stateless and horizontally scalable; the gateway in front is an ordinary reverse proxy needing no owner affinity; **there is no `open()`** — otherwise every read could wake a billable sandbox |
| `SessionWorker` | The execution half: claims sessions from the work table, holds the lease, moves the inbox into session records, and runs. cancel and resume are control records in the same log going through the same loop | **"Handled" means the input landed in the session record** (`message.appended`), not that the turn finished: if a turn dies midway the history is still complete, the reopened session is idle, and the next message continues without re-running. **There is no separate recovery branch**: the next worker seeing unprocessed inbox records past the cursor is indistinguishable from a session nobody has touched. **The worker is pure execution**: it never calls `list()`, never scans logs, and knows no other node; finding work is only the claim loop in `start()` (one indexed statement, zero rows on an empty table) plus an in-process nudge. **Failures are observable**: failures inside a turn get a `turn.ended reason:"failed"` from the kernel runner (with error text, persisted); failures outside a turn (environment, sandbox refusing to start) are broadcast by the worker as a live `error` event; an open turn left by a process dying is closed by the next claim |
| `SessionWork` (the work table, `Memory` / `Pg`) plus metadata and the broadcaster | **The queue and the lock are the same table**: `append` writes the record into the log and sets the row to woken (in one transaction on Postgres); `claim` takes a row with `FOR UPDATE SKIP LOCKED`, and holding it is holding the lease (with a fencing token); renewal is the heartbeat and **carries back whether anything new arrived** — which is how a cancel reaches the machine currently running, without needing to know which one it is. A lease that expires without a release means something died holding it, and the next claim takes it anyway and appends the missing `turn.ended failed` | No dispatcher, no Kafka, no LISTEN/NOTIFY: Postgres is already the truth, so using it directly as the queue leaves no double write to reconcile. Steady-state load: zero queries for an idle session; one primary-key UPDATE every 2s for a running one; one indexed empty query per worker per second. `authorize` is **required** |

Writing and observing are separated at the protocol level: `messages.create()` returns an acceptance
receipt immediately (the input is journaled **at the moment of acceptance**, which is the durable
evidence behind the 202); `events.stream()` is a session-level live feed spanning turns that backfills
history before going live and carries a durable cursor (an SSE `id:` is emitted only for events
findable in the log, with `Last-Event-ID` / `after` resumption; clients reconnect automatically and
deduplicate by `eventId`); `events.list()` pages through history; the same `eventId` denotes the same
identity in both. `run()` only recognizes the end of the turn its own delivery belongs to, so it is
never ended early by an older turn's `turn.ended` arriving in the backfill.

> **Why single ownership belongs in the framework rather than the application**: it is a
> framework-level invariant, and making every consumer implement
> leases and fencing outsources exactly the part that is easiest to get wrong and hardest to test.

---

## 7 · The journey of one prompt (threading all six rings)

```
⑤ desktop → app-server RPC "prompt"                    (or ⑤ HTTP POST /messages → journal inbox → worker claims it)
③ HarnessSession.prompt()  ── run gate (stands down during a barrier) ── extension run.start decision point (30s guardrail)
① Runner.run → acquireSession → withRunLock (single owner)
① Runner.execute → beginRun → ② assembleCapabilities (10s start timeout, absence isolated)
① context = liveContext ?? replayContext (⑥ SessionStore cold replay)
① Engine.run ─ turn loop: drainFollowUps → injectAtTurnBoundary (② injectors) → buildRunTools (② tools ∪ ④ registerTool, ② toolFilters)
①   runTurn ─ step loop: drainSteering (④ peers / ④ cron arriving over SteerBus)
①     executeStep: ② compaction.beforeStep → ⑥ ChatModel streaming → event decomposition → guardrail
①       runCalls: prepare (②/④ rewrite) → ① authorize (the single point of enforcement) → ToolScheduler orders by resource conflict → ⑥ Machine.run
①         approval required and no answerer present → pauseRun persists (⑥ Store) → returns interrupted; otherwise continue
①   settleRun: flush the shard, ② stop (5s timeout)
③ detachRun (quiet point): queued attach/detach take effect here; the barrier rendezvouses here
⑤ events: published per eventPublication (local immediate preserves latency; managed committed persists first) → SessionProjection snapshot/live → SSE / RPC to the frontend
```

---

## 8 · Which layer does it belong to: a decision shortcut

**The litmus test: if this logic is skipped once (timeout, fault, not loaded), is that "a missing
feature" or "an incident"?** Missing feature → extension; incident → capability; neither, just a
backend choice → adapter; needs "another session" or process-level sharing → a seam the harness
provides.

| Requirement | Lands in | Example |
|---|---|---|
| A safety/correctness invariant (permissions, compaction, single owner) | ① kernel / ② capability | permission, compaction, SessionLock |
| Changes run semantics, needs the compaction gate / a toolFilter / the `service` slot | ② capability | background, skills, mcp |
| Tools, injection, commands, notifications, telemetry, shared resources, external integrations | ④ extension | cron, peers, browser |
| 99% behavior plus 1% out of reach | open the narrowest seam in core, keep the body in ④ | peers' `steerTo` |
| Where it runs / where it is stored / which model | ⑥ adapter | sandbox, pg, provider |
| How it is exposed to a person or a network | ⑤ host | app-server, managed |

A sense of frequency: extensions are routine (dozens a year is a healthy ecosystem), capabilities are
rare events (single digits a year; more than that means the layering is wrong). Existing capabilities
are not migrated — the criterion is applied only to new ones.

---

## 9 · Design decisions: why, what it bought, what it cost

| Decision | Why | Bought | Cost (recorded openly) |
|---|---|---|---|
| One kernel plus two host profiles, not two frameworks | None of the five things that diverge is the agent loop | 80% of the logic written once; the option of flipping priorities on the same kernel | Host requirements seep into kernel contracts (the store's whole-session sequence semantics is one instance — the cost is isolated, the contract complexity remains) |
| A stateless Engine with state flowing through parameters | Only a frame that is a value can be made concurrent, derived and serialized | Sub-agents, usage, the interruption tree and workflows share one frame semantics | The five-layer path has a higher cognitive bar than a single-loop design |
| The three seams are interfaces; implementations live in outer rings | The difference between local and sandbox, disk and pg, does not belong in the loop | Four store backends on one contract; a replaceable Machine; `Invariant 7`, no mode | The interface must stay honest to the weakest backend (`exitCode: undefined`; mtime absence falls back to content comparison) |
| A session-level permission singleton with a single enforcement point | When concurrent frames share a manager, the current frame's data must be closure-bound | Auditing has one landing point; the invariant can only tighten inward | — |
| Durable interruption; absence of an answerer makes it durable | Processes die, and approvals and `suspend` must cross them | Kill the process, resume the next day | The store contract, the interruption tree and frame serialization must all land together |
| Capability composition fixed per slot | Short-circuit, chaining and OR are different problems | Behavior is independent of registration order | A new slot means changing core |
| Gates are a named table, not a bus | The table is the complete list of vetoable things | Visible and auditable | Needs redesigning once it outgrows a hand |
| Every extension hook wears a guardrail | A wide surface must be safe, so the contract must be weak | A bad extension cannot drag down a run; live attach/detach | Extensions cannot carry vetoing logic |
| One `ExtensionDefinition` with `create`/`uses`/`setup` | Server and client must not have "two versions" | One body of code delivered to both ends | The session half can only use services through handles |
| Core accepts values only; file loading is a shell | Closures capture host state, so trust travels with construction | No jiti/vm/cache generations; "capability is decided at birth" holds | A third-party ecosystem would need an additional trust layer (deferred until there are submissions) |
| No two generations coexist; rendezvous at a barrier | All three problems of coexistence are artifacts of coexistence | Consistency guaranteed by mechanism, not discipline | Replacing a shape may pause for minutes; on timeout the change fails and is retried |
| A flat service model with no topology | The dependency graph has depth 1 | Upgradable incrementally, not reversible | No support for cross-author service chains (not yet needed) |
| A stateless `SessionService`; workers claim work from the store | A session is not "somewhere", it is in the store | Any replica serves any request; crash recovery is not a special path | Every write must be journaled first |
| Single ownership in the framework | The easiest to get wrong and hardest to test should not be outsourced | Postgres lease plus fencing included in the package | — |

---

## 10 · What this design is good at, and what it costs

**Structural strengths:**

1. The split between kernel and host is real — the package structure delivers it rather than merely
   claiming it, and server capability is a neutral seam rather than an implementation grown around one
   particular cloud.
2. Five converged layers with a stateless Engine, so a frame is a value and nothing maintains shadow
   state.
3. Durable interruption: approval and `suspend` survive the death of the process, which requires the
   store contract, the interruption tree and frame serialization to be in place simultaneously.
4. A single point of permission enforcement, with an LLM-driven auto-approver as one of four modes.
5. The execution substrate is a first-class citizen: the `Machine` seam plus OS-level sandboxing plus
   vendor sandboxes.
6. The capability/extension split: the kernel knows nothing of todo or cron; a bad extension cannot
   drag down a run; one body of extension code is delivered to both ends; service replacement does not
   depend on author discipline.
7. Trade-offs are on the record — every key decision documents why, what was deliberately left out,
   and what it cost.

**Honest limitations:** verification volume is still thin (predominantly e2e scripts, with CI only
recently wired in); the product surface depends on a closed-source desktop client; ACP is not yet
among the supported protocols; the evaluation loop is early; and the abstraction was paid for in order
to serve multiple hosts, while so far only one host has truly exercised it.

---

## 11 · Reading path and source coordinates

| To understand | Read first | Then the code |
|---|---|---|
| How one prompt runs to completion | §2.1 and §7 of this document | `agent/runner.ts` → `loop/run-turn.ts` → `loop/turn-step.ts` → `loop/tool-call.ts` |
| How a capability is composed into the loop | §3 of this document | `capabilities/capability.ts`, `assembler.ts`, `agent/compose-hooks.ts` |
| What the harness has, and why | §4 of this document | `packages/agents/src/harness.ts`, `local.ts` |
| Writing an extension | §5 of this document | `extensions/types.ts`, `examples/extension-template`, `examples/peers-extension` |
| Hot replacement and the barrier | §5.5 of this document | `extensions/services.ts`, `extensions/manager.ts`, `extensions/loader.ts` |
| How a server is assembled | §6.2 of this document | `managed-agents/src/server/{session-service,session-worker}.ts`, `examples/managed-agents` |
| Replacing the execution substrate | `examples/README.md` | `tool/machine.ts`, `packages/sandbox`, `packages/os-sandbox` |
| Events and UI state | §2.3 of this document | `events/projection.ts`, `events/publisher.ts` |
