# operon-os-sandbox

OS-level command sandboxing for the local Machine. Every `Machine.run` — the
bash tool, search binaries, user hooks, everything — is wrapped in the
platform sandbox before it spawns: **Seatbelt** (`sandbox-exec`) on macOS,
**bubblewrap** on Linux, via
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (srt).

- **Filesystem**: writes are allowed only under each machine's cwd +
  `additionalDirs` + tmp + the framework's task-log dir; reads are open except
  srt's built-in credential protections plus your `denyRead`.
- **Network**: deny-all by default. Traffic is forced through a local
  filtering proxy with a domain allowlist; out-of-list hosts can be routed to
  an ask callback (wire it to your approval UI).
- **Visibility**: OS-level denials observed during a run are annotated onto
  that command's stderr as a `<sandbox_violations>` block, so the model sees
  *why* a command failed instead of a bare exit code. Known-benign startup
  noise is filtered.
- **Degrade, don't break**: unsupported platform (Windows) or missing
  dependencies (no `bwrap`) → `machine()` returns a plain `LocalMachine` and
  `status.reason` says why. Same API either way.

## Usage

```ts
import { OsSandbox } from "operon-os-sandbox";

// Once per process (starts the network filter proxy).
const sandbox = await OsSandbox.start({
  network: {
    allowedDomains: ["registry.npmjs.org", "*.github.com"],
    onAskHost: async ({ host, port }) => askUserSomehow(host, port),
  },
  filesystem: {
    denyRead: ["~/secrets"],
    denyWrite: [],           // e.g. [`${work}/.env`]
  },
});
if (!sandbox.status.enabled) console.warn(`os-sandbox off: ${sandbox.status.reason}`);

// Wherever you previously built the machine:
//   machine: new LocalMachine(WORK)
// becomes:
const machine = sandbox.machine(WORK);

// ... hand it to createAgent / the session as usual. withCwd() siblings
// (subagent worktrees) stay sandboxed automatically.

await sandbox.dispose(); // on shutdown
```

Only local machines are wrapped — SSH and vendor-sandbox machines run their
commands elsewhere, so this layer deliberately does not touch them. Direct
file I/O (`readBytes`/`writeText`/…) is also untouched: those are the
framework's own code paths, gated by its path-access policy; the OS sandbox
exists for arbitrary *commands*, which have no such gate.

## Platform requirements

- **macOS**: none (uses `/usr/bin/sandbox-exec`).
- **Linux**: `bubblewrap`, `socat`, `ripgrep` installed. Ubuntu 24.04+ needs
  `kernel.apparmor_restrict_unprivileged_userns=0` (or an AppArmor userns
  profile). Missing pieces are reported in `status.reason` and the sandbox
  degrades to plain `LocalMachine`.
- **Windows**: not supported by this package (srt's Windows backend is alpha
  and needs an elevated install); always degrades.

## Caveats

- One `OsSandbox` per process — srt's `SandboxManager` is a process-wide
  singleton. Different machines (different cwds) are fine; a second `start()`
  with a different config is not.
- The network allowlist only serves proxy-aware clients (HTTP/HTTPS via env
  vars, TCP via SOCKS). Raw-TCP clients that ignore proxies — plain `ssh`, DB
  drivers — stay blocked even with `["*"]`; grant a unix socket, or run those
  outside the sandbox.
- Violation annotation is best-effort: the macOS monitor tails `log stream`,
  which lags slightly (failed commands get one 250 ms re-check).
- `@anthropic-ai/sandbox-runtime` is pinned exactly (0.0.x — API still moves).
