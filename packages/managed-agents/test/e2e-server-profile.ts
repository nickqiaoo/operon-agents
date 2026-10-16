/**
 * The server profile (docs/server-profile.md): what a multi-tenant worker hands a host, and what
 * it refuses.
 *
 * Covers:
 *  - both registries are told which session they resolve for — at create (environment) and on
 *    every open (both) — with the server-stamped `ownerKey` and the client's `metadata`;
 *  - a multi-tenant worker refuses: an environment registry that resolves no environment, a
 *    harness holding process-wide MCP connections, an stdio MCP server, a token read from the
 *    process environment. Each refusal reaches `onError` and nothing runs;
 *  - a custom `session` hook that ignores `strictIsolation` and connects stdio anyway is caught
 *    after the open, and the session is closed before it runs.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  createMcpServers,
  DiskSessionRepository,
  mcpServersCapability,
  LocalEnvironment,
  type AgentEvent,
  type Capability,
  type HarnessParts,
  type McpServerConfig,
} from "operon-agents";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";
import type { ManagedAgentRegistry, ManagedEnvironmentRegistry, ManagedSessionContext } from "../src/server/registries.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface FixtureOptions {
  /** Return a per-session environment from the registry (the multi-tenant requirement). */
  readonly perSessionEnvironment?: boolean;
  readonly parts?: Omit<HarnessParts, "sessionRepository">;
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** A custom capability factory — one that may ignore `strictIsolation`. */
  readonly session?: () => Capability[];
}

async function scenario(name: string, options: FixtureOptions) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const work = join(root, "work");
  mkdirSync(work);
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("hello", { stopReason: "stop" })]);
  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environmentCalls: ManagedSessionContext[] = [];
  const agentCalls: ManagedSessionContext[] = [];
  const environments: ManagedEnvironmentRegistry = {
    resolve: (_ref, session) => {
      environmentCalls.push(session);
      return options.perSessionEnvironment === true
        ? { workDir: work, environment: () => new LocalEnvironment(work) }
        : { workDir: work };
    },
  };
  const agents: ManagedAgentRegistry = {
    resolve: (_ref, session) => {
      agentCalls.push(session);
      return options.mcpServers !== undefined ? { resumeOptions: { mcpServers: options.mcpServers } } : {};
    },
  };
  const harness = createHarness({
    harness: () => ({ sessionRepository: repository, ...(options.parts ?? {}) }),
    ...(options.session !== undefined ? { session: options.session } : {}),
    model: faux.getChatModel(),
    permission: { mode: "yolo" },
  });
  const sessionWork = new MemorySessionWork({ repository });
  const service = new SessionService({ repository, metadataStore, environments, work: sessionWork, ownerKey: "tenant-a" });
  const errors: string[] = [];
  const worker = new SessionWorker({
    harness,
    repository,
    metadataStore,
    environments,
    agents,
    work: sessionWork,
    renewIntervalMs: 30,
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
  });
  const session = await service.create({ agent: "default", environment: "default", metadata: { vault: "vlt-a" } });
  await service.appendEvent(session.id, { input: "hi" });
  await worker.drain(session.id);
  const events: readonly AgentEvent[] = (await service.listEvents(session.id, { limit: 200 })).data;
  const replied = events.some((e) => e.type === "message.appended" && e.message.role === "assistant");
  const cleanup = async (): Promise<void> => {
    await harness.close();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  };
  return { sessionId: session.id, environmentCalls, agentCalls, errors, replied, cleanup };
}

const tenantOf = (context: ManagedSessionContext | undefined, sessionId: string): boolean =>
  context?.sessionId === sessionId && context.ownerKey === "tenant-a" && context.metadata?.["vault"] === "vlt-a";

async function main(): Promise<void> {
  // ── a well-formed multi-tenant session runs, and the registries know whose it is ──
  {
    const s = await scenario("profile-ok", { perSessionEnvironment: true });
    check("multi-tenant: a session with its own environment runs", s.replied && s.errors.length === 0);
    check("identity: the environment registry is told at create", tenantOf(s.environmentCalls[0], s.sessionId));
    check("identity: and again on open", s.environmentCalls.length === 2 && tenantOf(s.environmentCalls[1], s.sessionId));
    check("identity: the agent registry is told on open", s.agentCalls.length === 1 && tenantOf(s.agentCalls[0], s.sessionId));
    await s.cleanup();
  }

  // ── R1: no environment from the registry ──
  {
    const s = await scenario("profile-no-env", {});
    check("R1: an environment registry that resolves none is refused", s.errors.some((m) => m.includes("resolved no environment")));
    check("R1: and nothing ran", !s.replied);
    await s.cleanup();
  }

  // ── R2: the harness shares MCP connections across the process ──
  {
    const s = await scenario("profile-shared", { perSessionEnvironment: true, parts: { mcpServers: createMcpServers({}) } });
    check("R2: a harness with process-wide MCP connections is refused", s.errors.some((m) => m.includes("shares mcpServers")));
    check("R2: and nothing ran", !s.replied);
    await s.cleanup();
  }

  // ── R3: an stdio MCP server ──
  {
    const s = await scenario("profile-stdio", {
      perSessionEnvironment: true,
      mcpServers: { local: { transport: "stdio", command: "true" } as McpServerConfig },
    });
    check("R3: an stdio MCP server is refused", s.errors.some((m) => m.includes("stdio")));
    check("R3: and nothing ran", !s.replied);
    await s.cleanup();
  }

  // ── R4: a token read from the process environment ──
  {
    const s = await scenario("profile-env-token", {
      perSessionEnvironment: true,
      mcpServers: { linear: { transport: "http", url: "http://127.0.0.1:1/mcp", bearerTokenEnvVar: "LINEAR_TOKEN" } as McpServerConfig },
    });
    check("R4: bearerTokenEnvVar is refused", s.errors.some((m) => m.includes("process environment")));
    check("R4: and nothing ran", !s.replied);
    await s.cleanup();
  }

  // ── backstop: a custom hook that ignores strictIsolation ──
  {
    const s = await scenario("profile-hook", {
      perSessionEnvironment: true,
      session: () => [mcpServersCapability({ local: { transport: "stdio", command: "true" } as McpServerConfig })],
    });
    check("backstop: an stdio server a custom hook connected is caught", s.errors.some((m) => m.includes("runs over stdio")));
    check("backstop: and nothing ran", !s.replied);
    await s.cleanup();
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ SERVER PROFILE E2E PASS");
}

await main();
