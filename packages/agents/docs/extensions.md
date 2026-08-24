# Extensions

An extension is a programmatic participant in the agent loop. It observes lifecycle nodes,
intervenes at decision points, and acts on the session.

```ts
import { createHarness, type ExtensionDefinition } from "operon-agents";

const logging: ExtensionDefinition = {
  id: "my-extension",
  setup(api) {
    api.on("tool.call", ({ toolName, args }) => {
      if (toolName === "Bash" && String((args as { command?: string }).command).includes("rm -rf")) {
        return { block: true, reason: "refused by policy", terminate: true };
      }
      return undefined;
    });
  },
};

const harness = createHarness({ model, extensions: [logging] });
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

`ctx.actions` (also available as `api.actions` during `setup`) is the imperative surface.

### Conversation

| | |
|---|---|
| `steer(content)` | queue into the **current** turn — answered within the turn in flight |
| `followUp(content)` | queue for **after** the current turn settles; forces one more turn |
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
| `newSession({ title? })` | open a new session on the same harness |
| `fork({ title? })` | fork *this* session (log + state copied) and open it |
| `openSession(id)` | reopen an existing session |
| `listSessions()` | |
| `registerProvider(p)` / `unregisterProvider(id)` | model provider registry |
| `isIdle()` / `waitForIdle()` | |

These need the harness host. Used standalone (a bare `Runner` with `extensionsCapability`), they
warn and their promises reject rather than pretending to succeed — the return values are session
handles a caller would go on to use, so a silent no-op would only move the failure somewhere
harder to find.

`registerProvider` is **harness-global**: one model runtime serves every session, so a
registration is visible to all of them. It requires `createHarness({ modelRuntime })`.

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

`setup(api)` runs once when the session opens. Return a teardown function (or a promise of one)
to release long-lived resources:

```ts
const ext: ExtensionDefinition = {
  id: "with-cleanup",
  setup(api) {
    const timer = setInterval(poll, 60_000);
    return () => clearInterval(timer);
  },
};
```

A `setup` that throws is isolated: that extension is skipped with a `warning`, everything else
loads. On teardown, handlers, tools, and injectors registered during `setup` are disposed
automatically.

Extensions are registered once, on the harness; a session varies them with `params`:

```ts
createHarness({ model, extensions: [a, b] });                 // every session, from now on
harness.createSession({ params: { a: { level: 2 }, b: false } }); // a configured, b skipped — this session
```

`params` reaches `setup` as `ctx.params` (`setup(api, ctx)`) and persists with the session. A
definition with a `create` half has it run once here, its result registered as a service under
its `id` and handed to every `setup` as `ctx.shared`; another extension consumes that service by
naming it in `uses` and receiving it as `ctx.services[name]`.
