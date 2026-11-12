/**
 * `run()` over a real server: the synchronous shape on top of an asynchronous protocol.
 *
 * What matters here is the failure modes it absorbs, not the happy path. A caller writing this
 * loop by hand has to open the stream before sending, ignore an idle that belongs to someone
 * else's turn, notice that `requires_action` is not an ending, and refuse to wait forever when
 * it cannot answer. Each check below is one of those.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, LocalEnvironment } from "operon-agents";
import { DiskSessionRepository } from "operon-agents/advanced";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  allowAllRequests,
  createManagedHttpServer,
  MemoryEventBroadcaster,
  MemoryManagedSessionMetadataStore,
  MemorySessionWork,
  SessionService,
  SessionWorker,
  StaticEnvironmentRegistry,
} from "../src/server/index.ts";
import { ManagedAgentsClient, run, RunInterruptedError } from "../src/client/index.ts";
import type { ManagedEventResource } from "../src/protocol/types.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "client-run-"));
  const work = join(root, "work");
  mkdirSync(work);
  const faux = registerFauxProvider();

  const repository = new DiskSessionRepository(join(root, "sessions"));
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments = new StaticEnvironmentRegistry({ workspace: { workDir: work } });
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(work) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "manual" } } }
  });
  const sessionWork = new MemorySessionWork();
  const broadcaster = new MemoryEventBroadcaster();
  const worker = new SessionWorker({
    profile: "single-tenant", harness, repository, metadataStore, environments, work: sessionWork, broadcaster,
    claimIntervalMs: 20, inputPollIntervalMs: 20,
  });
  worker.start();
  const service = new SessionService({ work: sessionWork, metadataStore, broadcaster });
  const managed = createManagedHttpServer({ service, authorize: allowAllRequests, heartbeatMs: 50 });
  await managed.listen(0, "127.0.0.1");
  const address = managed.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  const client = new ManagedAgentsClient({ baseUrl: `http://127.0.0.1:${String(address.port)}/v1` });

  try {
    // ── a plain run resolves with the agent's answer ─────────────────────────────
    faux.setResponses([fauxAssistantMessage("the answer is 42", { stopReason: "stop" })]);
    const simple = await client.sessions.create({ agent: "default", environment_id: "workspace" });
    const result = await run(client, simple.id, "what is the answer?", { timeoutMs: 20_000 });
    check("run: resolves with the agent's output", result.output === "the answer is 42");
    check("run: collected the events it saw", result.events.some((e) => e.type === "session.status_idle"));
    check("run: nothing needed answering", result.interruptionsAnswered === 0);

    // ── a pause is answered and the run continues ────────────────────────────────
    const file = join(work, "approved.txt");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "ok\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("wrote it", { stopReason: "stop" }),
    ]);
    const asked: string[] = [];
    const confirmed = await run(client, simple.id, "write the file", {
      timeoutMs: 20_000,
      onInterrupt: async ({ pending }) => pending.map((event) => {
        asked.push(event.type === "agent.tool_use" ? event.name : event.type);
        return { type: "user.tool_confirmation" as const, tool_use_id: event.id, result: "allow" as const };
      }),
    });
    check("run: requires_action is not an ending — it answers and continues", confirmed.interruptionsAnswered === 1 && confirmed.output === "wrote it");
    check("run: onInterrupt is handed the blocking tool use", asked.join() === "Write");
    let written = "";
    try { written = readFileSync(file, "utf8"); } catch { /* checked */ }
    check("run: the confirmed call ran", written === "ok\n");

    // ── the same pause with no handler rejects rather than waits ────────────────
    faux.setResponses([fauxAssistantMessage(fauxToolCall("Write", { path: join(work, "never.txt"), content: "x" }), { stopReason: "toolUse" })]);
    let rejected: unknown;
    try {
      await run(client, simple.id, "write another", { timeoutMs: 20_000 });
    } catch (error) {
      rejected = error;
    }
    check("run: without onInterrupt a pause rejects immediately", rejected instanceof RunInterruptedError && rejected.pending[0]?.type === "agent.tool_use");
  } finally {
    await managed.close();
    await worker.stop();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  }

  await someoneElsesIdle();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ CLIENT RUN E2E PASS");
}

/**
 * The session was already busy when we sent: the turn it was on ends idle BEFORE our message is
 * processed. Scripted, because what is under test is run()'s reading of the order, not the
 * engine's ability to produce it.
 */
async function someoneElsesIdle(): Promise<void> {
  const order: string[] = [];
  const event = (body: Record<string, unknown>, id: string): ManagedEventResource => ({ ...body, id, processed_at: null }) as ManagedEventResource;
  const ours = { type: "user.message", content: [{ type: "text", text: "go" }], id: "mine", processed_at: null };
  const client = {
    sessions: {
      events: {
        stream: async () => {
          order.push("stream");
          return {
            [Symbol.asyncIterator]: async function* () {
              yield event({ type: "agent.message", content: [{ type: "text", text: "an old answer" }] }, "o1");
              yield event({ type: "session.status_idle", stop_reason: { type: "end_turn" } }, "o2");
              yield { ...ours, processed_at: new Date().toISOString() } as ManagedEventResource;
              yield event({ type: "session.status_running" }, "n1");
              yield event({ type: "agent.message", content: [{ type: "text", text: "our answer" }] }, "n2");
              yield event({ type: "session.status_idle", stop_reason: { type: "end_turn" } }, "n3");
            },
          };
        },
        send: async () => {
          order.push("send");
          return { data: [ours] };
        },
      },
      retrieve: async (id: string) => ({ id }),
    },
  } as unknown as ManagedAgentsClient;
  const result = await run(client, "s", "go");
  check("run: an idle from the turn already running is not ours", result.output === "our answer");
  check("run: opens the stream before sending", order.join() === "stream,send");
}

await main();
