/**
 * `Session.steerTo` — the whole seam an external coordinator needs to address a running subagent
 * (addressed to whoever is coordinating, not to the engine).
 *
 * The point of this test is what it does NOT use: no directory, no visibility policy, no Hub tool,
 * no peer origin. Everything a coordinator needs is already public — `agent.started` says who
 * exists and where, `steerTo` reaches them, and `external` origin carries the provenance. If this
 * passes, peer messaging does not belong in the engine.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { DiskSessionStore, ListenerSink, Runner, Session, defineAgent, replayContext } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/**
 * Each subagent gets its OWN SteerBus. Before this, `deriveChild` spread the parent's, so both
 * frames drained one queue — a user steer typed at the main session while a subagent was running
 * got eaten by the subagent, and the main agent never saw it.
 */
async function testSteerIsolation(root: string): Promise<void> {
  const store = new DiskSessionStore(join(root, "steer"));
  const session = await Session.open({ store });
  const runner = new Runner({});
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const helper = defineAgent({ name: "helper", model, instructions: "Help." });
  const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [helper] });

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "helper", prompt: "work on it", description: "work" }), { stopReason: "toolUse" }),
    // Fired from INSIDE the subagent's turn: this is the user typing at the main session while a
    // subagent happens to be running.
    () => {
      session.steer.steer("MAIN_ONLY_MESSAGE", { kind: "user" });
      return fauxAssistantMessage("child done", { stopReason: "stop" });
    },
    fauxAssistantMessage("parent continues", { stopReason: "stop" }),
    fauxAssistantMessage("acknowledged the steer", { stopReason: "stop" }),
  ]);
  const result = await runner.run(main, "spawn then steer", { session });
  faux.unregister();

  const agentId = /agent_id: ([a-zA-Z0-9_-]+)/.exec(JSON.stringify(result.messages))?.[1];
  const childHistory = JSON.stringify((await replayContext(store, `main/${agentId}`)).history);
  const parentHistory = JSON.stringify((await replayContext(store, "main")).history);

  check("steer: run completes", result.status === "completed");
  check("steer: the subagent did NOT consume the user's message", !childHistory.includes("MAIN_ONLY_MESSAGE"));
  check("steer: the main agent did", parentHistory.includes("MAIN_ONLY_MESSAGE"));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "e2e-steer-to-"));
  try {
    await testSteerIsolation(root);
    const store = new DiskSessionStore(join(root, "s"));
    const events = new ListenerSink();

    // A coordinator living entirely outside the engine: it learns the roster from events.
    const live = new Map<string, string>(); // agent name → address
    const ended: string[] = [];
    events.subscribe((event) => {
      if (event.type === "agent.started" && event.address !== undefined) live.set(event.agent, event.address);
      if (event.type === "agent.ended" && event.address !== undefined) ended.push(event.address);
    });

    const session = await Session.open({ store, events });
    const runner = new Runner({});
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    const helper = defineAgent({ name: "helper", model, instructions: "Help." });
    const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [helper] });

    let deliveredTo: string | undefined;
    let acceptedWhileRunning = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "helper", prompt: "work", description: "work" }), { stopReason: "toolUse" }),
      // Fired from inside the subagent's first turn — it is running, so its inbox is registered.
      () => {
        deliveredTo = live.get("helper");
        acceptedWhileRunning = session.steerTo(deliveredTo!, "MESSAGE_FOR_THE_CHILD", {
          kind: "external",
          source: "peer",
          deliveryId: "d1",
          actor: "some-other-agent",
          channel: "follow_up",
        });
        return fauxAssistantMessage("working", { stopReason: "stop" });
      },
      fauxAssistantMessage("saw the message", { stopReason: "stop" }),
      fauxAssistantMessage("subagent finished", { stopReason: "stop" }),
    ]);

    const result = await runner.run(main, "spawn a helper", { session });
    faux.unregister();

    const childHistory = JSON.stringify((await replayContext(store, deliveredTo ?? "main/none")).history);
    const parentHistory = JSON.stringify((await replayContext(store, "main")).history);

    check("run completes", result.status === "completed");
    check("roster: agent.started exposed the subagent's address", deliveredTo?.startsWith("main/helper-") === true);
    check("steerTo: a running frame accepts", acceptedWhileRunning);
    check("steerTo: the message landed in the SUBAGENT's conversation", childHistory.includes("MESSAGE_FOR_THE_CHILD"));
    check("steerTo: and not in the parent's", !parentHistory.includes("MESSAGE_FOR_THE_CHILD"));
    check("steerTo: provenance survives as an external message", childHistory.includes("source=") && childHistory.includes("peer"));

    // After the run, the frame is gone — an unreachable target must say so rather than pretend.
    const afterEnded = session.steerTo(deliveredTo!, "TOO_LATE", { kind: "external", source: "peer", deliveryId: "d2", channel: "follow_up" });
    check("lifecycle: agent.ended was observed", ended.some((a) => a === deliveredTo));
    check("steerTo: a finished frame refuses (false, not a silent drop)", afterEnded === false);
    check("steerTo: nothing was appended after the fact", !JSON.stringify((await replayContext(store, deliveredTo!)).history).includes("TOO_LATE"));

    // The root frame is addressable too, under the default address.
    const toRoot = session.steerTo("main", "FOR_THE_ROOT", { kind: "external", source: "peer", deliveryId: "d3", channel: "follow_up" });
    check("steerTo: the root frame is reachable at `main`", toRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
