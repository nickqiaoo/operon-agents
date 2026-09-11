/**
 * One entry point for a message from outside the session, whatever its state.
 *
 * `steerTo` on an idle session wakes it; on a running one it buffers for the next step
 * boundary. Either way the enqueue is journaled as `steer.queued` before the receipt's
 * `journaled` settles, and the consuming `message.appended` carries the same `steerId` — so a
 * caller can hand the receipt to someone else and later tell whether the model saw the message.
 */
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import type { AgentEvent } from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: string }).text ?? "").join("");
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("answered the peer", { stopReason: "stop" }),
    fauxAssistantMessage("first response", { stopReason: "stop" }),
    fauxAssistantMessage("steer response", { stopReason: "stop" }),
    fauxAssistantMessage("own words", { stopReason: "stop" }),
  ]);
  let gateActive = false;
  let enteredGate: (() => void) | undefined;
  let releaseGate: (() => void) | undefined;
  const gateEntered = new Promise<void>((resolve) => { enteredGate = resolve; });
  const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [{
      id: "steer-gate",
      session(api) {
        api.on("model.request", async () => {
          if (!gateActive) return;
          enteredGate?.();
          await gateRelease;
        });
      },
    }],
  });
  const session = await harness.createSession();
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));

  // ── idle target: woken ────────────────────────────────────────────────────────
  check("steer: new session is idle", session.status.state === "idle");
  const receipt = session.steerTo("main", "review this", {
    kind: "external",
    source: "team.hub",
    actor: "agent-a",
    metadata: { messageId: "m1" },
    channel: "steering",
  });
  check("steer: an idle target is woken", receipt !== undefined && receipt.wakeTurnId !== null && receipt.channel === "steering");
  await receipt!.journaled;
  check(
    "steer: the enqueue is journaled before the receipt settles",
    events.some((event) => event.type === "steer.queued" && event.steerId === receipt!.steerId && event.origin.kind === "external"),
  );
  await session.whenIdle();
  check("steer: the woken turn ran to completion", session.status.state === "idle");
  const appended = events.find((event) => event.type === "message.appended" && event.origin?.kind === "external");
  check(
    "steer: provenance survives onto message.appended under the same steer id",
    appended?.type === "message.appended" && appended.origin?.kind === "external" &&
      appended.origin.steerId === receipt!.steerId && appended.origin.actor === "agent-a",
  );
  const answers = events.filter((event) => event.type === "message.appended" && event.message.role === "assistant");
  check("steer: the turn answered", answers.length === 1 && answers[0]!.type === "message.appended" && textOf(answers[0]!.message.content) === "answered the peer");

  // ── running target: buffered, consumed in the active run ──────────────────────
  gateActive = true;
  const running = session.prompt("begin long turn");
  await gateEntered;
  const queued = session.steerTo("main", "new peer context", { kind: "external", source: "team.hub", actor: "agent-b", channel: "steering" });
  check("steer: a running target buffers instead of waking", queued !== undefined && queued.wakeTurnId === null && queued.channel === "steering");
  await queued!.journaled;
  gateActive = false;
  releaseGate?.();
  const runningResult = await running;
  check("steer: the buffered steer is consumed in the active run", runningResult.output === "steer response");
  check(
    "steer: consumption is correlated by steer id",
    events.some((event) => event.type === "message.appended" && event.origin?.kind === "external" && event.origin.steerId === queued!.steerId),
  );

  // ── the user's own steer: same receipt, same journal ──────────────────────────
  const own = session.steer("and my own note");
  await own.journaled;
  check("steer: a user steer returns the same receipt shape", own.channel === "steering" && typeof own.steerId === "string");
  check(
    "steer: a user steer is journaled as steer.queued too",
    events.some((event) => event.type === "steer.queued" && event.steerId === own.steerId && event.origin.kind === "user"),
  );
  await session.whenIdle();
  check(
    "steer: the user's words reach the model bare",
    events.some((event) => event.type === "message.appended" && event.origin?.kind === "user" && event.origin.steerId === own.steerId && textOf(event.message.content) === "and my own note"),
  );

  await harness.close();
  faux.unregister();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ HARNESS STEER E2E PASS");
}

main().catch((error) => {
  console.error("❌ HARNESS STEER E2E ERROR:", error);
  process.exit(1);
});
