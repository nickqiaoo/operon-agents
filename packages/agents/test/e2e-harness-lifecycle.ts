/**
 * HarnessSession lifecycle: cancel reaches EVERY accepted run (in flight and queued), a queued
 * run cancelled before it takes the run lock never touches the session, and the closed checks
 * cover every run entry point (prompt, resume, promptStream).
 */
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineAgent } from "operon-agents-core";
import { createHarness, tool } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingAfter = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  const MARKER = Symbol("pending");
  return (await Promise.race([promise.then(() => "settled", () => "settled"), sleep(ms).then(() => MARKER)])) === MARKER;
};

/** A tool that parks until released, and records when it enters its finally. */
function holdTool(log: string[]) {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const enteredFinally = new Promise<void>((resolve) => { entered = resolve; });
  const t = tool({
    name: "Hold",
    description: "Park until released.",
    parameters: z.object({}),
    execute: async () => {
      log.push("hold:start");
      try {
        await released;
        return "released";
      } finally {
        log.push("hold:finally");
        entered();
      }
    },
  });
  return { tool: t, release, enteredFinally };
}

async function cancelCoversQueuedRuns(): Promise<void> {
  const faux = registerFauxProvider();
  const log: string[] = [];
  const hold = holdTool(log);
  const model = faux.getChatModel()!;
  const harness = createHarness({ model, permission: { mode: "yolo" } });
  const session = await harness.createSession({ agent: defineAgent({ name: "holder", model, instructions: "x", tools: [hold.tool] }) });
  let started = 0;
  session.onEvent((event) => { if (event.type === "agent.started") started += 1; });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("first done", { stopReason: "stop" }),
    fauxAssistantMessage("second done", { stopReason: "stop" }),
  ]);
  const first = session.prompt("first");
  await sleep(30);
  check("cancel: the first run is parked inside its tool", log.includes("hold:start"));
  const second = session.prompt("second (queued behind the run lock)");
  await sleep(30);
  check("cancel: the session reports running with a run queued", session.status.state === "running");
  check("cancel: the queued run has not started (no second agent.started)", started === 1);

  session.cancel();
  // The run lock's wait is not abortable (a mid-chain bail-out would break mutual exclusion):
  // the queued run stays parked until the lock frees, then bails on acquiring it.
  check("cancel: the queued run stays parked on the lock while the in-flight tool holds it", await pendingAfter(second, 60));
  hold.release();
  const firstResult = await first;
  let secondError: unknown;
  await second.catch((error) => { secondError = error; });
  check("cancel: the queued run is rejected with an AbortError once the lock frees", secondError instanceof Error && secondError.name === "AbortError");
  check("cancel: the in-flight run settles as aborted once its tool returns", firstResult.status === "aborted");
  check("cancel: the queued run never emitted agent.started", started === 1);
  check("cancel: idle afterwards", session.status.state === "idle");
  await harness.close();
  faux.unregister();
}

async function closedChecksOnEveryEntry(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
  const session = await harness.createSession();
  await session.close();
  let promptThrew = false;
  await session.prompt("x").catch(() => { promptThrew = true; });
  check("closed: prompt rejects", promptThrew);
  let resumeThrew = false;
  await session.resume({}).catch((error: Error) => { resumeThrew = /closed/.test(error.message); });
  check("closed: resume rejects with the closed error (not 'no interrupted run')", resumeThrew);
  let streamThrew = false;
  try {
    session.promptStream("x");
  } catch (error) {
    streamThrew = error instanceof Error && /closed/.test(error.message);
  }
  check("closed: promptStream throws the closed error", streamThrew);
  await harness.close();
  faux.unregister();
}

async function main(): Promise<void> {
  await cancelCoversQueuedRuns();
  await closedChecksOnEveryEntry();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
