# operon-code-mode

Code Mode for [operon-agents](https://github.com/nickqiaoo/operon-agents): the model writes a
TypeScript program that calls its tools, and one `RunCode` call does what would otherwise take a
model round-trip per tool call.

It does two jobs, chosen by `hide`:

```ts
import { createHarness } from "operon-agents";
import { codeMode } from "operon-code-mode";

// Default (`hide: "catalog"`): a large MCP catalog stays out of the context of any model that
// cannot defer tools natively; programs reach it instead. Does nothing where nothing needs hiding.
createHarness({ model, extensions: [codeMode()] });

// Orchestration (`hide: "none"`): RunCode beside every tool, for work that takes many calls.
createHarness({ model, extensions: [codeMode({ hide: "none" })] });
```

For orchestration: instead of `Read a.ts` → `Read b.ts` → `Read c.ts` → `Grep …`, four round-trips each dragging its
result back into context, the model writes:

```ts
const files = ["a.ts", "b.ts", "c.ts"];
const texts = await Promise.all(files.map((path) => tools.Read({ path })));
const hits = files.filter((_, i) => texts[i].includes("TODO"));
return { hits };
```

and gets `{ hits: [...] }` back — one call, only the curated result in context.

## What the model sees

`RunCode` takes `{ code, description }`. Its description is the prompt: when to write a program
and when not to, how to write one, and — rendered per request from the tools the request actually
carries — a `declare const tools: { … }` block so the model programs against exactly what this
turn can call:

```ts
declare const tools: {
  /** Reads a file from the local filesystem. */
  Read(args: { path: string; line_offset?: number; n_lines?: number }): Promise<string>;
  /** Executes a bash command … */
  Bash(args: { command: string; timeout?: number; … }): Promise<string>;
  "mcp__github__list-issues"(args: { state: "open" | "closed" }): Promise<{ issues: { number: number; title: string }[] }>;
};
declare class ToolCallError extends Error { readonly toolName: string; }
declare const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>;
declare function searchTools(query: string | { query: string; limit?: number }): Promise<Array<{ name: string; description: string; declaration: string }>>;
```

A call resolves to the tool's text output — or, for a tool whose schema declares an
`outputSchema` (an MCP tool that declares one), to its structured result (`ToolResult.structured`,
the MCP `structuredContent`), typed from that schema as above. The model still reads the text;
only the program gets the object. A failed call throws a catchable `ToolCallError`; reading a
tool that does not exist throws at once, naming the close matches.

What the program `return`s comes back first, then its `console.log` lines under `Logs:`, all under
a byte cap. `searchTools` returns the tools that best match a query — the same keyword search
SearchTool uses — each with the `name` and `description` an `ALL_TOOLS` entry has plus its full
`declaration`, for a tool the description does not declare.

## Many tools, any model: `hide: "catalog"` (the default)

A model whose provider can add tools mid-conversation keeps a large MCP catalog behind SearchTool
(deferred loading). Every other model would get every tool up front, and a few MCP servers are
enough to fill its context. The default, `hide: "catalog"`, is the fallback for those:

- When the request carries SearchTool, the model defers natively: RunCode is withheld and nothing
  else changes.
- Otherwise the catalog tools (`catalogTools`, MCP tools by default) leave the request. RunCode's
  description declares as many of them as fit in `catalogBudget` estimated tokens — picked
  round-robin across MCP servers, cheapest first, so one big server cannot crowd out the rest —
  and says how many it left out. The model looks those up with `searchTools` in one program and
  calls them in the next; what the search returned stays in the transcript.
- Built-in tools stay directly callable; with no catalog tools in the request, RunCode is withheld.

## Where the program runs, and what it can reach

The program runs in [QuickJS](https://bellard.org/quickjs/) (the quickjs-ng fork) compiled to
WebAssembly, loaded into the agent process. That is a complete ES2023 engine — classes,
generators, `Promise.all`, the standard library — with none of Node on the other side: there is
no `require`, `process`, `fetch`, filesystem or timer to reach, because they do not exist there.
The only way out is `tools.*`.

Every `tools.X(args)` is a **nested tool call** the engine runs through its own pipeline
(`ToolRunContext.dispatch`): the prepare hook, plan resolution, authorization, execution, the
finalize hook. Permissions, user hooks and the `Environment` apply exactly as for a direct call. This
is what makes Code Mode safe to enable where Bash runs inside E2B or under os-sandbox: the program
never runs on the host's behalf, only the tools do, where they always did.

Limits are enforced by the engine — a heap cap and an interrupt handler for a hot loop — plus a
wall clock for a program merely waiting on tools, a cap on tool calls per program and on calls in
flight, and the output cap. Each run gets a fresh runtime, torn down afterwards: nothing survives
between programs.

## Pausing for an approval

With a live approver (a terminal, a chat window answering prompts), a nested call that needs an
approval simply waits for the answer, like a direct call — and is announced first: its
`tool.call.started` (carrying `parentToolCallId`) is published before the approver is asked, so a
client already has the call to hang the approval on. With none — a server, a session the user
comes back to tomorrow — the program **pauses**: RunCode records every nested call that already
ran in a journal (the extension's durable state), and suspends the run with the approval request.
The pending item is an input request whose `request.kind` is `"approval"`; its `display` carries the
nested call's tool, approval rule and position in the program (`RunCodeApprovalRequest`). Answer it
with an approval response:

```ts
await session.resume({ [pending.approvalId]: { kind: "input", data: { decision: "approved" } } });
```

The program then runs again from the top — possibly in another process — with calls found in the
journal answered from it (not re-executed), the call that asked dispatched with the user's answer
(a rejection reaches the program as a `ToolCallError`), and the rest running live. The result's
`details.replayed` counts the replayed calls. A program that branches on `Date.now()` or
`Math.random()` may stop matching its journal on the re-run; from that call on everything runs live
and the result says so (`details.divergedAt`).

One thing a program still cannot do is ask the user a question: a tool that suspends for input
(`AskUserQuestion`) fails inside a program with a message telling the model to call it directly.

## Long programs: the background

A program that polls, or makes many slow calls, need not hold the turn. `run_in_background: true`
returns a task id at once; a program already running can be moved with `session.detachTool(id)`
(the tool announces `tool.detachable`, the cue a UI uses to offer "move to background"). Either
way it becomes a `code` background task: its `console.log` lines, each nested call's outcome and
the final result go to a log file on the environment — where a background command's output goes. The
model `Read`s that file (the result names its path) and asks `BackgroundOutput` for the task's
status; a completion notice reaches it on its own. A host reads the same file through
`session.readBackgroundTaskOutput` / `readBackgroundTaskOutputDelta`. A program in the background
has no turn to pause, so an approval nobody can give fails inside it instead of pausing.

While attached, `console.log` lines stream as `tool.progress` (`update.kind: "stdout"`), and each
nested call's outcome as a `status` update.

## Measuring it

`pnpm --filter operon-code-mode evals` runs a small suite against a real model (credentials in the
environment): each task twice, with and without the extension, measuring model calls, tokens,
whether the model reached for `RunCode`, and whether the answer was right. `--update-baseline`
records the run; later runs fail on a regression. `evals:selftest` checks the plumbing offline.

## Options

```ts
codeMode({
  hide: "catalog",         // which tools only a program can reach:
                           // "catalog" (default): the catalog, unless the model defers natively (above)
                           // "none": nothing — RunCode beside every tool (orchestration)
                           // "all": everything but DEFAULT_DIRECT_TOOLS + directTools
  directTools: [],         // under "all" and "catalog", extra tools never hidden
  catalogTools: (schema) => schema.name.startsWith("mcp__"), // under "catalog", what the catalog holds
  catalogBudget: 2000,     // under "catalog", estimated tokens for the declared slice
  exclude: [],             // tools a program may never call (still callable directly)
  descriptions: "brief",   // detail in the declarations under "none"/"all"; "full" by default under "all"
  limits: {
    maxWallMs: 600_000,    // one program, tool calls included
    maxComputeMs: 30_000,  // the program's own JavaScript
    maxMemoryBytes: 64 * 1024 * 1024,
    maxOutputBytes: 32 * 1024,
    maxToolCalls: 200,
    maxParallel: 8,        // in flight at once; conflicting calls still serialize
  },
  runtime: createQuickJSRuntime(), // or anything implementing CodeRuntime
})
```

## Observing a program

Nested calls emit the ordinary `tool.call.started` / `tool.progress` / `tool.result` events with a
`parentToolCallId` naming the `RunCode` call, so a UI can nest them. They have no message of their
own and do not replay from history; the durable trace is the `RunCode` result's `details`:
`{ dispatches: [{ name, ok, ms }], toolCalls, truncated, error? }`.

## License

MIT
