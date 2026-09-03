import { T } from "operon-agents";
/**
 * Control commands travel the same way inputs do: written to the log, acted on by whoever
 * holds the session, picked up by the next holder when nobody does.
 *
 * The alternative — calling into the worker on the node a request happened to reach — made
 * cancel return 202 on the wrong node while cancelling nothing, and made resume fail on any
 * node without a worker. Each check here is a case that design could not express.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  DiskSessionRepository,
  LocalMachine,
  type AgentEvent,
} from "operon-agents";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";
import { allowAllRequests, createManagedHttpServer } from "../src/server/http-server.ts";
import { ManagedAgentsClient } from "../src/client/client.ts";
import { ManagedApiClientError } from "../src/client/errors.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(name: string, options: { readonly permission?: "yolo" | "manual" } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const work = join(root, "work");
  const faux = registerFauxProvider();
  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: work }) };
  const harness = createHarness({
    harness: (s) => {
      s.register(T.SessionRepository, repository, { owned: false });
      s.register(T.MachineFactory, new LocalMachine(work), { owned: false });
    },
    model: faux.getChatModel(),
    permission: { mode: options.permission ?? "yolo" },
  });
  const sessionWork = new MemorySessionWork({ repository });
  const service = new SessionService({ repository, metadataStore, environments, work: sessionWork });
  // A short heartbeat: it is what carries a cancel from another node to the holder.
  const worker = new SessionWorker({ harness, repository, metadataStore, environments, work: sessionWork, renewIntervalMs: 30 });
  const events = async (id: string): Promise<readonly AgentEvent[]> => (await service.listEvents(id, { limit: 500 })).data;
  const assistants = async (id: string): Promise<string[]> =>
    (await events(id))
      .filter((e) => e.type === "message.appended" && e.message.role === "assistant")
      .map((e) => (e.type === "message.appended" ? textOf(e.message.content) : ""));
  const cleanup = async (): Promise<void> => {
    await harness.close();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, work, faux, repository, metadataStore, environments, harness, sessionWork, service, worker, events, assistants, cleanup };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => (p as { type?: string }).type === "text").map((p) => (p as { text: string }).text).join("");
}

/** Nobody is running the session: a cancel must discard the inputs ahead of it and keep the ones behind. */
async function cancelWithNoHolder(): Promise<void> {
  const f = fixture("control-idle");
  f.faux.setResponses([fauxAssistantMessage("answer to B", { stopReason: "stop" })]);
  const session = await f.service.create({ agent: "default", environment: "default" });
  await f.service.appendEvent(session.id, { input: "A — should be discarded" });
  const receipt = await f.service.requestCancel(session.id);
  check("cancel: accepted with a command id while nobody holds the session", receipt.accepted && receipt.commandId.startsWith("cmd_"));
  await f.service.appendEvent(session.id, { input: "B — should run" });
  await f.worker.drain(session.id);
  const answers = await f.assistants(session.id);
  check("cancel: the input ahead of the cancel never ran", !(await f.events(session.id)).some((e) => e.type === "message.appended" && e.origin?.kind === "external" && textOf(e.message.content).includes("A —")));
  check("cancel: the input behind the cancel ran", answers.length === 1 && answers[0] === "answer to B");

  // A cancel with nothing ahead of it is a no-op that must not wedge the session.
  await f.service.requestCancel(session.id);
  await f.worker.drain(session.id);
  check("cancel: a cancel with nothing to cancel is stepped over", (await f.sessionWork.claim()) === undefined);
  await f.cleanup();
}

/** The holder is mid-turn: its feed loop must see the cancel and stop the turn. */
async function cancelMidTurn(): Promise<void> {
  const f = fixture("control-running");
  let released: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  f.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage("too late", { stopReason: "stop" });
    },
    fauxAssistantMessage("after the cancel", { stopReason: "stop" }),
  ]);
  const session = await f.service.create({ agent: "default", environment: "default" });
  await f.service.appendEvent(session.id, { input: "slow question" });
  const draining = f.worker.drain(session.id);
  // Let the turn get going, then cancel from "another node": no worker reference, just the log.
  await sleep(150);
  const other = new SessionService({ repository: f.repository, metadataStore: f.metadataStore, environments: f.environments, work: f.sessionWork });
  await other.requestCancel(session.id);
  await sleep(200);
  released();
  await draining;
  const ends = (await f.events(session.id)).filter((e) => e.type === "turn.ended");
  // The model's reply was released only after the cancel; a turn that was really stopped
  // never received it. (The runner stamps `reason: "completed"` on an aborted model step too,
  // so the reason is not the signal here — the missing reply is.)
  check("cancel: the running turn was stopped before its reply", ends.length === 1 && !(await f.assistants(session.id)).includes("too late"));
  // And the session is usable afterwards.
  await f.service.appendEvent(session.id, { input: "next" });
  await f.worker.drain(session.id);
  check("cancel: a later input runs in a fresh turn", (await f.assistants(session.id)).includes("after the cancel"));
  await f.cleanup();
}

/**
 * A durable interruption answered through the log. The worker that paused is gone (closed);
 * a different worker reads the answer record and continues the run.
 */
async function resumeThroughTheLog(): Promise<void> {
  const f = fixture("control-resume", { permission: "manual" });
  const file = join(f.work, "approved.txt");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "ok\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("wrote it", { stopReason: "stop" }),
  ]);
  const session = await f.service.create({ agent: "default", environment: "default" });
  await f.service.appendEvent(session.id, { input: "write the file" });
  await f.worker.drain(session.id);
  const pending = await f.service.interruptions(session.id);
  check("resume: the turn paused durably on the approval", pending.length === 1 && pending[0]!.toolName === "Write");
  check("resume: the session reports interrupted", (await f.service.get(session.id)).state === "interrupted");

  // New input is refused while paused; the answer is accepted and journaled.
  let refused = false;
  try { await f.service.appendEvent(session.id, { input: "more" }); } catch { refused = true; }
  check("resume: new input is refused while interrupted", refused);
  const receipt = await f.service.answerInterruption(session.id, { [pending[0]!.toolCallId]: { decision: "approved" } as never });
  check("resume: the answer is accepted as a command", receipt.accepted);

  // A different worker — the one that paused could be on any node, or dead.
  const other = new SessionWorker({
    harness: f.harness, repository: f.repository, metadataStore: f.metadataStore, environments: f.environments, work: f.sessionWork,
  });
  await other.drain(session.id);
  check("resume: another worker continued the run from the journaled answer", (await f.assistants(session.id)).includes("wrote it"));
  check("resume: the session is idle again", (await f.service.get(session.id)).state === "idle");
  let conflict = false;
  try { await f.service.answerInterruption(session.id, {}); } catch { conflict = true; }
  check("resume: answering with nothing paused is a conflict", conflict);
  await f.cleanup();
}

/** Over HTTP, on a node with NO worker: every control route is a write, so all of them work. */
async function httpWithoutWorker(): Promise<void> {
  const f = fixture("control-http");
  f.faux.setResponses([fauxAssistantMessage("answer", { stopReason: "stop" })]);
  const server = createManagedHttpServer({ service: f.service, authorize: allowAllRequests });
  await server.listen(0, "127.0.0.1");
  const address = server.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  const client = new ManagedAgentsClient({ baseUrl: `http://127.0.0.1:${String(address.port)}/v1` });

  const session = await client.sessions.create({ agent: "default", environment: "default" });
  await client.sessions.messages.create(session.id, { input: "A" });
  const cancelled = await client.sessions.cancel(session.id);
  check("http: cancel is accepted on a node with no worker", cancelled.accepted && typeof cancelled.commandId === "string");
  let resumeStatus = 0;
  try { await client.sessions.resume(session.id, {}); } catch (error) { resumeStatus = error instanceof ManagedApiClientError ? error.status : 0; }
  check("http: resume on a node with no worker is judged by session state, not by worker presence", resumeStatus === 409);

  const gone = async (path: string, method = "GET"): Promise<number> =>
    (await fetch(`http://127.0.0.1:${String(address.port)}/v1/sessions/${session.id}/${path}`, { method })).status;
  check("http: tool detach is gone", (await gone("tools/x/detach", "POST")) === 404);
  check("http: background task routes are gone", (await gone("background-tasks")) === 404 && (await gone("background-tasks/t/output")) === 404);

  // The command is in the log: a worker anywhere will act on it.
  await f.worker.drain(session.id);
  check("http: the cancel written by the worker-less node discarded the input", (await f.assistants(session.id)).length === 0);
  await server.close();
  await f.cleanup();
}

async function main(): Promise<void> {
  await cancelWithNoHolder();
  await cancelMidTurn();
  await resumeThroughTheLog();
  await httpWithoutWorker();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ CONTROL E2E PASS");
}

await main();
