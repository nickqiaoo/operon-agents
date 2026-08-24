# operon-sandbox

Host-side sandbox lifecycle for [operon-agents](https://github.com/nickqiaoo/operon-agents): create,
snapshot, pause and destroy a vendor sandbox, and hand the framework a `Machine` driven by the
vendor SDK directly — native per-command timeouts, incremental output, and a real kill.

Supported vendors: **E2B** and **Cloudflare**.

```ts
import { Sandbox } from "e2b";
import { createHarness } from "operon-agents";
import { E2BWorkspace } from "operon-sandbox";

// The host owns the sandbox lifecycle; the framework only ever sees a Machine.
const workspace = await E2BWorkspace.open({ sandbox: Sandbox, template: "node20" });

const harness = createHarness({
  model,
  machine: workspace.machine,   // tools now run inside the sandbox
});

// … run sessions …

await harness.close();
await workspace.snapshot();     // snapshot / pause / kill stays with you
await workspace.kill();
```

Reconnect to an existing sandbox later by passing the saved state back in:

```ts
const state = workspace.state();                          // { sandboxId }
const again = await E2BWorkspace.open({ sandbox: Sandbox }, state);
```

Vendor SDKs are optional peer dependencies — install `e2b` or `@cloudflare/sandbox` for the ones you
actually use.

Nothing else about the agent changes: sessions, events, permissions and tools are identical to a
local run. That is the point of the `Machine` seam — where a command executes is an adapter choice,
not a mode the engine knows about.

The lifecycle deliberately stays with the host rather than the framework, because only the host
knows whether a sandbox should be snapshotted for later, paused to stop billing, or destroyed.

See [`examples/managed-agents`](https://github.com/nickqiaoo/operon-agents/tree/main/examples/managed-agents)
for a full server that swaps a sandbox in behind an HTTP control plane.

## License

MIT
