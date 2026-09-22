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
import { SkillRegistry, skillsCapability, type AgentEvent, type SkillActivationResult } from "operon-agents-core";

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

async function skillReceiptsTrackConsumption(): Promise<void> {
  const faux = registerFauxProvider();
  const registry = new SkillRegistry();
  registry.registerBuiltinSkill({ name: "review", description: "Review code", path: "builtin/review", dir: "builtin", content: "Review the code.", metadata: {}, source: "builtin" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdModel = false;
  const harness = createHarness({
    model: faux.getChatModel()!,
    session: () => [skillsCapability({ registry, scan: false })],
    extensions: [{
      id: "skill-receipt-gate",
      session(api) {
        api.on("model.request", async () => {
          if (!holdModel) return;
          entered.resolve();
          await release.promise;
        });
      },
    }],
  });
  try {
    const session = await harness.createSession();
    const events: AgentEvent[] = [];
    session.onEvent((event) => { events.push(event); });
    const assertConsumed = (label: string, activation: SkillActivationResult): void => {
      check(`${label}: returns a message id without a speculative turn id`, typeof activation.steerId === "string" && !("turnId" in activation));
      check(`${label}: receipt matches the queued event`, events.some((event) => event.type === "steer.queued" && event.steerId === activation.steerId));
      check(`${label}: receipt matches exactly one consumed message`, events.filter((event) => event.type === "message.appended" && event.origin && "steerId" in event.origin && event.origin.steerId === activation.steerId).length === 1);
    };

    faux.setResponses([fauxAssistantMessage("reviewed both", { stopReason: "stop" })]);
    const gate = session.holdAtBoundary();
    const activations = await Promise.all([session.skills.activateSkill({ name: "review" }), session.skills.activateSkill({ name: "review" })]);
    check("skills idle: separate activations have distinct message ids", activations[0]!.steerId !== activations[1]!.steerId);
    gate.release();
    await session.whenIdle();
    activations.forEach((activation, index) => assertConsumed(`skills idle ${index}`, activation));
    check("skills idle: queued activations share one real turn", events.filter((event) => event.type === "turn.started").length === 1);

    faux.setResponses([fauxAssistantMessage("first step", { stopReason: "stop" }), fauxAssistantMessage("reviewed mid-turn", { stopReason: "stop" })]);
    holdModel = true;
    const running = session.prompt("start work");
    await entered.promise;
    const activation = await session.skills.activateSkill({ name: "review" });
    holdModel = false;
    release.resolve();
    const result = await running;
    assertConsumed("skills running", activation);
    check("skills running: activation is consumed within the active turn", result.output === "reviewed mid-turn" && events.filter((event) => event.type === "turn.started").length === 2);
  } finally {
    release.resolve();
    await harness.close();
    faux.unregister();
  }
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
  session.onEvent((event) => { events.push(event); });

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
  await skillReceiptsTrackConsumption();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ HARNESS STEER E2E PASS");
}

main().catch((error) => {
  console.error("❌ HARNESS STEER E2E ERROR:", error);
  process.exit(1);
});
