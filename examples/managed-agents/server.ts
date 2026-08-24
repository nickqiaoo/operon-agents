/**
 * A real managed-agents composition root. HTTP resources, the long-lived session event
 * stream and client protocol live in `operon-managed-agents`; this file only supplies the
 * application-specific Agent, session repository and execution environment.
 */
import { mkdirSync } from "node:fs";
import {
  ConsoleSink,
  createHarness,
  defaultCapabilities,
  defineModel,
  DiskSessionRepository,
  LocalMachine,
  McpOAuthService,
  MemoryMcpCredentialStore,
  sinkLogger,
} from "operon-agents";
import {
  allowAllRequests,
  createManagedHttpServer,
  DiskManagedSessionMetadataStore,
  ManagedUnauthorizedError,
  MemoryEventBroadcaster,
  MemorySessionWork,
  SessionService,
  SessionWorker,
  StaticEnvironmentRegistry,
} from "operon-managed-agents/server";

const PORT = Number(process.env.PORT ?? 8088);
const MODEL = process.env.MODEL ?? "anthropic/claude-opus-4-8";
const API_KEY = process.env.MANAGED_API_KEY;
const HOME = new URL("./.agent-home/", import.meta.url).pathname;
const WORK = new URL("./workspace/", import.meta.url).pathname;
mkdirSync(WORK, { recursive: true });

// A hosted deployment assembles its own backends — there is no server preset, on purpose.
// The four choices below ARE what "this is a server" means; everything else is the same
// engine the local CLI runs. In production: swap the repository for Pg/Redis, the machine
// for a sandbox factory, and the credential store for your secret manager.
const repository = new DiskSessionRepository(HOME);
const harness = createHarness({
  model: MODEL,
  resolveModel(id) {
    const slash = id.indexOf("/");
    if (slash <= 0) throw new Error(`invalid model "${id}": expected provider/model`);
    return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
  },
  repository,
  machine: new LocalMachine(WORK),
  // Diagnostics go to stdout for the platform's log collector, not to a local rotating file.
  logger: sinkLogger(new ConsoleSink({ write: (line) => process.stdout.write(`${line}\n`) })),
  // Built per session, so the OAuth service (and its credential store) is never shared
  // across sessions — the reason the old preset's shared instance was a problem.
  capabilities: () =>
    defaultCapabilities({
      oauthService: new McpOAuthService({ store: new MemoryMcpCredentialStore() }),
    }),
  workDir: WORK,
  appendSystemPrompt: "Use the tools to inspect and edit the workspace; explain what you do.",
  permission: { mode: "workspace" },
});

// The API surface and the execution half are separate objects joined only by the store. Here
// they share a process; a larger deployment runs them as separate services, and the HTTP layer
// stays identical because it never reaches into a running session.
const metadataStore = new DiskManagedSessionMetadataStore(
  new URL("./.agent-home/managed/", import.meta.url).pathname,
);
const environments = new StaticEnvironmentRegistry({
  workspace: {
    workDir: WORK,
    machine: ({ sessionId }) => {
      const directory = new URL(`./workspace/${sessionId}/`, import.meta.url).pathname;
      mkdirSync(directory, { recursive: true });
      return new LocalMachine(directory);
    },
  },
});
// Carries live events — including the ones never written to the log, such as token deltas —
// from the worker to whoever is watching.
//
// In-memory is correct HERE because this file runs the service and the worker in one process.
// It is the wrong choice the moment they are separate services: each side would hold its own
// Map and the worker's events would never reach a subscriber, with no error to notice — the
// stream would just quietly carry persisted events only. Swap in `RedisEventBroadcaster`
// (publisher + a SEPARATE subscriber connection) and nothing else in this file changes.
const broadcaster = new MemoryEventBroadcaster();
// The work table: every accepted input is written to the log AND wakes its session here, and
// the worker claims woken sessions from here. It is both the queue and the lock, which is why
// the service and the worker must share ONE instance. In-memory is right for one process;
// across nodes it is `PgSessionWork` over the same Postgres the log lives in, and nothing else
// in this file changes.
const work = new MemorySessionWork({ repository });
const worker = new SessionWorker({
  harness,
  repository,
  metadataStore,
  environments,
  broadcaster,
  work,
});
// Claim woken sessions. The HTTP layer also nudges this worker directly after every write, so
// in one process the claim loop only catches what a nudge could not; across nodes it is the path.
worker.start();
const service = new SessionService({
  repository,
  work,
  metadataStore,
  environments,
  broadcaster,
});
const managed = createManagedHttpServer({
  service,
  worker,
  // Required, so running without authentication is something this file says out loud rather
  // than something it gets by omitting an option.
  authorize:
    API_KEY === undefined
      ? allowAllRequests
      : (request) => {
          if (request.headers.authorization !== `Bearer ${API_KEY}`) {
            throw new ManagedUnauthorizedError();
          }
        },
});
await managed.listen(PORT);

console.error(`operon managed agents listening on http://localhost:${PORT}/v1`);
console.error(`model=${MODEL} environment=workspace`);
if (API_KEY === undefined) console.error("warning: MANAGED_API_KEY is unset; HTTP API has no authentication");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void managed.close().finally(() => process.exit(0));
  });
}
