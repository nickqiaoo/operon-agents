# Peers Extension Template (with a `workspace` half)

The standard starting point for a file extension that carries **shared state** — one instance per
workspace here (a `workspace` half; a `harness` half is the once-per-process twin) — the shared-state
counterpart to [`extension-template`](../extension-template). This whole directory is a
single `peers(config)` call: it returns an ordinary `ExtensionDefinition` with a `workspace` half, the
very same definition a server passes to `createHarness({ extensions: [peers(config)] })`.

## The artifact

After `pnpm build` (a single esbuild bundle, zero install), `dist/` is the complete artifact:

```
dist/
  manifest.json   # { id, version, engine, entry, name, description } — identity, compatibility gate,
                  # presentation. Whether it shares process-level state is decided by the presence of a
                  # workspace (or harness) half on the definition, not by the manifest.
  index.js        # A single esbuild bundle with operon-agents-peers rolled in.
```

The host drops the folder into `extensionDir` and calls `load` — no peers code on the host side. The
config (`teammates`, `visibility`) lives in `src/index.ts`, and state lives in the data directory the
framework provides (`host.dataDir`, by default `<extensionDir>/.data/peers`, outside the bundle), so
neither swapping instances on reload nor overwriting the bundle on update touches it.

## Distribution

`pnpm release` (build, then `../scripts/pack-extension.mjs`, which has no dependencies) writes
`peers-<version>.zip`, a `.zip.sha256`, and an index JSON entry into `release/` (presentation fields
plus engine and sha256, all taken from the manifest). Installing means: verify the hash → unzip into
`<extensionDir>/peers/` → `harness.extensions.load("peers")`. Updating follows the same path, ending
in a `reload`.

## Loading (host side)

```ts
const harness = createHarness({ model, extensionDir: "~/.myapp/extensions" });
await harness.extensions.load("peers");      // loading is the approval; each workspace runs the half on first use
const lead = await harness.createSession();  // an ordinary session gets Team; teammates spawned by Team get Hub (no Team)
// after editing the file: await harness.extensions.reload("peers") — rendezvous at the barrier, swap the
// implementation without reopening sessions
```

For the full mechanism see `packages/agents-peers/README.md`; for the standard way to write an
extension with a shared half see `packages/agents/docs/extensions.md`.
