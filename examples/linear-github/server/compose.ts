// The engineer's managed-agents server, as one function so `pnpm server` and the test build the
// same thing from different parts: a real model and GitHub, or a faux model and a bare repo.
//
// Same composition as ../../managed-agents/server.ts. What is specific here: the builtin coding
// profile plus SubmitPullRequest, the engineer's guidance appended to the profile's prompt, and
// environments that are repositories: a session's environment id is `owner/name`, and its
// environment is a clone of that repository (server/checkout.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ConsoleSink,
  createHarness,
  defaultCapabilities,
  defineModel,
  DiskSessionRepository,
  sinkLogger,
  T,
  token,
  type ChatModel,
  type TracingProcessor,
} from "operon-agents";
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
  readonly model: string | ChatModel;
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

/** The session's hold on its sandbox, registered on the session scope so closing the session
 *  (the worker closes it after every lease) pauses the sandbox through the scope's teardown. */
const SandboxLease = token<{ close(): Promise<void> }, "session">("linear-github.sandbox-lease", "session");

export async function composeServer(options: ServerOptions) {
  mkdirSync(options.work, { recursive: true });
  const repository = new DiskSessionRepository(options.home);
  const sandboxes = options.sandbox !== undefined ? new E2BCheckouts(options.sandbox, options.github, options.work) : undefined;
  const harness = createHarness({
    model: options.model,
    resolveModel(id) {
      const slash = id.indexOf("/");
      if (slash <= 0) throw new Error(`invalid model "${id}": expected provider/model`);
      return defineModel({ provider: id.slice(0, slash), model: id.slice(slash + 1) });
    },
    harness: (scope) => {
      scope.register(T.SessionRepository, repository);
      if (options.log) {
        scope.register(T.Logger, sinkLogger(new ConsoleSink({ write: (line) => process.stdout.write(`${line}\n`) })));
      }
      // Harness-scoped: one processor, every session bridges its events into it. Disposed with
      // the scope, which flushes what is still buffered before the process goes away.
      if (options.tracing !== undefined) {
        scope.register(T.Tracing, options.tracing, { dispose: (tracing) => (tracing as TracingProcessor).shutdown() });
      }
    },
    // The builtin coding profile (files, shell, questions) plus the one tool that ships code.
    extensions: [pullRequestExtension(options.github)],
    appendSystemPrompt: SYSTEM_PROMPT,
    // One engineer per issue: no subagent fleet, no workflow tool.
    subagentProvider: null,
    workflowTool: false,
    session: (scope, ctx) => {
      if (sandboxes !== undefined) {
        const sessionId = ctx.sessionId;
        scope.register(SandboxLease, {
          async close() {
            const paused = await sandboxes.releaseSession(sessionId);
            if (!paused && options.log) console.warn(`[sandbox] ${sessionId}: could not pause; the sandbox runs until its timeout`);
          },
        });
      }
      return defaultCapabilities({ scope, ownEnvironment: ctx.ownEnvironment });
    },
    workDir: options.work,
    // Everything inside the clone is approved; the safety floor (sensitive files, .git internals,
    // writes outside the checkout) still asks -- and an ask becomes a question in the thread.
    permission: { mode: "workspace" },
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
  const work = new MemorySessionWork({ repository });
  const worker = new SessionWorker({ harness, repository, metadataStore, environments, broadcaster, work, defaultAgentId: AGENT_ID });
  worker.start();
  const service = new SessionService({ repository, work, metadataStore, environments, broadcaster });
  const apiKey = options.apiKey;
  const managed = createManagedHttpServer({
    service,
    worker,
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
