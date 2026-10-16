/**
 * A background task outlives the turn that started it, and it lives in the session OBJECT the
 * worker opened. Closing that object on idle used to orphan the task: the next open — the next
 * message, on any node — reconciled it to `lost` while it was still running on this one.
 *
 * Covers:
 *  - the worker keeps the session (and its lease) while a background task is live, so the task's
 *    completion reaches the model in a follow-up run instead of being declared lost;
 *  - a later message reopens the session without anything being marked `lost`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHarness,
  DiskSessionRepository,
  LocalEnvironment,
  type AgentEvent,
} from "operon-agents";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { MemoryManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => (p as { type?: string }).type === "text").map((p) => (p as { text: string }).text).join("");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "background-hold-"));
  const work = join(root, "work");
  mkdirSync(work);
  const faux = registerFauxProvider();
  const repository = new DiskSessionRepository(root);
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: work }) };
  const harness = createHarness({
    harness: () => ({ sessionRepository: repository, environment: new LocalEnvironment(work) }),
    model: faux.getChatModel(),
    permission: { mode: "yolo" },
  });
  const sessionWork = new MemorySessionWork({ repository });
  const service = new SessionService({ repository, metadataStore, environments, work: sessionWork });
  const worker = new SessionWorker({ profile: "single-tenant", harness, repository, metadataStore, environments, work: sessionWork, renewIntervalMs: 30 });
  const events = async (id: string): Promise<readonly AgentEvent[]> => (await service.listEvents(id, { limit: 500 })).data;
  const assistants = async (id: string): Promise<string[]> =>
    (await events(id))
      .filter((e) => e.type === "message.appended" && e.message.role === "assistant")
      .map((e) => (e.type === "message.appended" ? textOf(e.message.content) : ""));
  // Background settles reach the model as queued steers; those are durable, the live
  // `background.task.terminated` events are not.
  const notices = async (id: string): Promise<string[]> =>
    (await events(id))
      .filter((e) => e.type === "steer.queued")
      .map((e) => textOf((e as { message?: { content?: unknown } }).message?.content))
      .filter((text) => text.includes("<background-task-done"));

  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Bash", { command: "sleep 0.6; printf bg-finished", run_in_background: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("started it", { stopReason: "stop" }),
      fauxAssistantMessage("saw it finish", { stopReason: "stop" }),
      fauxAssistantMessage("next answer", { stopReason: "stop" }),
    ]);
    const session = await service.create({ agent: "default", environment: "default" });
    await service.appendEvent(session.id, { input: "run it in the background" });
    await worker.drain(session.id);

    const settled = await notices(session.id);
    check("hold: the background task completed while the worker held the session", settled.length === 1 && settled[0]!.includes("completed"));
    check("hold: its completion reached the model in a follow-up run", (await assistants(session.id)).includes("saw it finish"));

    await service.appendEvent(session.id, { input: "and now?" });
    await worker.drain(session.id);
    check("reopen: the next message ran", (await assistants(session.id)).includes("next answer"));
    check("reopen: nothing was marked lost", !(await notices(session.id)).some((text) => text.includes("marked lost")));
  } finally {
    await harness.close();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ BACKGROUND HOLD E2E PASS");
}

await main();
