# operon-agents-peers

Peer discovery and messaging between agents. **Nothing in this package lives in the engine** — it is built entirely on public seams.

The organizing rule: **capability follows birth, and identity is produced by explicit acts** — never inferred from event timing, never granted by being spawned at the right moment.

- An ordinary agent holds the **`Team` tool**: it can form a team, spawn teammates into it, and message exactly those members. It has no general peer messaging, and no roster identity until the moment it creates a team.
- A teammate is a **session** created on the host's terms (the `peers()` extension's `teammates` types), born with the member **`Hub` tool** (general peer messaging, gated by the visibility policy) and its roster identity — and **not** `Team`: a teammate is a member, not a team-former.
- A delegation (`Agent(...)`) never enters the peer world at all. Quick, self-contained work stays a function call; a teammate is for work that outlives one call and converses.

## One definition, two channels

peers is packaged as **one `ExtensionDefinition`, `peers(config)`** — an ordinary extension that happens to carry a `create` half (its process-shared `PeerNetwork`). A host takes it through whichever channel fits its deployment; nothing about the definition changes.

| | **Server — by value** | **Desktop — from a file** |
|---|---|---|
| Hand-over | `createHarness({ extensions: [peers(config)] })` | a bundle in `extensionDir` whose default export is `peers(config)`, then `harness.extensions.load("peers")` |
| Config | in code | in the bundle; state in the data dir the framework hands it (`host.dataDir`) |
| Shipping a change | new build, rolling restart | `harness.extensions.reload("peers")`; sessions stay open |
| Reference | `test/e2e-peers-extension.ts` (a) | `examples/peers-extension`, `test/e2e-peers-extension.ts` (b) |

Same code, same tests on both. The framework runs the `create` half **once** and registers the network as the `peers` service; the extension's `setup` runs **per session** and reaches the network only through a stable handle (`shared`). That handle is what lets the file form reload the network under live sessions — and on the server it is a plain registry lookup with nothing dynamic behind it (not replaceable, no loader, no barrier).

Which tool a session gets is decided by its **per-session param**, not by wiring: a spawned teammate carries `params.peers = { member }` and gets `Hub`; every other session gets `Team`. Capability follows birth, and a teammate never holds `Team` — it is a member.

### Server: pass it by value

```ts
import { createHarness } from "operon-agents";
import { createFilePeerRepo, peers, sharedLabelVisibility } from "operon-agents-peers";

const harness = createHarness({
  model,
  extensions: [
    peers({
      repo: createFilePeerRepo("/var/lib/myapp/peers"),
      visibility: sharedLabelVisibility,
      teammates: {
        coder: { title: "coder" },                                 // what a `coder` teammate is born as
        reviewer: ({ name }) => ({ title: `reviewer ${name}` }),   // or computed per spawn
      },
    }),
  ],
});
const lead = await harness.createSession();    // an ordinary session — born holding Team
```

`teammates` is the parameter boundary: the host decides what a `coder` teammate *is* — its session options (agent, model, permissions, title) — and the model only ever picks a type and a name. The extension tags each spawned session `params.peers = { member }` itself, so a teammate is born a member with `Hub`. Everything else is the agent's:

```
Team(op: "create", name: "db-migration")
Team(op: "spawn",  type: "coder", name: "dba",      prompt: "…")
Team(op: "spawn",  type: "coder", name: "reviewer", prompt: "…")
```

`dba` and `reviewer` are independent sessions. They start on their prompts immediately, message each other by name and the lead as `lead` over `Hub`, and report back by message — which wakes the lead in a later turn. The lead steers them with `Team send`, whose reach is **scope, not policy**: a creator reaches exactly the members wearing one of its own team labels, and nothing else.

The team label is `team:<creator>:<name>`. That creator segment is stamped by the network, never by the model, so two agents that both name a team `migration` get two different teams — and membership can never widen past what its creator spawned.

A teammate's name is unique **within its team**, not across the roster: its roster id is `<team label>/<name>`, so two teams can each have a `dba`. `Team send` and `Hub send` take the short name (`Team send` adds `team` when the creator has the same name in several teams; a member sees its creator as `lead`, which is reserved). Roster rows carry the `id` for exact addressing whenever it differs from the name.

The `create` half runs synchronously inside `createHarness`, so the service exists before the first session; `harness.close()` takes it down again (unregister → `close()`). The host reaches the network the same way sessions do — `harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE)` — for `list()`, `stats()`, `reconcile()`.

### Desktop: load it from a file

The host writes no peers code: it opens an `extensionDir` and loads. The bundle's default export is the same `peers(config)` — its state lives in the data dir the framework hands the extension (`host.dataDir`, outside the bundle), so it survives a reload and an update:

```
~/.myapp/extensions/peers/
  manifest.json     { "id": "peers", "version": "0.1.0", "engine": "0.1.0-alpha.0", "entry": "index.js", "name": "Peers", "description": "…" }
  index.js          ← esbuild bundle of the file below, operon-agents-peers baked in
```

```ts
// index.ts — the whole extension
import { createFilePeerRepo, createMemoryPeerRepo, peers, sharedLabelVisibility } from "operon-agents-peers";

export default peers({
  repo: ({ dataDir }) => (dataDir !== undefined ? createFilePeerRepo(dataDir) : createMemoryPeerRepo()),   // survives reload and update
  visibility: sharedLabelVisibility,
  teammates: { coder: { title: "coder" } },
});
```

```ts
const harness = createHarness({ model, extensionDir: "~/.myapp/extensions" });
await harness.extensions!.load("peers");       // loading IS the approval, recorded at the bundle's mtime
const lead = await harness.createSession();    // from here on, identical to the server form
// …the bundle changes on disk…
await harness.extensions!.reload("peers");     // barrier → swap the per-session half + replace the service → release
```

`reload` is one coordinated act: every session holding the peers half meets at its next run boundary, the half is swapped, the service is replaced (the old network's `close()` runs), and everyone resumes. No session is reopened and no conversation is interrupted; the repo in the extension's data dir carries the roster and mailbox across, so the same lead reaches the same teammate afterwards. Nothing watches the directory — a changed bundle loads only through an explicit `reload`, so an agent with write access cannot plant code that runs on next open. Two rules the bundle keeps: import the framework as types only (it belongs to the host — this package value-imports nothing from it, which is what keeps the bundle free of the core's native transitive deps), and keep state in the repo under `host.dataDir` (the instance is replaceable; a memory repo is wiped by reload). To ship it, `pnpm release` in `examples/peers-extension` produces the zip, its sha256 and an index entry for a download site.

## Pre-arranged teams

A host can stand up a team with no model-driven spawn at all — with `peers()` in `extensions`, hand each session its member identity as a param:

```ts
const alice = await harness.createSession({
  params: { peers: { member: { name: "alice", team: "team:host:alpha", type: "lead", description: "Coordinates the work" } } },
});
const bob = await harness.createSession({
  params: { peers: { member: { name: "bob", team: "team:host:alpha", type: "dba", description: "Postgres schema and query tuning" } } },
});
```

The param persists with the session, so a `resumeSession` brings `alice` back as a member without repeating it.

**State a `type` and `description`.** They are what makes the roster useful: without them every teammate lists as an anonymous `member` and a model has no way to tell who to ask. The `name` is what teammates address it by — unique within `team` (its roster id is `<team>/<name>`).

## What it rests on

| Seam | Used for |
|---|---|
| `api.onEvent` | root-frame lifecycle — who is awake, asleep, gone |
| `api.registerTool` | the `Team` tool (creators) and the `Hub` tool (members) |
| `actions.openSession` | reach another session, reopening it if it was closed |
| `handle.steerTo(address, …)` | hand a message to one specific frame |
| `create` half / `ctx.shared` | the extension's `create` publishes the network; `setup` reaches it through a method-only handle that outlives any one instance — what makes `reload` and `services.replace` land without touching a session |

## Design notes

**Off unless configured.** No extension, no tools. `visibility` is required — there is no permissive default, because directory visibility *is* the permission boundary for member messaging. (`Team send` needs no policy: its scope is its permission.)

**Identity by act, not by inference.** A member's roster row is written at spawn (or member session start); a creator's at `Team create`. The event stream only refreshes the *status* of rows those acts created — nothing is ever registered because it happened to start at the right time.

**Toolsets never change mid-conversation.** Which tools an agent holds is fixed at its birth (prompt-cache stability, and a model never faces a shifting tool surface). That is why capability follows birth rather than following any runtime state.

**A teammate and a delegation are different things.** A teammate is an independent session: its own store, permissions, and lifetime, addressable by name, wakeable by message. A delegation shares everything with its parent and reports through its tool result (or task notification). The two compose: a delegation holds the `Team` tool like any frame of its session, so delegated work can form a team of its own.

**`send` never blocks.** There is no `wait` op, deliberately: a teammate answers by being woken, background work already has `BackgroundOutput(block)`, and a blocking op would introduce the one thing this design otherwise has none of — a way for two agents to deadlock.

**Failures are explicit.** A `failed` receipt names its cause (`unknown_agent`, `ambiguous`, `not_visible`, `mailbox_full`, `quota_exceeded`, `unreachable`) so a model can tell "wrong name" from "you sent too much" and stop retrying what cannot succeed. A full mailbox rejects rather than dropping the oldest message.

## Permissions

`Team spawn`, `Team send` and `Hub send` wake agents and spend budget, so they are not auto-approved. Under `permission: { mode: "yolo" }` they just run; otherwise allow them explicitly.

## Storage

All peer state goes through one injectable seam — the host hands `createPeerNetwork` a `PeerRepo`, and the repo decides where things live:

```ts
import { createFilePeerRepo } from "operon-agents-peers";

peers({
  visibility: sharedLabelVisibility,
  repo: createFilePeerRepo("/var/lib/myapp/peers"),   // omit for the in-memory default; the bundle's own folder in the file form
});

// On startup, once at least one session holding a peers extension is open:
const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);
const { redelivered, dropped } = await net.reconcile();
```

The interface is **operation-level, never key/value** — `enqueue`, `settle`, `put`, `add` — and the contract every implementation must honor is: *each method is atomic in the backend; no caller ever does a cross-call read-modify-write.* That is what lets one repo be shared without conflicts. Three facets, each persisting exactly what only peers knows:

| Facet | Persists | Why |
|---|---|---|
| `mailbox` | messages in flight | the only facet protecting **correctness** — see *Durability* |
| `cards` | name → session id, team labels, `type`/`description` | invented at runtime, recorded nowhere else; without them a restart leaves parked teammates undiscoverable, hence unwakeable |
| `stats` | nothing (memory), by design | a persisted budget ledger forces reset semantics only the host can decide — implement this facet yourself for a fleet ledger spanning restarts |

`createFilePeerRepo(dir)` is the local-first durable option: two JSON files, atomic-rename writes, mutations serialized per process. It is **single-process**; multi-process deployments implement `PeerRepo` on a store with real cross-process atomicity (PG, Redis).

## Durability

`steerTo` only puts a message on an in-memory queue, so a crash before the recipient consumes it would lose it. The mailbox ledger closes that window:

1. Every send records the message **before** delivery — and enforces `mailboxCapacity` inside that same atomic step, so the cap is a hard limit rather than a check-then-act race. A teammate's *initial prompt* travels this path too: spawn hands it over as the first peer message.
2. The entry clears only when the recipient's `message.appended` shows it entered their conversation.
3. So whatever is still on the ledger after a restart is exactly what was lost — no journal comparison needed.

The card store closes the other restart window: cards seed sleeping teammates back onto the roster as `parked` — discoverable, addressable, wakeable — with the name → session mapping that exists nowhere else. `reconcile()` then redelivers what the crash stranded, dropping (and counting) anything whose recipient is genuinely unknown.

## Fleet accounting

`maxTurns` bounds one agent. It cannot stop ten agents each burning their own budget, and it cannot see that they kept waking each other to do it — a peer message can start a turn on an idle teammate, so cost accrues without anyone prompting.

```ts
peers({
  visibility: sharedLabelVisibility,
  budget: { maxWakes: 200, maxTotalTokens: 5_000_000 },
});

await harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE).stats();
// → { agents: [{ agentId, messagesSent, messagesReceived, wakes, totalTokens, cost }], totals }
```

Reaching the ceiling **pauses peer traffic** — sends and spawns start refusing with `quota_exceeded` and the reason spelled out. Agents already running finish their own work. `wakes` is the sharpest lever: each one is a fresh LLM call nobody explicitly asked for.

The design history — including what was deliberately left out and why — is summarized in the sections above.
