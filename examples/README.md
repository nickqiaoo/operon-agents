# Examples

Runnable examples for the framework, from the smallest possible local script up to a
Managed-Agents-style HTTP control plane. Every example imports from the published
**`operon-agents`** package (`import { … } from "operon-agents"`) — exactly what a real
consumer writes. In this monorepo the package is a `workspace:*` dependency, so build it
once and the examples resolve it:

```bash
pnpm install          # links the workspace
pnpm build            # builds operon-agents (+ the sandbox adapter)
```

All examples call a real model, so they need an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Override the model with `MODEL="provider/model"` (default `anthropic/claude-opus-4-8`).

| Example | What it shows | Shape |
| ------- | ------------- | ----- |
| [`local-quickstart`](./local-quickstart) | The smallest thing that works: one local session, stream events, print the result. | local script |
| [`steer-and-interrupt`](./steer-and-interrupt) | Live event rendering + **steer** a running turn + **cancel** + a human-in-the-loop **approval** handler. | local script |
| [`durable-interruption`](./durable-interruption) | Persist a manual-approval interruption, close the Harness, reopen the disk session, and **resume by `approvalId`**. | local script |
| [`goals-and-transcript`](./goals-and-transcript) | A **goal-driven** session with a turn budget, then reading the flat **conversation log** (`getRecords`) back. | local script |
| [`managed-agents`](./managed-agents) | The **Anthropic Managed Agents product** shape on this framework: control plane, SSE events, steer/interrupt, swappable **E2B sandbox** — plus a client that drives it. | HTTP server + client |
| [`app-server`](./app-server) | Drive the harness from **another process** over the NDJSON JSON-RPC **stdio protocol** — spawn a server, handshake, stream events, answer approvals. Both ends written out. | stdio server + client |
| [`extension-template`](./extension-template) | The canonical **file extension** (session-only): one `ExtensionDefinition`, esbuild-bundled to a single file a harness loads from `extensionDir`. Start here for a plugin. | loadable plugin |
| [`peers-extension`](./peers-extension) | The same, for an extension **with a `create` half** (process-shared state): `export default peers({…})` bundled and loaded — the shared-state counterpart to `extension-template`. | loadable plugin |

## The two seams every example turns on

1. **Deployment (local ⇄ server)** — there is no "mode" inside the engine. `createLocalHarness`
   (`packages/agents/src/local.ts`) bundles the local conventions; a server calls `createHarness`
   directly and injects its own backends (Pg/Redis store, sandbox machine, stdout log, no cron).
   There is deliberately no server preset — see `managed-agents` for the assembly.
2. **Machine** — where tools actually run. Local by default; flip to an E2B / Cloudflare
   sandbox by opening an `operon-sandbox` workspace and passing its machine as
   `machine` (see `managed-agents`). Sandbox lifecycle stays with the host;
   the agent, sessions, and events stay identical.

## Running

```bash
cd examples/<name>
pnpm start        # local scripts run to completion; servers listen on a port
```
