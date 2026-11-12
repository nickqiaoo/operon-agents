// The engineer's managed-agents server, as one function so `pnpm server` and the test build the
// same thing from different parts: a real model and GitHub, or a faux model and a bare repo.
//
// Same composition as ../../managed-agents/server.ts. What is specific here: the builtin coding
// profile plus SubmitPullRequest, the engineer's guidance appended to the profile's prompt, and
// environments that are repositories: a session's environment id is `owner/name`, and its
// environment is a clone of that repository (server/checkout.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConsoleSink, defaultCapabilities, DiskSessionRepository, sinkLogger, type TracingProcessor } from "operon-agents/advanced";
import { createHarness, type ModelManager } from "operon-agents";
import {
  allowAllRequests,
  createManagedHttpServer,
  DiskManagedSessionMetadataStore,
  ManagedInvalidRequestError,
  ManagedUnauthorizedError,
  MemoryEventBroadcaster,
  MemorySessionWork,
  SessionService,
  SessionWorker,
  type ManagedEnvironmentRegistry,
} from "operon-managed-agents/server";
import { AGENT_ID, SYSTEM_PROMPT } from "./agent-config.ts";
import { openLocalCheckout } from "./checkout.ts";
import { parseRepo, type GitHubApi, type RepoRef } from "./github.ts";
import { pullRequestExtension } from "./pull-request-tool.ts";
import { E2BCheckouts, type E2BCheckoutOptions } from "./sandbox.ts";

export interface ServerOptions {
  readonly model: string;
  /** What `model` resolves against. Omitted, the harness builds its own. */
  readonly modelManager?: ModelManager;
  readonly github: GitHubApi;
  /** Session logs and managed metadata. */
  readonly home: string;
  /** One subdirectory per session, each holding a clone. */
  readonly work: string;
  readonly apiKey?: string;
  /** Log to stdout (off in tests). */
  readonly log?: boolean;
  /** SSE heartbeat, for tests that want a quick one. */
  readonly heartbeatMs?: number;
  /** Run sessions in E2B sandboxes instead of directories on this host. */
  readonly sandbox?: E2BCheckoutOptions;
  /** Where every session's spans go (server/langfuse.ts). Shut down when the harness closes. */
  readonly tracing?: TracingProcessor;
}

export async function composeServer(options: ServerOptions) {
  mkdirSync(options.work, { recursive: true });
  const repository = new DiskSessionRepository(options.home);
  const sandboxes = options.sandbox !== undefined ? new E2BCheckouts(options.sandbox, options.github, options.work) : undefined;
  const harness = createHarness({
    ...(options.modelManager !== undefined ? { modelManager: options.modelManager } : {}),
    infrastructure: () => ({
      sessionRepository: repository,
      ...(options.log ? { logger: sinkLogger(new ConsoleSink({ write: (line) => process.stdout.write(`${line}\n`) })) } : {}),
      // One processor for the process; every session bridges its events into it. `close` flushes
      // what is still buffered before the process goes away.
      ...(options.tracing !== undefined ? { tracing: options.tracing } : {}),
      close: async () => {
        await (options.tracing as TracingProcessor | undefined)?.shutdown();
      },
    }),
    extensions: [pullRequestExtension(options.github)],
    sessionCapabilities: (ctx) => {
      const base = defaultCapabilities({ session: ctx });
      if (sandboxes === undefined) return base;
      // The sandbox lease is session-lived, so it is a capability: closing the session releases
      // it, in reverse order with everything else the session opened.
      const sessionId = ctx.sessionId;
      return [
        ...base,
        {
          name: "sandbox-lease",
          contract: "detachable" as const,
          closeSession: async () => {
            const paused = await sandboxes.releaseSession(sessionId);
            if (!paused && options.log) console.warn(`[sandbox] ${sessionId}: could not pause; the sandbox runs until its timeout`);
          },
        },
      ];
    },
    config: {
      workDir: options.work,
      policy: { strictIsolation: true },
      eventPublication: "committed",
      defaults: { model: options.model, appendSystemPrompt: SYSTEM_PROMPT, subagents: false, permission: { mode: "workspace" } },
    },
  });

  const metadataStore = new DiskManagedSessionMetadataStore(join(options.home, "managed"));
  // An environment per repository, named by it. Nothing to register: the id is parsed, and
  // whether the repository exists (and the credential reaches it) is git's answer at clone time.
  const environments: ManagedEnvironmentRegistry = {
    resolve({ id }) {
      let repo: RepoRef;
      try {
        repo = parseRepo(id);
      } catch {
        throw new ManagedInvalidRequestError(`environment "${id}" is not a repository ("owner/name")`);
      }
      return {
        workDir: options.work,
        environment: ({ sessionId }) =>
          sandboxes !== undefined ? sandboxes.openSession(sessionId, repo) : openLocalCheckout(join(options.work, sessionId), sessionId, repo, options.github),
      };
    },
  };
  const broadcaster = new MemoryEventBroadcaster();
  const work = new MemorySessionWork();
  const worker = new SessionWorker({ harness, repository, metadataStore, environments, broadcaster, work, defaultAgentId: AGENT_ID });
  worker.start();
  const service = new SessionService({
    work,
    metadataStore,
    broadcaster,
    // Refuse a session whose environment names no repository, before it exists. Parsing is the
    // whole check — nothing is cloned or booted here; the worker does that on first claim.
    validateCreate: ({ environment }) => {
      try {
        parseRepo(environment.id);
      } catch {
        throw new ManagedInvalidRequestError(`environment "${environment.id}" is not a repository ("owner/name")`);
      }
    },
  });
  const apiKey = options.apiKey;
  const managed = createManagedHttpServer({
    service,
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    authorize:
      apiKey === undefined
        ? allowAllRequests
        : (request) => {
            if (request.headers.authorization !== `Bearer ${apiKey}`) throw new ManagedUnauthorizedError();
          },
  });
  return { managed, service, worker, harness, sandboxes };
}
