import { T } from "operon-agents";
/**
 * The two halves together: a service that only writes, a worker that only runs.
 *
 * Nothing connects them but the store and the work table. The service never sees the worker,
 * the worker is never called by a request, and a message becomes a turn because it was written
 * down — not because the writer knew who would execute it.
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
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "service-worker-"));
  const work = join(root, "work");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first answer", { stopReason: "stop" }),
    fauxAssistantMessage("second answer", { stopReason: "stop" }),
    fauxAssistantMessage("third answer", { stopReason: "stop" }),
  ]);

  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: work }) };
  const sessionWork = new MemorySessionWork({ repository });

  const service = new SessionService({ repository, work: sessionWork, environments, metadataStore });
  const harness = createHarness({
    harness: (s) => {
      s.register(T.SessionRepository, repository, { owned: false });
      s.register(T.MachineFactory, new LocalMachine(work), { owned: false });
    },
    model: faux.getChatModel(),
    permission: { mode: "yolo" },
  });
  const worker = new SessionWorker({ harness, repository, metadataStore, environments, work: sessionWork });

  // ── one message, one turn ─────────────────────────────────────────────────────
  const session = await service.create({ agent: "default", environment: "default" });
  const receipt = await service.appendEvent(session.id, { input: "first question" });
  check("accepted before any worker existed", receipt.status === "queued");

  const drained = await worker.drain(session.id);
  check("worker drained the session", drained);

  const events = await service.listEvents(session.id, { limit: 100 });
  const types = events.data.map((e) => e.type);
  check("acceptance is in history", types.includes("delivery.accepted"));
  const assistant = events.data.filter(
    (e) => e.type === "message.appended" && e.message.role === "assistant",
  );
  check("the worker's turn produced an assistant message", assistant.length === 1);
  // Count only what WE delivered: capabilities also inject user-role messages (environment
  // context, reminders), and those answer no delivery — ours carries the delivery it came in as.
  const delivered = (page: readonly AgentEvent[]): number =>
    page.filter((e) =>
      e.type === "message.appended"
      && (e.origin?.kind === "user" || e.origin?.kind === "user_follow_up" || e.origin?.kind === "external")
      && e.origin.deliveryId !== undefined).length;
  check("the accepted input entered the conversation exactly once", delivered(events.data) === 1);

  // ── draining again is a no-op: the cursor says it is done ─────────────────────
  await worker.drain(session.id);
  const after = await service.listEvents(session.id, { limit: 100 });
  check("re-draining does not replay the input", delivered(after.data) === 1);

  // ── a second message on the same session continues the conversation ───────────
  await service.appendEvent(session.id, { input: "second question" });
  await worker.drain(session.id);
  const second = await service.listEvents(session.id, { limit: 100 });
  const assistants = second.data.filter(
    (e) => e.type === "message.appended" && e.message.role === "assistant",
  ).length;
  check("a later message runs a second turn", assistants === 2);

  // ── the lease is what stops two workers ───────────────────────────────────────
  const other = new SessionWorker({ harness, repository, metadataStore, environments, work: sessionWork });
  const blocked = (await sessionWork.acquire(session.id))!;
  await service.appendEvent(session.id, { input: "third question" });
  const refused = await other.drain(session.id);
  check("a worker without the lease refuses to run", refused === false);
  const stillTwo = (await service.listEvents(session.id, { limit: 100 })).data.filter(
    (e) => e.type === "message.appended" && e.message.role === "assistant",
  ).length;
  check("the refused worker ran nothing", stillTwo === 2);

  // Release it and the pending input is still there to be picked up — it was never lost.
  await blocked.release();
  await other.drain(session.id);
  const third = (await service.listEvents(session.id, { limit: 100 })).data.filter(
    (e) => e.type === "message.appended" && e.message.role === "assistant",
  ).length;
  check("once the lease frees, the pending input runs", third === 3);

  await harness.close();
  faux.unregister();
  rmSync(root, { recursive: true, force: true });

  await cursorAdvancesOnceTheInputIsInTheConversation();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ SERVICE + WORKER E2E PASS");
}

/**
 * The cursor advances when the input is IN THE CONVERSATION — not when the turn that took it
 * finishes. That is the contract: an input is processed once the session's record holds it
 * and the next turn will see it. A turn that dies halfway leaves the history intact up to
 * where it stopped, and the next message continues from there; nothing is re-run.
 */
async function cursorAdvancesOnceTheInputIsInTheConversation(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cursor-timing-"));
  const work = join(root, "work");
  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: work }) };
  const faux = registerFauxProvider();

  const readCursor = async (id: string): Promise<unknown> => {
    const handle = await repository.open(id);
    const value = await handle!.store.getState("inbox:cursor");
    await handle!.store.close?.();
    return value;
  };

  let sessionId = "";
  let cursorMidTurn: unknown = "not-observed";
  faux.setResponses([async () => {
    // Long enough for the worker to have seen `message.appended` and persisted the cursor: by
    // now the user message is in the conversation, and the turn is still running.
    await new Promise((r) => setTimeout(r, 250));
    cursorMidTurn = await readCursor(sessionId);
    return fauxAssistantMessage("the reply", { stopReason: "stop" });
  }]);

  const harness = createHarness({
    harness: (s) => {
      s.register(T.SessionRepository, repository, { owned: false });
      s.register(T.MachineFactory, new LocalMachine(work), { owned: false });
    },
    model: faux.getChatModel(),
    permission: { mode: "yolo" },
  });
  const sessionWork = new MemorySessionWork({ repository });
  const worker = new SessionWorker({ harness, repository, metadataStore, environments, work: sessionWork });
  const service = new SessionService({ repository, work: sessionWork, metadataStore, environments });

  const session = await service.create({ agent: "default", environment: "default" });
  sessionId = session.id;
  await service.appendEvent(session.id, { input: "answer me" });
  await worker.drain(session.id);

  check("cursor advances while the turn is still running, once the input is in the conversation", typeof cursorMidTurn === "string");
  // And so a crash mid-turn would NOT re-run it: the inbox is already empty.
  check("after the turn, nothing is in line for a worker", (await sessionWork.claim()) === undefined);

  await harness.close();
  faux.unregister();
  rmSync(root, { recursive: true, force: true });
}

await main();
