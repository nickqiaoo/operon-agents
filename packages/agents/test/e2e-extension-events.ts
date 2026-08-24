/**
 * `api.onEvent` — the observation half of the extension contract.
 *
 * The motivating case: subagent lifecycle is visible ONLY on the event stream. `run.start` is a
 * `LoopHooks` slot and fires just for the top-level run, so before this an extension had no way to
 * learn that a subagent had been spawned — it had to reach outside itself and subscribe to the
 * session from the host side, which is a different layer.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import { defineAgent } from "operon-agents-core";
import type { AgentEvent } from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const seen: AgentEvent[] = [];
  const runStarts: string[] = [];
  let threwOnce = false;

  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [
      {
        id: "observer",
        setup(api) {
          api.onEvent((event) => seen.push(event));
          // A listener that throws must not disrupt the run.
          api.onEvent(() => {
            if (!threwOnce) {
              threwOnce = true;
              throw new Error("listener blew up");
            }
          });
          api.on("run.start", (event) => {
            runStarts.push(event.address);
            return undefined;
          });
        },
      },
    ],
  });

  const model = faux.getChatModel()!;
  const helper = defineAgent({ name: "helper", model, instructions: "Help." });
  const session = await harness.createSession({ agent: defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [helper] }) });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "helper", prompt: "look around", description: "look" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("subagent report", { stopReason: "stop" }),
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);
  const result = await session.prompt("spawn a subagent");
  faux.unregister();

  const started = seen.filter((e) => e.type === "agent.started");
  const ended = seen.filter((e) => e.type === "agent.ended");
  const subagentStart = started.find((e) => e.address !== undefined && e.address !== "main");

  check("run completes despite a throwing listener", result.status === "completed");
  check("a throwing listener was isolated, not fatal", threwOnce);
  check("onEvent saw events at all", seen.length > 0);
  check("onEvent saw the subagent start", subagentStart !== undefined);
  check("with its frame address", subagentStart?.address?.startsWith("main/") === true);
  check("and the matching end", ended.some((e) => e.address === subagentStart?.address));
  // The contrast that motivated the API: the decision-point channel only ever saw the root run.
  check("run.start fired only for the top-level run", runStarts.length === 1 && runStarts[0] === "main");

  await harness.close();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
