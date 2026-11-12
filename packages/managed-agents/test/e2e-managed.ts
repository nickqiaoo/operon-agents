/**
 * The HTTP contract, and a restart.
 *
 *  - The authorization hook sees every route with the action and session it is for, and its
 *    refusals keep their status: 401 for "who are you", 403 for "not yours".
 *  - Errors come back Anthropic-shaped (`{ type: "error", error: { type, message } }`), and a
 *    malformed body is refused naming the field.
 *  - A restart — new service, new worker, new harness over the same disk stores — reopens the
 *    session by id, and the next message continues the same conversation.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, LocalEnvironment } from "operon-agents";
import { DiskSessionRepository } from "operon-agents/advanced";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "./faux.ts";
import { ManagedAgentsClient, ManagedApiClientError, run } from "../src/client/index.ts";
import {
  createManagedHttpServer,
  DiskManagedSessionMetadataStore,
  ManagedForbiddenError,
  ManagedUnauthorizedError,
  MemoryEventBroadcaster,
  MemorySessionWork,
  SessionService,
  SessionWorker,
  StaticEnvironmentRegistry,
  type ManagedAuthorizationContext,
} from "../src/server/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const authorized: ManagedAuthorizationContext[] = [];

async function start(root: string, work: MemorySessionWork, faux: ReturnType<typeof registerFauxProvider>) {
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const repository = new DiskSessionRepository(join(root, "sessions"));
  const metadataStore = new DiskManagedSessionMetadataStore(join(root, "managed"));
  const broadcaster = new MemoryEventBroadcaster();
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(workDir) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const service = new SessionService({ work, metadataStore, broadcaster });
  const worker = new SessionWorker({
    profile: "single-tenant", harness, repository, metadataStore, work, broadcaster,
    environments: new StaticEnvironmentRegistry({ workspace: { workDir } }),
    claimIntervalMs: 20, inputPollIntervalMs: 20,
  });
  worker.start();
  const http = createManagedHttpServer({
    service,
    heartbeatMs: 50,
    authorize: (request, context) => {
      authorized.push(context);
      if (request.headers.authorization === undefined) throw new ManagedUnauthorizedError();
      if (request.headers.authorization !== "Bearer managed-test-key") throw new ManagedForbiddenError();
    },
  });
  await http.listen(0, "127.0.0.1");
  const address = http.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
  return {
    baseUrl,
    client: new ManagedAgentsClient({ baseUrl, apiKey: "managed-test-key" }),
    async stop(): Promise<void> {
      await http.close();
      await worker.stop();
    },
  };
}

async function failure(fn: () => Promise<unknown>): Promise<ManagedApiClientError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error instanceof ManagedApiClientError ? error : undefined;
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "managed-http-"));
  const faux = registerFauxProvider();
  const seen: string[] = [];
  const answer = (text: string): FauxResponseStep => async (context) => {
    seen.push(context.messages.map((m) => JSON.stringify(m.content)).join("\n"));
    return fauxAssistantMessage(text, { stopReason: "stop" });
  };
  faux.setResponses([answer("first answer"), answer("second answer")]);
  // Shared across the restart, as Postgres would be.
  const work = new MemorySessionWork();
  let running = await start(root, work, faux);
  try {
    // ── auth ─────────────────────────────────────────────────────────────────────
    const anonymous = await failure(() => new ManagedAgentsClient({ baseUrl: running.baseUrl }).sessions.list());
    check("auth: missing credentials are a 401", anonymous?.status === 401 && anonymous.code === "authentication_error");
    const wrong = await failure(() => new ManagedAgentsClient({ baseUrl: running.baseUrl, apiKey: "nope" }).sessions.list());
    check("auth: refused credentials are a 403", wrong?.status === 403 && wrong.code === "permission_error");

    const session = await running.client.sessions.create({ agent: "default", environment_id: "workspace", title: "kept" });
    authorized.length = 0;
    await running.client.sessions.retrieve(session.id);
    await running.client.sessions.events.list(session.id);
    check("auth: the hook is told the action and the session", authorized.map((c) => `${c.action}:${c.sessionId ?? ""}`).join()
      === `sessions.read:${session.id},events.list:${session.id}`);

    // ── errors ───────────────────────────────────────────────────────────────────
    const response = await fetch(`${running.baseUrl}/sessions/nope`, { headers: { authorization: "Bearer managed-test-key" } });
    const body = await response.json() as { type?: string; error?: { type?: string; message?: string } };
    check("errors: Anthropic-shaped body", response.status === 404 && body.type === "error" && body.error?.type === "not_found_error");
    const badEvent = await failure(() => running.client.sessions.events.send(session.id, {
      events: [{ type: "user.tool_confirmation", tool_use_id: "", result: "allow" }],
    }));
    check("errors: a malformed event is refused naming the field", badEvent?.status === 400 && badEvent.message.includes("tool_use_id"));
    const badJson = await fetch(`${running.baseUrl}/sessions`, { method: "POST", body: "{", headers: { authorization: "Bearer managed-test-key", "content-type": "application/json" } });
    check("errors: invalid JSON is a 400", badJson.status === 400);
    const unknown = await fetch(`${running.baseUrl}/sessions/${session.id}/cancel`, { method: "POST", headers: { authorization: "Bearer managed-test-key" } });
    check("errors: the old control routes are gone", unknown.status === 404);

    // ── run, restart, continue ───────────────────────────────────────────────────
    const first = await run(running.client, session.id, "remember the word pelican", { timeoutMs: 10_000 });
    check("run: first answer", first.output === "first answer");
    await running.stop();

    running = await start(root, work, faux);
    const reopened = await running.client.sessions.retrieve(session.id);
    check("restart: the session reopens by id", reopened.id === session.id && reopened.title === "kept" && reopened.status === "idle");
    const second = await run(running.client, session.id, "what was the word?", { timeoutMs: 10_000 });
    check("restart: the next message runs", second.output === "second answer");
    check("restart: and the model saw the earlier conversation", seen[1]?.includes("pelican") === true);
    const history = (await running.client.sessions.events.list(session.id)).data;
    check("restart: the history spans both processes", history.filter((e) => e.type === "agent.message").length === 2);

    // ── delete ───────────────────────────────────────────────────────────────────
    const deleted = await running.client.sessions.delete(session.id);
    check("delete: confirms", deleted.type === "session_deleted" && deleted.id === session.id);
    check("delete: gone", (await failure(() => running.client.sessions.retrieve(session.id)))?.status === 404);
  } finally {
    await running.stop();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ MANAGED HTTP E2E PASS");
}

await main();
