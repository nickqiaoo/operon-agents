// The peers extension — the reference implementation of "installing an extension gets you
// shared state" (an extension with a workspace half: one network per working directory).
//
// The whole file is a single `peers(...)` call: it returns an ordinary ExtensionDefinition with a
// harness half, the same definition a server passes to `createHarness({ extensions: [peers(...)] })`.
// One body of code, two delivery paths. The workspace half builds one network per workspace and the
// framework registers it as that workspace's "peers" service; the session half decides from the session params whether to
// attach Team or Hub: an ordinary session gets Team, while a spawned teammate (params.member) gets
// only Hub — a teammate is a member, it does not form teams of its own.
//
// State lives in the data directory the framework provides (host.dataDir — the workspace's own
// folder, outside the bundle directory), so swapping the network instance on reload and overwriting the bundle on update both
// leave the roster and mailboxes intact. Swap in createMemoryPeerRepo() and a reload clears them.
//
// Hard rule (same as the session-level extension template): the framework itself (operon-agents) may
// only be imported as a type. operon-agents-peers is the implementation you ship, so it is a value
// import and esbuild rolls it into dist/.
//
// Build: `pnpm build` → manifest.json + index.js under dist/ is the complete artifact.
import { createFilePeerRepo, createMemoryPeerRepo, peers, sharedLabelVisibility } from "operon-agents-peers";

export default peers({
  repo: ({ dataDir }) => (dataDir !== undefined ? createFilePeerRepo(dataDir) : createMemoryPeerRepo()),
  visibility: sharedLabelVisibility,
  // The teammate kinds a model may `Team spawn`. Each value is the birth configuration (session
  // options) for sessions of that kind; the workspace half's spawn factory appends the Hub mount and
  // the member identity through params automatically.
  teammates: { member: { title: "teammate" } },
});
