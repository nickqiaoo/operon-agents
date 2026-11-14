# operon-agents-peers

Peer discovery and messaging between agents. **Nothing in this package lives in the engine** — it is built entirely on public seams.

The organizing rule: **capability follows birth, and identity is produced by explicit acts** — never inferred from event timing, never granted by being spawned at the right moment.

- An ordinary agent holds the **`Team` tool**: it can form a team, spawn teammates into it, and message exactly those members. It has no general peer messaging, and no roster identity until the moment it creates a team.
- A teammate is a **session** created on the host's terms (the `peers()` extension's `teammates` types), born with the member **`Hub` tool** (general peer messaging, gated by the visibility policy) and its roster identity — and **not** `Team`: a teammate is a member, not a team-former.
- A delegation (`Agent(...)`) never enters the peer world at all. Quick, self-contained work stays a function call; a teammate is for work that outlives one call and converses.

## One definition, two channels

peers is packaged as **one `ExtensionDefinition`, `peers(config)`** — an ordinary extension that happens to carry a `harness` half (its `PeerNetwork`: one roster, mailbox and budget for the whole process). A host takes it through whichever channel fits its deployment; nothing about the definition changes.

| | **Server — by value** | **Desktop — from a file** |
|---|---|---|
| Hand-over | `createHarness({ extensions: [peers(config)] })` | a bundle in `extensionDir` whose default export is `peers(config)`, then `harness.extensions.load("peers")` |
| Config | in code | in the bundle; state in the data dir the framework hands it (`host.dataDir`) |
| Shipping a change | new build, rolling restart | `harness.extensions.reload("peers")`; sessions stay open |
| Reference | `test/e2e-peers-extension.ts` (a) | `examples/peers-extension`, `test/e2e-peers-extension.ts` (b) |

Same code, same tests on both. The framework runs the `harness` half **once per process** and registers that network as its `peers` service; the extension's `session` runs **per session** and reaches the network only through a stable handle (`shared`). That handle is what lets the file form reload the network under live sessions — and on the server it is a plain registry lookup with nothing dynamic behind it (not replaceable, no loader, no barrier).

Which tool a session gets is decided by its **per-session param**, not by wiring: a spawned teammate carries `params.peers = { member }` and gets `Hub`; every other session gets `Team`. Capability follows birth, and a teammate never holds `Team` — it is a member.

### Server: pass it by value

```ts
import { createHarness } from "operon-agents";
import { createFilePeerRepo, peers, sharedLabelVisibility } from "operon-agents-peers";

const harness = createHarness({
  config: { defaults: { model } },
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

`teammates` is the parameter boundary: the host decides what a `coder` teammate *is* — `{ title?, workDir?, config? }`, where `config` is an ordinary `SessionConfig` (agent, model, permission, MCP servers) — and the model only ever picks a type and a name. The `Team` tool lists those types — and what each is for, when a type says — in its description and the spawn `type` parameter, so the model picks from them rather than guessing a type and learning the list from the error. The extension tags each spawned session `config.extensions.peers = { member }` itself, so a teammate is born a member with `Hub`. Everything else is the agent's:

```
Team(op: "create", name: "db-migration")
Team(op: "spawn",  type: "coder", name: "dba",      prompt: "…")
Team(op: "spawn",  type: "coder", name: "reviewer", prompt: "…")
```

`dba` and `reviewer` are independent sessions. They start on their prompts immediately, message each other by name and the lead as `lead` over `Hub`, and report back by message — which wakes the lead in a later turn. The lead steers them with `Team send`, whose reach is **scope, not policy**: a creator reaches exactly the members wearing one of its own team labels, and nothing else.

The team label is `team:<creator>:<name>`. That creator segment is stamped by the network, never by the model, so two agents that both name a team `migration` get two different teams — and membership can never widen past what its creator spawned.

A teammate's name is unique **within its team**, not across the roster: its roster id is `<team label>/<name>`, so two teams can each have a `dba`. `Team send` and `Hub send` take the short name (`Team send` adds `team` when the creator has the same name in several teams; a member sees its creator as `lead`, which is reserved). Roster rows carry the `id` for exact addressing whenever it differs from the name.

The `harness` half runs synchronously inside `createHarness`, so the service exists before the first session; `harness.close()` takes it down again (unregister → `close()`). The host reaches the network the same way sessions do — `harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE)` — for `list()`, `stats()`, `reconcile()`.

### Desktop: load it from a file

File bundles use the same built-in ExtensionHost capability as by-value extensions; no `uses`
service and no host callback is needed for waking a closed teammate:

```ts
const harness = createHarness({
  config: { defaults: { model } },
  extensionDir: "~/.myapp/extensions",
});
await harness.extensions!.load("peers");
const lead = await harness.createSession();
await harness.extensions!.reload("peers");
```

`reload` is one coordinated act: every session holding the peers half meets at its next run boundary, the half is swapped, the service is replaced (the old network's `close()` runs), and everyone resumes. No session is reopened and no conversation is interrupted; the repo in the extension's data dir carries the roster and mailbox across, so the same lead reaches the same teammate afterwards. Nothing watches the directory — a changed bundle loads only through an explicit `reload`, so an agent with write access cannot plant code that runs on next open. Two rules the bundle keeps: import the framework as types only (it belongs to the host — this package value-imports nothing from it, which is what keeps the bundle free of the core's native transitive deps), and keep state in the repo under `host.dataDir` (the instance is replaceable; a memory repo is wiped by reload). To ship it, `pnpm release` in `examples/peers-extension` produces the zip, its sha256 and an index entry for a download site.

### What a teammate is born as

`teammates` maps each type the model may `Team spawn` to the session options a teammate of that
type is born with: a constant, or a function of the spawn request. `peers` fills in the rest:

| | Default | Set it with |
|---|---|---|
| title | `` `${name} · ${typeTitle}` `` (`typeTitle` defaults to the type's key) | `title`, `typeTitle` |
| model | the lead's **current** model (a runtime `setModel` included) | `config.model` |
| prompt | the member protocol (report to `lead` with `Hub send` when done), then the type's `instructions`, appended after any `config.appendSystemPrompt` | `memberInstructions` (a string replaces the protocol, `false` drops it), `instructions` |
| roster description | none | `description` |

```ts
peers({
  visibility: sharedLabelVisibility,
  teammates: {
    coder: { typeTitle: "Coder", description: "Implements a scoped change", config: { permission: { mode: "workspace" } } },
    reviewer: { typeTitle: "Reviewer", instructions: "Do not modify files.", config: { model: "anthropic/claude-sonnet-5-5" } },
  },
});
```

The prompt goes in as `config.appendSystemPrompt`, so it is stored with the teammate and comes back
when it is woken. That setting shapes the default agent only. A host whose `resolveSession` binds a
complete agent for teammates sets `memberInstructions: false` and puts `DEFAULT_MEMBER_INSTRUCTIONS`
in that agent's own instructions.

The model is inherited through `host.createSession({ from, inherit: ["model"] })`. A lead running on
the harness default has no model to hand down, so its teammates run on the default too.

### Settings

A file bundle does not need its host to compute options. Its manifest declares
`PEERS_SETTINGS_SCHEMA` as its `settings`, and the bundle turns the value into options:

```ts
export default peers((host) => ({
  visibility: sharedLabelVisibility,
  repo: createFilePeerRepo(host.dataDir!),
  team: { type: "lead", description: "Coordinates the team from the user's conversation" },
  ...peersOptionsFromSettings(host.settings),
}));
```

The settings are a `budget` (`maxWakes`, `maxTotalTokens`, `maxTotalCost`) and a table of teammate
`types` (`title`, `description`, `model`, `permissionMode`, `instructions`). A type with no `model`
inherits its lead's. The framework stores and validates the value, and a host renders it with its
generic settings form (`harness.extensions.getSettings("peers")` / `setSettings`). A change
reloads the extension, so new types and budget apply with no host wiring. No teammate types are
built in: a product's packaging writes its own as the schema's `default`.

Options can still be a function of the host that reads a host service named in `uses`
(`peers(async (host) => …, { uses: ["my-host"] })`), but a bundle written that way loads only on a
host that registers the service.

### Finding teammates from the host

A host that keeps its own record of each teammate (a row in a conversation list, say) finds them in
`harness.onSessionOpened`, with `teammateOf(session)`:

```ts
harness.onSessionOpened(async (session, info) => {
  const member = teammateOf(session); // { agentId, name, team, type, creatorSessionId? } | undefined
  if (member !== undefined && info.operation === "create") await recordTeammate(session, member);
});
```

The listener runs before the teammate can run, so a subscription made there sees its whole first
turn. If it throws, the spawn is rolled back: the session is closed and its record removed, the
name is free again, and `Team spawn` reports the error to the lead. A fork of a teammate is an
ordinary session, so `teammateOf` returns `undefined` for it.

## Pre-arranged teams

A host can stand up a team with no model-driven spawn at all — with `peers()` in `extensions`, hand each session its member identity as a param:

```ts
const alice = await harness.createSession({
  config: { extensions: { peers: { member: { name: "alice", team: "team:host:alpha", type: "lead", description: "Coordinates the work" } } } },
});
const bob = await harness.createSession({
  config: { extensions: { peers: { member: { name: "bob", team: "team:host:alpha", type: "dba", description: "Postgres schema and query tuning" } } } },
});
```

The param is part of the session's stored setup, so a `resumeSession` brings `alice` back as a member without repeating it. It is a seat, not a setting: forking `alice` gives an ordinary session, and the roster keeps pointing at the original.

## Waking, spawning and the host

A message to a teammate whose session is closed brings it back through `harness.resumeSession(id)`:
restored from what is stored with it, plus whatever the host's `resolveSession` supplies (a sandbox,
credentials, context). There is no peers-specific callback to configure, and nothing peers selects
itself. If the host refuses the restore, the send reports `unreachable` and the message stays in
the mailbox for redelivery; the session is never opened on defaults instead.

A teammate is created **on behalf of its lead**: it takes the lead's working directory and owner
unless the `teammates` entry says otherwise, the host's `resolveSession` is told the lead is its
`source`, and where the lead runs in an environment of its own the teammate must be given one too —
otherwise the spawn is refused rather than run on the harness's machine. A `teammates` entry is
data: `{ title?, workDir?, ownerKey?, config? }`.

A standalone `createPeerNetwork` still requires its `resumeSession` function, which a custom
extension supplies as `(id) => host.resumeSession(id)`. Its `readSessionMessages` is optional —
pass `(id, options) => host.readSessionMessages(id, options)` to enable `getMemberHistory`.

## Reading a teammate's history

```ts
const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);
const page = await net.getMemberHistory(agentId, { limit: 50 });
// page.items: oldest first — { kind: "message", message, origin, cursor, … } | { kind: "compaction", … }
const older = page.next ? await net.getMemberHistory(agentId, { before: page.next }) : undefined;
```

By roster id, for any agent on the roster — a member, or the lead. A parked teammate **stays
parked**: the transcript is read where its session is stored, no session is resumed, no turn
starts and no wake is counted. It is `harness.readSessionMessages` underneath, so it reads what
happened (compacted messages included) in pages newest first. A peer delivery carries its
`external` origin, which tells it apart from what a user typed.

**State a `type` and `description`.** They are what makes the roster useful: without them every teammate lists as an anonymous `member` and a model has no way to tell who to ask. The `name` is what teammates address it by — unique within `team` (its roster id is `<team>/<name>`).

## What it rests on

| Seam | Used for |
|---|---|
| `api.onEvent` | root-frame lifecycle — who is awake, asleep, gone |
| `api.registerTool` | the `Team` tool (creators) and the `Hub` tool (members) |
| host `resumeSession(id)` | get a session, loading it if needed — the harness joins concurrent loads and asks the host's `resolveSession` for what cannot be stored |
| host `readSessionMessages(id)` | read a member's transcript without loading its session — what `getMemberHistory` rests on |
| `handle.steerTo(address, …)` | hand a message to one specific frame |
| `harness` half / `ctx.shared` | the extension's `harness` publishes one network per process; `session` reaches it through a method-only handle that outlives any one instance — what makes `reload` and `services.replace` land without touching a session |

## Design notes

**Off unless configured.** No extension, no tools. `visibility` is required — there is no permissive default, because directory visibility *is* the permission boundary for member messaging. (`Team send` needs no policy: its scope is its permission.)

**Identity by act, not by inference.** A member's roster row is written at spawn (or member session start); a creator's at `Team create`. The event stream only refreshes the *status* of rows those acts created — nothing is ever registered because it happened to start at the right time.

**Toolsets never change mid-conversation.** Which tools an agent holds is fixed at its birth (prompt-cache stability, and a model never faces a shifting tool surface). That is why capability follows birth rather than following any runtime state.

**A teammate and a delegation are different things.** A teammate is an independent session: its own store, permissions, and lifetime, addressable by name, wakeable by message. A delegation shares everything with its parent and reports through its tool result (or task notification). The two compose: a delegation holds the `Team` tool like any frame of its session, so delegated work can form a team of its own.

**`send` never blocks.** There is no `wait` op, deliberately: a teammate answers by being woken, background work reports its own completion, and a blocking op would introduce the one thing this design otherwise has none of — a way for two agents to deadlock.

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

// On startup, once the extension is registered (by value) or loaded (from a file):
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
