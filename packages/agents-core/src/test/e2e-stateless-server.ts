/**
 * The stateless-server contract — core `Runner` used WITHOUT the Harness.
 *
 * No long-lived Session: every "request" opens the session from the repository, builds a Runner
 * over that store, runs one turn, and closes what it opened. The next request repeats it from
 * scratch, so the conversation lives entirely in the store. This is the shape an embedded
 * backend (an HTTP route, a queue worker) wants, and this file is what keeps it working.
 *
 * Part 2 (`e2e-stateless-server-2.ts`) covers tools, durable resume, and concurrency.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent } from "../agent/agent.ts";
import { Runner } from "../agent/runner.ts";
import { DiskSessionRepository } from "../store/repository.ts";
import { LocalMachine } from "../tool/machine-local.ts";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type Context,
  type FauxResponseStep,
} from "./faux.ts";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "stateless-runner-"));
  const work = join(root, "work");
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  // The host's durable backend — the ONLY thing retained between requests.
  const repository = new DiskSessionRepository(root);
  const created = await repository.create({ workDir: work, ownerKey: "tenant-a" });
  const sessionId = created.id;
  await created.store.close?.();

  const agent = defineAgent({ name: "assistant", instructions: "Be terse.", model });

  // ── request 1 ───────────────────────────────────────────────────────────────
  faux.setResponses([() => fauxAssistantMessage("Hello there.", { stopReason: "stop" })]);
  const first = await handleRequest(sessionId, "hi");
  assert.equal(first.status, "completed", `request 1 status: ${first.status}`);

  // ── request 2 — a different process would do exactly this ───────────────────
  let secondContext: Context | undefined;
  const capture: FauxResponseStep = (context) => {
    secondContext = context;
    return fauxAssistantMessage("You said hi.", { stopReason: "stop" });
  };
  faux.setResponses([capture]);
  const second = await handleRequest(sessionId, "what did I just say?");
  assert.equal(second.status, "completed", `request 2 status: ${second.status}`);

  // Did request 2 see request 1? Check what the model was actually handed.
  const roles = (secondContext?.messages ?? []).map((m) => m.role);
  console.log(`request 2 context roles: ${roles.join(", ")}`);
  assert.ok(
    roles.filter((r) => r === "user").length >= 2,
    `history did not carry across requests; roles = ${roles.join(", ")}`,
  );

  // The durable log holds both turns independently of any live object.
  const reopened = await repository.open(sessionId);
  assert.ok(reopened, "session must reopen from the repository");
  const page = await reopened.store.readRecordPage({ limit: 100 });
  console.log(`log records: ${page.data.length}`);
  await reopened.store.close?.();

  faux.unregister();
  rmSync(root, { recursive: true, force: true });
  console.log("OK — stateless core Runner path works");

  /** One HTTP request's worth of work. Nothing above it survives the call. */
  async function handleRequest(id: string, input: string) {
    const opened = await repository.open(id);
    if (!opened) throw new Error(`no such session: ${id}`);
    try {
      const runner = new Runner({
        store: opened.store,
        machine: new LocalMachine(opened.workDir),
        permission: { mode: "yolo" },
      });
      return await runner.run(agent, input, { sessionId: id });
    } finally {
      await opened.store.close?.();
    }
  }
}

await main();
