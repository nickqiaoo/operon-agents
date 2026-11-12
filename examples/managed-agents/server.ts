/**
 * A real managed-agents composition root. HTTP resources, the long-lived session event
 * stream and client protocol live in `operon-managed-agents`; this file only supplies the
 * application-specific Agent, session repository and execution environment.
 */
import { mkdirSync } from "node:fs";
import { ConsoleSink, defaultCapabilities, DiskSessionRepository, McpOAuthService, MemoryMcpCredentialStore, sinkLogger } from "operon-agents/advanced";
import { createHarness, LocalEnvironment } from "operon-agents";
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
// engine the local CLI runs. In production: swap the repository for Pg/Redis, the environment
// for a sandbox factory, and the credential store for your secret manager.
const repository = new DiskSessionRepository(HOME);
const harness = createHarness({
  config: {
    workDir: WORK,
    // What a multi-tenant worker requires of its harness, stated once here rather than on each
    // open: every session on an environment of its own, and events durable before they are seen.
    policy: { strictIsolation: true },
    eventPublication: "committed",
    defaults: {
      model: MODEL,
      appendSystemPrompt: "Use the tools to inspect and edit the workspace; explain what you do.",
      permission: { mode: "workspace" },
    },
  },
  infrastructure: () => ({
    sessionRepository: repository,
    environment: new LocalEnvironment(WORK),
    logger: sinkLogger(new ConsoleSink({ write: (line) => process.stdout.write(`${line}\n`) })),
  }),
  sessionCapabilities: (ctx) =>
    // The standard bundle for this session — the MCP servers its configuration names, its
    // isolation and its credentials all come from `ctx` — plus an OAuth store of this host's own.
    defaultCapabilities({
      session: ctx,
      oauthService: new McpOAuthService({ store: new MemoryMcpCredentialStore() }),
    }),
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
    environment: ({ sessionId }) => {
      const directory = new URL(`./workspace/${sessionId}/`, import.meta.url).pathname;
      mkdirSync(directory, { recursive: true });
      return new LocalEnvironment(directory);
    },
  },
});
// Carries live events from the worker to whoever is watching, already translated to managed
// session events.
//
// In-memory is correct HERE because this file runs the service and the worker in one process.
// It is the wrong choice the moment they are separate services: each side would hold its own
// Map and the worker's events would never reach a subscriber. Swap in `RedisEventBroadcaster`
// (publisher + a SEPARATE subscriber connection) and nothing else in this file changes.
const broadcaster = new MemoryEventBroadcaster();
// The work table: the managed event log (what was sent, what the session emitted) and the
// lease. The service appends sent events and wakes their session; the worker claims woken
// sessions and pulls their events. The two share nothing else — not even here, in one process.
// Across nodes it is `PgSessionWork`, and nothing else in this file changes.
const work = new MemorySessionWork();
const worker = new SessionWorker({
  harness,
  repository,
  metadataStore,
  environments,
  broadcaster,
  work,
});
// Claim woken sessions. Nothing else ever hands this worker work.
worker.start();
const service = new SessionService({ work, metadataStore, broadcaster });
const managed = createManagedHttpServer({
  service,
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
    void managed.close().then(() => worker.stop()).finally(() => process.exit(0));
  });
}
