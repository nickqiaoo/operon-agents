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
import { createHarness, LocalEnvironment } from "operon-agents";
import { DiskSessionRepository } from "operon-agents/advanced";
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

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "background-hold-"));
  const work = join(root, "work");
  mkdirSync(work);
  const faux = registerFauxProvider();
  const repository = new DiskSessionRepository(join(root, "sessions"));
  const metadataStore = new MemoryManagedSessionMetadataStore();
  const environments: ManagedEnvironmentRegistry = { resolve: () => ({ workDir: work }) };
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(work) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const sessionWork = new MemorySessionWork();
  const service = new SessionService({ metadataStore, work: sessionWork });
  const worker = new SessionWorker({
    profile: "single-tenant", harness, repository, metadataStore, environments, work: sessionWork,
    renewIntervalMs: 30, claimIntervalMs: 20, inputPollIntervalMs: 20,
  });
  const answers = async (id: string): Promise<string[]> =>
    (await service.listEvents(id, { limit: 500 })).data.flatMap((e) => e.type === "agent.message" ? [e.content.map((b) => b.text).join("")] : []);
  // Background settles reach the model as queued steers in the runtime's own journal; they are
  // the runtime's business, so the check reads that journal directly.
  const notices = async (id: string): Promise<string[]> => {
    const handle = await repository.open(id);
    if (handle === undefined) return [];
    try {
      const page = await handle.store.readRecordPage({ limit: 1000 });
      return page.data.map((r) => JSON.stringify(r.record)).filter((text) => text.includes("background-task-done"));
    } finally {
      await handle.store.close?.();
    }
  };
  const until = async (condition: () => Promise<boolean>, ms = 8_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await condition()) return true;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return condition();
  };

  try {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Bash", { command: "sleep 0.6; printf bg-finished", run_in_background: true }), { stopReason: "toolUse" }),
      fauxAssistantMessage("started it", { stopReason: "stop" }),
      fauxAssistantMessage("saw it finish", { stopReason: "stop" }),
      fauxAssistantMessage("next answer", { stopReason: "stop" }),
    ]);
    worker.start();
    const session = await service.create({
      agent: "default", environment_id: "default",
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "run it in the background" }] }],
    });
    check("hold: its completion reached the model in a follow-up run", await until(async () => (await answers(session.id)).includes("saw it finish")));
    const settled = await notices(session.id);
    check("hold: the background task completed while the worker held the session", settled.length > 0 && settled.some((t) => t.includes("completed")));

    await until(async () => (await service.retrieve(session.id)).status === "idle" && !(await sessionWork.peek(session.id)));
    await service.sendEvents(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "and now?" }] }] });
    check("reopen: the next message ran", await until(async () => (await answers(session.id)).includes("next answer")));
    check("reopen: nothing was marked lost", !(await notices(session.id)).some((text) => text.includes("marked lost")));
  } finally {
    await worker.stop();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ BACKGROUND HOLD E2E PASS");
}

await main();
