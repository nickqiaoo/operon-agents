/**
 * The analyst's managed-agents server. Same composition root as ../../managed-agents/server.ts,
 * configured for one agent -- web research only: no shell, no filesystem, no subagents -- in
 * one environment. The chat app in src/ is a *client* of this server, exactly as a Slack or
 * web bot is a client of Claude Managed Agents; the two run as separate processes.
 *
 * Bash stays off on purpose: this agent reads untrusted web pages, and prompt-injected content
 * plus an auto-approved shell plus open egress is an exfiltration path. A brief is web research
 * and synthesis; it does not need a shell.
 */
import { mkdirSync } from "node:fs";
import {
  compactionCapability,
  ConsoleSink,
  createHarness,
  defineAgent,
  defineModel,
  DirectFetchProvider,
  DiskSessionRepository,
  fetchUrlTool,
  FirecrawlProvider,
  LocalMachine,
  sinkLogger,
  T,
  TavilySearchProvider,
  webSearchTool,
  type Tool,
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
import { AGENT_ID, ENVIRONMENT_ID, MODEL, SYSTEM_PROMPT } from "./agent-config.ts";

const PORT = Number(process.env.MANAGED_PORT ?? 8088);
const API_KEY = process.env.MANAGED_API_KEY || undefined;
// Loopback unless the API is protected: the chat app is the only intended caller.
const HOST = process.env.MANAGED_HOST ?? (API_KEY === undefined ? "127.0.0.1" : "0.0.0.0");
const HOME = new URL("../.agent-home/", import.meta.url).pathname;
const WORK = new URL("../workspace/", import.meta.url).pathname;
mkdirSync(WORK, { recursive: true });

// The analyst's tools: search when a provider key is present, fetch always. Firecrawl covers
// both; Tavily is search-only and pairs with plain HTTP fetching.
const firecrawl = process.env.FIRECRAWL_API_KEY ? new FirecrawlProvider({ apiKey: process.env.FIRECRAWL_API_KEY }) : undefined;
const tavily = process.env.TAVILY_API_KEY ? new TavilySearchProvider({ apiKey: process.env.TAVILY_API_KEY }) : undefined;
const search = firecrawl ?? tavily;
const tools: Tool[] = [...(search ? [webSearchTool(search)] : []), fetchUrlTool(firecrawl ?? new DirectFetchProvider())];

const repository = new DiskSessionRepository(HOME);
const harness = createHarness({
  model: MODEL,
  resolveModel(id) {
    const slash = id.indexOf("/");
    if (slash <= 0) throw new Error(`invalid model "${id}": expected provider/model`);
    return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
  },
  harness: (scope) => {
    scope.register(T.SessionRepository, repository);
    scope.register(T.Logger, sinkLogger(new ConsoleSink({ write: (line) => process.stdout.write(`${line}\n`) })));
  },
  // The agent IS the configuration: a custom Agent replaces the builtin coding profile (and
  // its filesystem-shaped prompt) wholesale, so the analyst never hears about files or shells.
  agent: defineAgent({ name: AGENT_ID, model: MODEL, instructions: SYSTEM_PROMPT, tools }),
  tools,
  // No Agent/Workflow tools: a brief is one agent's work.
  subagentProvider: null,
  workflowTool: false,
  // Only what a long chat needs. The task/background/skills capabilities would add tools this
  // agent has no use for.
  session: () => [compactionCapability({ maxContextTokens: 200_000 })],
  workDir: WORK,
  // Web tools are always allowed by policy; nothing else exists to ask about. If you re-enable
  // a tool that prompts (Bash, Edit), the chat has no approval surface: the session will park
  // on the question and the bridge will tell the user so.
  permission: { mode: "workspace" },
});

const metadataStore = new DiskManagedSessionMetadataStore(new URL("../.agent-home/managed/", import.meta.url).pathname);
const environments = new StaticEnvironmentRegistry({
  [ENVIRONMENT_ID]: {
    workDir: WORK,
    machine: ({ sessionId }) => {
      const directory = new URL(`../workspace/${sessionId}/`, import.meta.url).pathname;
      mkdirSync(directory, { recursive: true });
      return new LocalMachine(directory);
    },
  },
});
// One process runs both the API and the worker, so in-memory fan-out and work table are right;
// see ../../managed-agents/server.ts for what changes across nodes (Redis broadcaster, Pg work).
const broadcaster = new MemoryEventBroadcaster();
const work = new MemorySessionWork({ repository });
const worker = new SessionWorker({
  harness,
  repository,
  metadataStore,
  environments,
  broadcaster,
  work,
  defaultAgentId: AGENT_ID,
});
worker.start();
const service = new SessionService({ repository, work, metadataStore, environments, broadcaster });
const managed = createManagedHttpServer({
  service,
  worker,
  authorize:
    API_KEY === undefined
      ? allowAllRequests
      : (request) => {
          if (request.headers.authorization !== `Bearer ${API_KEY}`) throw new ManagedUnauthorizedError();
        },
});
await managed.listen(PORT, HOST);

console.error(`analyst server listening on http://${HOST}:${PORT}/v1`);
console.error(`agent=${AGENT_ID} environment=${ENVIRONMENT_ID} model=${MODEL}`);
console.error(
  search
    ? `web search: ${firecrawl ? "firecrawl" : "tavily"}; fetch: ${firecrawl ? "firecrawl" : "direct"}`
    : "warning: no FIRECRAWL_API_KEY or TAVILY_API_KEY -- WebSearch is off, the analyst can only fetch URLs it is given",
);
if (API_KEY === undefined) console.error("MANAGED_API_KEY is unset: loopback only, no authentication");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void managed.close().finally(() => process.exit(0));
  });
}
