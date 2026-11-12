# Peers Extension Template (with a `harness` half)

The standard starting point for a file extension that carries **shared state** — one instance per
process (a `harness` half) — the shared-state counterpart to
[`extension-template`](../extension-template). This whole directory is a host-wired `peers(config)`
definition: it returns an ordinary `ExtensionDefinition` with a `harness` half, the very same
definition a server passes to `createHarness({ extensions: [peers(config)] })`.

## The artifact

After `pnpm build` (a single esbuild bundle, zero install), `dist/` is the complete artifact:

```
dist/
  manifest.json   # { id, version, engine, entry, name, description } — identity, compatibility gate,
                  # presentation. Whether it shares process-level state is decided by the presence of a
                  # harness half on the definition, not by the manifest.
  index.js        # A single esbuild bundle with operon-agents-peers rolled in.
```

The host drops the folder into `extensionDir` and calls `load`. Waking a closed teammate goes
through `harness.resumeSession(id)`, which reuses a loaded instance, joins a load in flight, and
otherwise restores the session from what is stored with it and what the host's `resolveSession`
supplies; a host with sandboxes or per-user credentials registers that once on the harness. The
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
const harness = createHarness({
  config: { defaults: { model } },
  extensionDir: "~/.myapp/extensions",
});
await harness.extensions.load("peers");      // loading is the approval; the harness half runs once, publishing the service
const lead = await harness.createSession();  // an ordinary session gets Team; teammates spawned by Team get Hub (no Team)
// after editing the file: await harness.extensions.reload("peers") — rendezvous at the barrier, swap the
// implementation without reopening sessions
```

For the full mechanism see `packages/agents-peers/README.md`; for the standard way to write an
extension with a shared half see `packages/agents/docs/extensions.md`.
