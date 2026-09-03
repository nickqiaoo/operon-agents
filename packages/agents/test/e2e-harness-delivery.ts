import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import type { AgentEvent } from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("delivered", { stopReason: "stop" }),
    fauxAssistantMessage("first response", { stopReason: "stop" }),
    fauxAssistantMessage("steer response", { stopReason: "stop" }),
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
      id: "delivery-gate",
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

  check("delivery: new session is idle", session.status.state === "idle");
  const receipt = await session.deliver("review this", {
    source: "team.hub",
    actor: "agent-a",
    metadata: { messageId: "m1" },
  });
  check("delivery: idle target is running once the receipt exists", receipt.status === "started" && session.status.state === "running");
  const result = await receipt.completion!;
  check("delivery: started turn completes", result.output === "delivered" && session.status.state === "idle");
  const appended = events.find((event) => event.type === "message.appended" && event.origin?.kind === "external");
  check(
    "delivery: provenance survives onto message.appended",
    appended?.type === "message.appended" && appended.origin?.kind === "external" &&
      appended.origin.deliveryId === receipt.deliveryId && appended.origin.actor === "agent-a",
  );
  check("delivery: accepted event is correlated", events.some((event) => event.type === "delivery.accepted" && event.deliveryId === receipt.deliveryId));

  gateActive = true;
  const running = session.prompt("begin long turn");
  await gateEntered;
  const queued = await session.deliver("new peer context", { source: "team.hub", actor: "agent-b" });
  check("delivery: running target queues to steering", queued.status === "queued" && queued.channel === "steering" && typeof queued.steerId === "string");
  gateActive = false;
  releaseGate?.();
  const runningResult = await running;
  check("delivery: queued steer is consumed in the active run", runningResult.output === "steer response");
  check(
    "delivery: queued provenance is correlated at consumption",
    events.some((event) => event.type === "message.appended" && event.origin?.kind === "external" && event.origin.deliveryId === queued.deliveryId && event.origin.steerId === queued.steerId),
  );

  await harness.close();
  faux.unregister();
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ HARNESS DELIVERY E2E PASS");
}

main().catch((error) => {
  console.error("❌ HARNESS DELIVERY E2E ERROR:", error);
  process.exit(1);
});
