import { T } from "operon-agents";
/**
 * `run()` over a real server: the synchronous shape on top of an asynchronous protocol.
 *
 * What matters here is the failure modes it absorbs, not the happy path. A caller writing this
 * loop by hand has to open the stream before sending, keep going past a transient idle, notice
 * that a pause needing an answer is not an ending, and refuse to wait forever when it cannot
 * answer. Each check below is one of those.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "operon-agents";
import {
  createHarness,
  DiskSessionRepository,
  LocalMachine,
} from "operon-agents";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import {
  allowAllRequests,
  createManagedHttpServer,
  MemoryManagedSessionMetadataStore,
  MemorySessionWork,
  SessionService,
  SessionWorker,
  StaticEnvironmentRegistry,
} from "../src/server/index.ts";
import { ManagedAgentsClient, run, RunInterruptedError } from "../src/client/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "client-run-"));
  const work = join(root, "work");
  const faux = registerFauxProvider();

  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments = new StaticEnvironmentRegistry({ workspace: { workDir: work } });
  const harness = createHarness({
    harness: (s) => {
      s.register(T.SessionRepository, repository, { owned: false });
      s.register(T.MachineFactory, new LocalMachine(work), { owned: false });
    },
    model: faux.getChatModel(),
    // `manual` with no approval handler registered anywhere is what makes a tool call pause
    // durably: there is no live responder to ask, so the run persists the request and stops.
    permission: { mode: "manual" },
  });
  const sessionWork = new MemorySessionWork({ repository });
  const worker = new SessionWorker({ harness, repository, metadataStore, environments, work: sessionWork });
  const service = new SessionService({ repository, work: sessionWork, metadataStore, environments });
  const managed = createManagedHttpServer({ service, worker, authorize: allowAllRequests, heartbeatMs: 50 });
  await managed.listen(0, "127.0.0.1");
  const address = managed.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  const client = new ManagedAgentsClient({ baseUrl: `http://127.0.0.1:${String(address.port)}/v1` });

  // ── a plain run resolves with the agent's answer ───────────────────────────────
  faux.setResponses([fauxAssistantMessage("the answer is 42", { stopReason: "stop" })]);
  const simple = await client.sessions.create({ agent: "default", environment: "workspace" });
  const result = await run(client, simple.id, "what is the answer?", { timeoutMs: 20_000 });
  check("run: resolves with the assistant's output", result.output === "the answer is 42");
  check("run: collected the events it saw", result.events.length > 0);
  check("run: nothing needed answering", result.interruptionsAnswered === 0);

  await managed.close();
  await harness.close();
  faux.unregister();
  rmSync(root, { recursive: true, force: true });

  // ── the interruption paths, driven against a scripted client ──────────────────
  // A durable pause is awkward to provoke through a live model on demand, and what needs
  // testing is run()'s control flow, not the engine's ability to pause. Scripting the two
  // responses run() keys off — the event stream and the interruptions list — exercises the
  // decisions directly: that a pause is not an ending, and that being unable to answer one
  // fails immediately instead of waiting.
  await interruptionPaths();


  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ CLIENT RUN E2E PASS");
}

/**
 * A client whose stream and interruption list are scripted.
 *
 * The stream is ONE iterable for the whole run, the way the real client's is: it does not end
 * at a pause, so `run` must not depend on reopening it. Events are released in phases — the
 * next phase is handed over when `run` calls `resume` — which is how the script models a
 * continuation that only happens because an answer arrived.
 */
function scriptedClient(script: {
  readonly phases: ReadonlyArray<readonly AgentEvent[]>;
  readonly interruptions: ReadonlyArray<readonly unknown[]>;
  readonly deliveryId?: string;
}): { client: ManagedAgentsClient; order: string[]; resumed: unknown[] } {
  const order: string[] = [];
  const resumed: unknown[] = [];
  let interruptIndex = 0;
  let phase = 0;
  // One gate per phase, opened by the resume() that follows it.
  const gates = script.phases.map(() => {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  });
  const client = {
    sessions: {
      events: {
        stream: async (_id: string) => {
          order.push("stream");
          return {
            [Symbol.asyncIterator]: async function* () {
              for (let index = 0; index < script.phases.length; index += 1) {
                for (const e of script.phases[index]!) yield e;
                await gates[index]!.opened;
              }
            },
          };
        },
      },
      messages: {
        create: async () => {
          order.push("send");
          return { status: "queued", deliveryId: script.deliveryId ?? "d1" };
        },
      },
      interruptions: async () => ({ data: script.interruptions[interruptIndex++] ?? [] }),
      resume: async (_id: string, answers: unknown) => {
        order.push("resume");
        resumed.push(answers);
        gates[phase]?.open();
        phase += 1;
        return { accepted: true as const };
      },
      retrieve: async (id: string) => ({ id }),
    },
  } as unknown as ManagedAgentsClient;
  return { client, order, resumed };
}

async function interruptionPaths(): Promise<void> {
  const ev = (body: Record<string, unknown>, eventId: string): AgentEvent =>
    ({ ...body, address: "main", sessionId: "s", eventId }) as unknown as AgentEvent;
  const external = { kind: "external", source: "managed-api", deliveryId: "d1" };
  const assistant = (text: string, eventId: string): AgentEvent =>
    ev({ type: "message.appended", message: { role: "assistant", content: [{ type: "text", text }] } }, eventId);

  // History first: a previous turn with its own answer. Trap 2 — none of this may count.
  const history = [
    ev({ type: "turn.started", turnId: "t0" }, "h1"),
    assistant("an old answer", "h2"),
    ev({ type: "turn.ended", turnId: "t0", reason: "completed" }, "h3"),
  ];
  const ourTurn = [
    ev({ type: "turn.started", turnId: "t1", origin: external }, "e1"),
    ev({ type: "turn.ended", turnId: "t1", reason: "completed" }, "e2"),
  ];
  const continuation = [
    ev({ type: "turn.started", turnId: "t2" }, "e3"),
    assistant("after resume", "e4"),
    ev({ type: "turn.ended", turnId: "t2", reason: "completed" }, "e5"),
  ];

  // Paused once, then finished: run must answer and keep going rather than returning at the
  // first turn boundary — and must not return at the OLD turn boundary in the replay.
  const paused = scriptedClient({
    phases: [[...history, ...ourTurn], continuation],
    interruptions: [[{ approvalId: "a1" }], []],
  });
  const result = await run(paused.client, "s", "go", {
    onInterrupt: () => Promise.resolve({ a1: { decision: "approve" } }),
  });
  check("run: a pause is not an ending — it answers and continues", result.interruptionsAnswered === 1);
  check("run: the continuation's output is returned, not the replayed old answer", result.output === "after resume");
  check("run: opens the stream once, before sending, and keeps it across the pause", paused.order.join(",") === "stream,send,resume");
  check("run: the caller's answers reach resume", JSON.stringify(paused.resumed[0]) === JSON.stringify({ a1: { decision: "approve" } }));

  // A steer: our delivery lands inside a turn that was already running.
  const steered = scriptedClient({
    phases: [[
      ev({ type: "turn.started", turnId: "t5" }, "s1"),
      ev({ type: "message.appended", message: { role: "user", content: "go" }, origin: external }, "s2"),
      assistant("steered answer", "s3"),
      ev({ type: "turn.ended", turnId: "t5", reason: "completed" }, "s4"),
    ]],
    interruptions: [[]],
  });
  const steeredResult = await run(steered.client, "s", "go");
  check("run: a delivery steered into a running turn ends with that turn", steeredResult.output === "steered answer");

  // The same pause with no handler must reject rather than wait.
  const unhandled = scriptedClient({ phases: [ourTurn], interruptions: [[{ approvalId: "a1" }]] });
  let rejected = false;
  try {
    await run(unhandled.client, "s", "go");
  } catch (error) {
    rejected = error instanceof RunInterruptedError;
  }
  check("run: without onInterrupt a pause rejects immediately", rejected);
}

await main();
