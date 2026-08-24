# Extension Template

A starting point for a distributable Operon extension: copy this directory, change the id in
`manifest.json` and the code in `src/index.ts`, then `pnpm build` to produce the artifact.

## The artifact

After `pnpm build`, `dist/` is the complete artifact:

```
dist/
  manifest.json   # id / version / engine / entry / name / description — identity, compatibility gate, presentation.
                  # What an extension provides (create) and consumes (uses) is declared on the definition, not here.
  index.js        # A single esbuild bundle with third-party dependencies rolled in.
```

Users drop the whole folder into the host's extension directory — **there is no install step**. To
publish it somewhere, `pnpm release` writes `<id>-<version>.zip`, a `.sha256`, and an index JSON into
`release/` (the script lives at `../scripts/pack-extension.mjs`; it has no dependencies, so copy it
along with this directory or point at it). Set `engine` to the framework version you built against —
an older host then refuses the extension *before* importing it rather than blowing up afterwards.
Dependencies carrying native binaries (sqlite and friends) cannot be bundled; those extensions fall
back to shipping a directory that the user installs themselves.

## Loading and trust (host side)

```ts
import { createHarness } from "operon-agents";

const harness = createHarness({ extensionDir: "~/.myapp/plugins", /* ... */ });

// First load and post-edit reload are both explicit actions, and the action itself is the approval
// (tracked by mtime):
await harness.extensions.load("example-plugin");     // sessions opened afterwards pick it up automatically
await harness.extensions.reload("example-plugin");   // after a code change: sessions holding it rendezvous at a
                                                     // run boundary, swap in the new version, then continue
await harness.extensions.list();                     // per-extension status: new / approved / loaded / changed / error
```

Nothing loads automatically at startup. Entries reported as `approved` (previously approved, file
unchanged) can be loaded directly; `new` and `changed` are left for a human to decide on.

Loads and unloads take effect at a run boundary: immediately when the session is idle, otherwise
queued until the current run ends. Each one invalidates the provider's prompt cache once (the tool
table changed, so the prefix is guaranteed to miss) — a one-off cost, so avoid churning at high frequency.

## Three hard rules

1. **Only `import type` the framework types.** Runtime capability comes exclusively from `setup(api)`.
2. **Every side effect is either an `api` registration or is collected into the cleanup function
   returned by `setup`** — anything else is not reclaimed on unload.
3. **Keep shared resources inside a single extension** rather than splitting them across extensions
   that depend on each other. To consume a process-level service, name it with `uses` on the
   definition and receive it from `setup(api, { services })`. Publishers declare nothing: a definition
   carrying `create` publishes under its own `id` as the service name.
