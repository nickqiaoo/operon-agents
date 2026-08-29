# operon-code-mode

Code Mode for [operon-agents](https://github.com/nickqiaoo/operon-agents): the model writes a
TypeScript program that calls its tools, and one `RunCode` call does what would otherwise take a
model round-trip per tool call.

```ts
import { createHarness } from "operon-agents";
import { codeMode } from "operon-code-mode";

const harness = createHarness({
  model,
  extensions: [codeMode()],
});
```

Instead of `Read a.ts` → `Read b.ts` → `Read c.ts` → `Grep …`, four round-trips each dragging its
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
  "mcp__github__list-issues"(args: { state: "open" | "closed" }): Promise<string>;
};
declare class ToolCallError extends Error { readonly toolName: string; }
declare const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>;
```

A call resolves to the tool's text output; a failed call throws a catchable `ToolCallError`.
Only what the program `console.log`s or `return`s comes back, under a byte cap.

## Where the program runs, and what it can reach

The program runs in [QuickJS](https://bellard.org/quickjs/) (the quickjs-ng fork) compiled to
WebAssembly, loaded into the agent process. That is a complete ES2023 engine — classes,
generators, `Promise.all`, the standard library — with none of Node on the other side: there is
no `require`, `process`, `fetch`, filesystem or timer to reach, because they do not exist there.
The only way out is `tools.*`.

Every `tools.X(args)` is a **nested tool call** the engine runs through its own pipeline
(`ToolRunContext.dispatch`): the prepare hook, plan resolution, authorization, execution, the
finalize hook. Permissions, user hooks and the `Machine` apply exactly as for a direct call. This
is what makes Code Mode safe to enable where Bash runs inside E2B or under os-sandbox: the program
never runs on the host's behalf, only the tools do, where they always did.

Limits are enforced by the engine — a heap cap and an interrupt handler for a hot loop — plus a
wall clock for a program merely waiting on tools, a cap on tool calls per program and on calls in
flight, and the output cap. Each run gets a fresh runtime, torn down afterwards: nothing survives
between programs.

Two things a program cannot do, by design: pause the run, and answer the user. A nested call that
needs an approval when no live approver is present, or a tool that suspends for input
(`AskUserQuestion`), fails inside the program with a message telling the model to call that tool
directly — the turn goes on rather than parking a half-run program.

## Options

```ts
codeMode({
  mode: "both",            // "both" (default): RunCode beside the direct tools
                           // "only": direct surface = DEFAULT_DIRECT_TOOLS + directTools; the rest only via a program
  directTools: [],         // under "only", extra tools kept directly callable
  exclude: [],             // tools a program may never call (still callable directly)
  descriptions: "brief",   // detail in the declarations; "full" by default under "only"
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
