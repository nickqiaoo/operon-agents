# Extensions

An extension is a programmatic participant in the agent loop. It observes lifecycle nodes,
intervenes at decision points, and acts on the session.

```ts
import { createHarness, type ExtensionDefinition } from "operon-agents";

const logging: ExtensionDefinition = {
  id: "my-extension",
  session(api) {
    api.on("tool.call", ({ toolName, args }) => {
      if (toolName === "Bash" && String((args as { command?: string }).command).includes("rm -rf")) {
        return { block: true, reason: "refused by policy", terminate: true };
      }
      return undefined;
    });
  },
};

const harness = createHarness({ config: { defaults: { model } }, extensions: [logging] });
```

Extensions live in `operon-agents`, not `operon-agents-core`. They need reach that only the
harness layer has — other sessions, the model provider registry — so core deliberately knows
nothing about them. Core supplies what they are built out of: `Capability`, `LoopHooks`,
`ToolFilter`, `Injector`, `SessionControls`, `CapabilityGates`.

## What belongs here, and what does not

**Extensions are for control.** If all you want is to watch the event stream — logging, metrics,
tracing — subscribe to the session's event sink instead. It is public, cheaper, and skips this
runtime's registry, timeouts, and per-extension state entirely:

```ts
session.onEvent((event) => { /* every AgentEvent */ });
```

The event table below only contains:

- **decision points** — the loop stops and waits for an answer (change this request? block this
  tool? run another turn?). These carry a result type.
- **lifecycle nodes** — moments an extension needs in order to *act* via `ctx.actions`. These
  return `void`.

It deliberately does **not** contain data flow (token deltas, tool progress, every appended
message). An extension can do nothing useful at those points, and routing them through here
would just add latency.

## Terminology

The loop has three nested levels, and they do not line up with pi's names:

| Level | What it is |
|---|---|
| **run** | one `prompt()` call, start to finish |
| **turn** | one pass of the turn loop; a run has one or more |
| **step** | one model call plus its tool batch; a turn has one or more |

pi's `turn_start`/`turn_end` correspond to our **step** events. Our `turn` layer has no pi
equivalent.

## Events

`T` = transform (return a value to replace the input) · `D` = decide (return a value to change
control flow) · `O` = observe (returns `void`)

### Lifecycle

| Event | | Payload → Result |
|---|---|---|
| `session.start` | O | `{ reason: "open" \| "resume" \| "fork" }` |
| `session.end` | O | `{ reason: "close" \| "shutdown" }` |

### Run

| Event | | Payload → Result |
|---|---|---|
| `run.start` | T | `{ agent, input }` → `{ input? }` or `{ handled: { output? } }` |
| `run.settled` | D | `{ stopReason, usage }` → `{ continue? }` |

`run.start` fires once per run, before guardrails and before anything is journaled — a rewritten
`input` is what the run and its replay both see. Returning `handled` answers the prompt without
running the agent at all: no turn, no model call, nothing written. The run settles as
`status: "skipped"` carrying your `output`. First hook to claim it wins.

### Step

| Event | | Payload → Result |
|---|---|---|
| `step.start` | D | `{ stepNumber, context, system }` → `{ block?, system? }` |
| `step.end` | D | `{ stepNumber, usage, stopReason }` → `{ stopTurn? }` |

`system` replaces the system prompt **for that step only**; the next step re-resolves from the
agent, so rewrites do not accumulate.

### Model

| Event | | Payload → Result |
|---|---|---|
| `model.request` | T | `{ request, context }` → `{ request?, block? }` |
| `model.response` | T | `{ request, response, context }` → `AssistantMessage` |

`model.request` is where semantic edits belong — system, messages, tools, params — and they are
typed. `model.response` runs before the message enters history, so a rewrite here is what gets
journaled.

### Tools

| Event | | Payload → Result |
|---|---|---|
| `tool.call` | T | `{ toolName, args }` → `{ updatedArgs?, block?, reason?, syntheticResult?, terminate? }` |
| `tool.authorize` | D | `+ { plan }` → `{ block?, reason?, syntheticResult?, interrupt? }` |
| `tool.result` | T | `{ result }` → `ToolResult` |

`tool.call` fires before argument validation, so `updatedArgs` is checked against the schema.
`tool.authorize` fires after the call resolves to a plan, alongside permission evaluation —
returning `interrupt` suspends the batch for a human decision instead of deciding yourself.
`terminate` (with `block`) ends the turn rather than feeding the denial back to the model.

### Compaction

| Event | | Payload → Result |
|---|---|---|
| `compaction.before` | D | `{ reason, messages, compactCount }` → `{ cancel?, replacement? }` |

Unlike everything else, this one is not engine-driven: compaction decides on its own that the
context is too big, then asks. First `cancel` wins; first `replacement` wins.

`replacement: { summary, count? }` supplies the summary yourself instead of letting compaction
call the model — a rule-based digest, a cheaper model. **This lands in durable history and shapes
every later turn.** A summary that drops load-bearing context does not fail loudly; the agent
just quietly forgets. `count` defaults to `compactCount` and is clamped to history length.

### Provider (HTTP)

| Event | | Payload → Result |
|---|---|---|
| `provider.headers` | T | `{ headers }` → `{ headers? }` |
| `provider.payload` | T | `{ payload }` → `{ payload? }` |
| `provider.response` | O | `{ status, headers }` |

These fire *below* the loop: the runtime folds them into the request's `providerOptions` and
pi-ai calls back from inside its HTTP path. Two consequences the loop-level events do not have:

1. **They repeat on retry.** A retryable failure re-sends, and each attempt re-runs these
   callbacks. A payload rewrite must be idempotent.
2. **`payload` is the wire body, typed `unknown`.** Its shape follows the provider/api and can
   change under you. That is the division of labour with `model.request`: semantic edits there
   (typed), wire-level edits here (not).

`provider.response` runs after the response arrives but *before* its body is consumed, so a slow
handler is latency on every streamed token. It gets the observer timeout (1s), not the decision
budget (30s).

## Ordering and conflicts

Within one event, handlers run in registration order.

- **transform** — chains: each handler sees the previous one's output. Return `undefined` for
  "no change".
- **decide** — short-circuits: the first `block` / `cancel` / `handled` wins, and the rest are
  not consulted.
- **observe** — all run, with per-handler fault isolation.

A handler that throws or times out emits a `warning` event and is skipped. It never takes down
another extension, and it never takes down the run.

Timeouts: decision points get 30s, observers 1s. Override per extension with `timeoutMs`.

## Actions

`ctx.actions` (also available as `api.actions` during `session`) is the imperative surface.

### Conversation

| | |
|---|---|
| `steer(content)` | queue into the **current** turn — answered within the turn in flight |
| `followUp(content)` | send for **after** the current turn settles, as a run of its own; runs right away on an idle session |
| `record(name, data?)` | append a custom journal record; not model-visible, replays with the session |

### Run control

| | |
|---|---|
| `abort(reason?)` | stop the run this handler is in; it settles as `"aborted"`, session stays usable |
| `compact({ instruction? })` | request a compaction pass |
| `getContextUsage()` | token breakdown of the last assembled request |
| `hasActiveRun` | whether a run is in flight |

From a session-tier event (`session.start` / `session.end`) there is no run to scope to, so
`abort()` aborts the session instead.

### Model and tools

| | |
|---|---|
| `setModel(model)` / `setThinkingLevel(level)` | |
| `getAllTools()` | every name in the last assembled registry |
| `getActiveTools()` | names currently allowed through |
| `setActiveTools(names \| null)` | restrict the toolset; `null` lifts it |

`setActiveTools` takes effect at the **next** turn's assembly, not mid-turn — the running turn
already fixed its registry.

### Sessions and providers

| | |
|---|---|
| `createSession({ title?, config? })` | open a new session on the same harness. It takes this session's working directory and owner; `config` is its setup as data (`SessionConfig`). An extension has no sandbox or credential to hand over: the host's `resolveSession` supplies live objects, and if this session runs in an environment of its own and none is supplied for the new one, the create is refused |
| `forkSession({ title?, config? })` | fork *this* session (history and stored setup copied, live objects provided anew) and open it. `config` adjusts the copied setup field by field. An extension that declares `forkParams: "drop"` does not have its parameters copied |
| `resumeSession(id)` | `harness.resumeSession(id)`: a loaded session is returned as it is, a load in flight is joined, a closed one is restored from what is stored with it and what the host's `resolveSession` supplies |
| `listSessions()` | |
| `registerProvider(p)` / `unregisterProvider(id)` | model provider registry |
| `isIdle()` / `waitForIdle()` | |

These need the harness host. Used standalone (a bare `Runner` with `extensionsCapability`), they
warn and their promises reject rather than pretending to succeed — the return values are session
handles a caller would go on to use, so a silent no-op would only move the failure somewhere
harder to find.

`registerProvider` is **harness-global**: one model runtime serves every session, so a
registration is visible to all of them.

## Registration

```ts
api.registerTool(tool);        // → () => void
api.registerInjector(injector); // → () => void
```

**Tools** that collide with a name the agent already owns fail closed: the agent's tool wins and
a `warning` names your extension.

**Injectors** are the right way to add turn-boundary context (system reminders and the like).
Prefer them over hand-rolling injection in a handler: `InjectionManager` repairs the injector's
watermark across compaction and message removal, which a handler cannot do for itself.

```ts
class MyInjector extends BoundaryInjector {
  readonly id = "my_injector";
  protected getInjection(ctx) {
    if (this.restoreInjectedAt(ctx)) return null;  // already injected in this context
    return { text: "…", variant: "my_variant" };
  }
}
```

## State

`ctx.state` is per-extension key/value storage, namespaced into the session store (memory when
the session has none), so it survives resume:

```ts
api.on("session.start", async ({ state }) => {
  const seen = await state.get<number>("runs");
  await state.set("runs", (seen ?? 0) + 1);
});
```

## Lifecycle

`session(api)` runs once when the session opens. Return a teardown function (or a promise of one)
to release long-lived resources:

```ts
const ext: ExtensionDefinition = {
  id: "with-cleanup",
  session(api) {
    const timer = setInterval(poll, 60_000);
    return () => clearInterval(timer);
  },
};
```

A `session` that throws is isolated: that extension is skipped with a `warning`, everything else
loads. On teardown, handlers, tools, and injectors registered during `session` are disposed
automatically.

Extensions are registered once, on the harness; a session varies them with `config.extensions`:

```ts
createHarness({ config: { defaults: { model } }, extensions: [a, b] });        // every session, from now on
harness.createSession({ config: { extensions: { a: { level: 2 }, b: false } } }); // a configured, b skipped — this session
```

An extension's entry reaches `session` as `ctx.params` (`session(api, ctx)`) and is stored with the
session's setup, so a later `resumeSession(id)` brings it back. A fork copies it too, unless the
definition says its parameters identify one session (`forkParams: "drop"`) — a seat, a membership.

The two halves are named for the tier they run at:

| Half | Runs | Its result |
|---|---|---|
| `harness(host)` | once per process | the service under `id`, in the harness scope |
| `session(api, ctx)` | once per session | teardown |

There is no tier in between: a shared object is shared by the WHOLE process or built per session.
When a definition has a `harness` half, every `session` under it gets a handle to the instance as
`ctx.shared`, and another extension consumes it by naming it in `uses` and receiving it as
`ctx.services[name]`. The host reaches the same instance with `harness.services.handle(id)`.

The harness half reaches sessions too, for both by-value and file-loaded extensions: `host.resumeSession(id)` is `harness.resumeSession(id)`, `host.readSessionMessages(id, options?)` is `harness.readSessionMessages(id, options?)` — a page of a session's transcript, read without loading it — and `host.createSession(options)` takes `harness.createSession`'s own options (`title`, `workDir`, `ownerKey`, `config`; an unknown key is an error) plus `from` — the id of the session the new one is created on behalf of, which lends it its directory, owner and execution boundary the way a session-side `createSession` does — and `inherit`, the settings to copy from that session as it is right now, for each one `config` does not set itself. `inherit: ["model"]` gives the new session the model its source currently runs on (a runtime `setModel` included; read from storage when the source is not loaded); a source on the harness default, or on a model given as a live object, has none to copy. `inherit` needs `from`. Every session an extension opens goes through the host's `resolveSession` and `onSessionOpened`, so it is resolved and wired like any other. No named service and no host callback is needed for any of it.

## Settings

A file extension can declare settings in its `manifest.json`. The framework stores and validates
them, the extension reads them, and a host renders them with one generic form built from the
schema. It needs no settings page per extension.

```jsonc
{
  "id": "greeter",
  "entry": "index.js",
  "settings": {
    "type": "object",
    "properties": {
      "greeting": { "type": "string", "title": "Greeting", "default": "hello", "maxLength": 40 },
      "model":    { "type": "string", "format": "model", "title": "Model" },
      "rooms": {
        "type": "object",
        "title": "Rooms",
        "propertyNames": { "pattern": "^[a-z]+$" },
        "additionalProperties": {
          "type": "object",
          "required": ["title"],
          "properties": { "title": { "type": "string" }, "notes": { "type": "string", "x-multiline": true } }
        }
      }
    }
  }
}
```

The schema is in the manifest, not the code, because the manifest is read before any code is
imported. That way a host can show and edit settings before the user has approved the extension to
run. The schema is a subset of JSON Schema. A keyword outside the subset makes the manifest
unusable (the folder lists as `error`); it is never silently ignored:

| Keyword | |
|---|---|
| `type` | `object`, `array`, `string`, `integer`, `number`, `boolean`. Required on every schema; the root is an `object` |
| `properties`, `required` | an object with fixed fields |
| `additionalProperties` (a schema) + `propertyNames.pattern` | an object whose keys the user adds and removes: a table |
| `items` | the elements of an array |
| `enum`, `default` | allowed values, and the value when unset (checked against the schema itself) |
| `title`, `description` | labels for the form |
| `minimum`, `maximum`, `maxLength`, `pattern` | constraints |
| `format` | a string whose options the host provides: `model` (a `provider/model` id, rendered as the host's model picker, checked only to be a string) or `permission-mode` (a `PermissionMode`, checked against it) |
| `x-multiline`, `x-order` | rendering hints |

`x-secret` is reserved and not supported yet.

**Reading.** The extension gets its settings as `host.settings` in its `harness` half and as
`ctx.settings` in its `session` half. Both are frozen, and both are `undefined` when the manifest
declares no settings. A stored value is resolved against the schema leniently: a missing field
takes its default (an object without one is built from its fields' defaults), an unknown key is
dropped, and an invalid field falls back to its default and is reported. A stored table replaces
its `default` table rather than merging with it, so an entry the user removed stays removed. An
extension whose stored settings no longer fit (its update changed the schema) still loads.

**Writing.** The host reads and writes through `harness.extensions`:

```ts
const view = await harness.extensions!.getSettings("greeter"); // { schema, value, issues } | undefined
await harness.extensions!.setSettings("greeter", { greeting: "hi", rooms: { lab: { title: "Lab" } } });
(await harness.extensions!.list())[0].settings;                // the same view, for every folder that declares settings
```

`setSettings` is strict. An invalid value throws `ExtensionSettingsInvalidError`, whose `issues`
carry each problem at its dotted path (`rooms.lab.title`), and nothing is stored. A valid value is
stored as given, without the defaults filled in, so a default an update changes still reaches a
field the user never set. If the extension is loaded, it is then reloaded the coordinated way: its
sessions meet at their run boundary and none is interrupted. Its `harness` half runs again with the
new value, and its `session` half is re-attached with it. Writes to one extension run one at a time.
Neither call needs the extension to be loaded or approved, because only the manifest is read.

**Storage.** By default each extension's value is one JSON file, `<extensionDir>/.settings/<id>.json`,
written to a temporary file and renamed into place. It is kept apart from the extension's own
`dataDir` (`<extensionDir>/.data/<id>`), so an extension cannot rewrite its settings past
validation, and an update of its bundle leaves them alone. A host keeps them elsewhere with
`createHarness({ extensionSettings })`, an `ExtensionSettingsStore` (`get(id)`, `put(id, value)`).

An extension passed by value has no manifest, so it has no settings: its host gives it options in
code.
