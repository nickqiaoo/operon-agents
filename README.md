# operon-agents

A host-agnostic execution kernel for building agents, wrapped in rings that can be swapped
independently: engine-level modules, a process-level runtime, user-space extensions, and deployment
hosts. Every choice about *where code runs, where state is stored, and which model is called* is
pushed out to an adapter, so the same agent loop serves a local interactive session and a managed
multi-tenant server without a single `if (mode === "server")` in between.

> **Status: alpha.** The API is not stable and breaking changes are expected.
> npm's `latest` tag points at the current alpha, so a plain `npm install operon-agents` resolves
> to one. Pin an exact version if that matters to you.

## What it does differently

**Interruptions survive the process.** When a tool call needs approval and no approver is present,
the run is persisted rather than held in memory. Kill the process, reopen the session tomorrow,
answer by `approvalId`, and execution continues from the recorded batch. The same applies to a tool
that calls `ctx.suspend()`. If one call in a batch awaits approval the whole batch is held, so the
paused frame is never half-executed.

**One permission chokepoint.** `PermissionManager` is a session-level singleton and `buildAuthorizer`
is the only authorization entry, with four modes: `manual`, `workspace`, `yolo`, and `auto` (an
LLM-driven approver). Auditing has exactly one landing point.

**A bad extension cannot take down a run.** Extensions are user-space programs: they may be absent,
they are time-limited (30s at decision points, 1s for observers), and a throw is logged and stepped
over. Capabilities — permissions, compaction — are the opposite: always present, unbounded, and a
failure fails the run. The dividing question is whether skipping the logic once costs you a feature
or causes an incident.

**Where tools run is a seam, not a setting.** `Machine` expresses intent (timeout, output cap,
streaming) and each backend honors it natively — local process, OS-level sandbox (macOS Seatbelt /
Linux bubblewrap), or a vendor sandbox (E2B, Cloudflare). `RunCommandResult.exitCode` may be
`undefined`, so callers must face "the backend could not confirm" instead of reading a fabricated
zero.

**Four storage backends, one contract.** memory, disk (JSONL), Postgres and Redis implement the same
`SessionStore`. History is folded one way through a shared function, so the live path and the replay
path cannot drift apart.

## Install

Requires Node 22+.

```bash
npm install operon-agents
```

The other packages are optional and installed only if you need them: `operon-sandbox` (E2B or
Cloudflare sandboxes), `operon-os-sandbox` (OS-level sandboxing of local commands),
`operon-managed-agents` (server and client), `operon-agents-peers` (agent-to-agent messaging).
`operon-agents-core` comes in as a dependency — depend on it directly only when you are assembling
a host yourself.

The Grep and Glob tools shell out to [ripgrep](https://github.com/BurntSushi/ripgrep); install it
(`brew install ripgrep`, `apt install ripgrep`) if you want those tools to work.

To work on the framework itself, clone and build (pnpm 10+):

```bash
git clone https://github.com/nickqiaoo/operon-agents.git
cd operon-agents
pnpm install
pnpm build
```

## Quickstart

```ts
import { createLocalSession, defineModel, type AgentEvent } from "operon-agents";

const session = await createLocalSession({
  model: defineModel({ provider: "anthropic", model: "claude-opus-4-8" }),
  homeDir: ".agent-home",   // sessions persist here — resumable
  workDir: "workspace",     // the agent's scope on disk
  permission: { mode: "workspace" },  // auto-approve tools that stay inside workDir
});

session.onEvent((ev: AgentEvent) => {
  if (ev.type === "assistant.delta") process.stdout.write(ev.delta);
});

const result = await session.prompt("create greeting.txt with a haiku, then read it back");
console.log(`\n${result.status} · ${result.usage.output} output tokens`);
await session.close();
```

`createLocalSession` is the local composition root: disk-persisted sessions, the local machine, and
cron, all wired for you. A server calls `createHarness` directly and injects its own backends —
there is deliberately no server preset, because one would force every session to share a single
credential store with no tenant dimension.

Set `ANTHROPIC_API_KEY` (or the key for whichever provider you configure) before running. Supported
provider types: `anthropic`, `openai`, `openai_responses`, `google-genai`, `vertexai`, `kimi`.

## Examples

Each example is runnable and imports from `operon-agents` exactly as a real consumer would.

| Example | What it shows |
| --- | --- |
| [`local-quickstart`](./examples/local-quickstart) | The smallest thing that works: one session, streamed events, a printed result. |
| [`steer-and-interrupt`](./examples/steer-and-interrupt) | Steer a running turn, cancel it, and answer a human-in-the-loop approval. |
| [`durable-interruption`](./examples/durable-interruption) | Persist an approval, close the harness, reopen the session, resume by `approvalId`. |
| [`goals-and-transcript`](./examples/goals-and-transcript) | A goal-driven session with a turn budget, then reading the conversation log back. |
| [`managed-agents`](./examples/managed-agents) | A managed control plane: HTTP + SSE, steer/interrupt, a swappable E2B sandbox, plus a client. |
| [`app-server`](./examples/app-server) | Drive the harness from another process over NDJSON JSON-RPC on stdio — both ends written out. |
| [`extension-template`](./examples/extension-template) | The canonical file extension, esbuild-bundled to one file a harness loads at runtime. |
| [`peers-extension`](./examples/peers-extension) | An extension with a `create` half — process-shared state across sessions. |

```bash
cd examples/local-quickstart
ANTHROPIC_API_KEY=sk-ant-... pnpm start
```

## Packages

| Package | Role |
| --- | --- |
| `operon-agents` | The public SDK entrypoint. Start here. |
| `operon-agents-core` | The kernel: turn/step/tool-call loop, interruption and resume, permissions, event and store contracts. |
| `operon-managed-agents` | Managed server and TypeScript client — a stateless API surface plus workers that claim sessions from a Postgres work table. |
| `operon-agents-peers` | Peer discovery and messaging between agents, built entirely on the engine's public seams. |
| `operon-sandbox` | Host-side sandbox lifecycle (E2B, Cloudflare), handing the framework a vendor-driven `Machine`. |
| `operon-os-sandbox` | OS-level command sandboxing for the local machine, degrading to a plain local machine where unsupported. |

## Architecture

Six rings, with dependencies pointing inward only — the kernel never imports an outer ring and does
not know its names:

```
⑥ adapters      Machine impls · store backends · model vendors
⑤ hosts         local: app-server · TUI    server: managed-agents
④ extensions    tools · injection · commands · shared resources
③ harness       session fleet · service registry · loader · barrier
② capabilities  compaction · permissions · background · skills · mcp
① kernel        Runner · Session · Engine · runTurn · executeStep · runCalls
```

The kernel defines three ports and knows only the interfaces: `Machine` (where commands run),
`SessionStore` (what is remembered), and `ChatModel` (which model answers).

[`docs/architecture.md`](./docs/architecture.md) is the full map — the execution path, the composition
rules, a walkthrough of one prompt through all six rings, and a table of which layer a given
requirement belongs to.

## Development

```bash
pnpm build        # build every package
pnpm build:clean  # wipe dist and .tsbuildinfo first — use this before publishing
pnpm typecheck    # build, then typecheck all packages in parallel
pnpm test         # per-package test suites
pnpm evals        # evaluation harness (compaction fidelity, auto-approver accuracy)
```

The Grep and Glob tools shell out to ripgrep, so `pnpm test` needs `rg` on PATH.

### Releasing

```bash
pnpm version:set 0.1.0-alpha.1   # moves all six publishable packages at once
```

Internal dependencies are `workspace:*` and resolve to real versions at pack time, so only the
`version` fields move. Commit the bump, push it, then run the **Publish** workflow from the Actions
tab and pick a dist-tag. Publishing authenticates through npm trusted publishing (OIDC) — there is
no token stored in the repository — and refuses to run unless a clean build, the typecheck and the
full test suite pass first.

## License

MIT — see [LICENSE](./LICENSE). Portions were adapted from kimi-code, also MIT; its copyright and
permission notice are reproduced there.
