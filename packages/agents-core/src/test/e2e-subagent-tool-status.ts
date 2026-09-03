import { testRunner, openTestSession } from "./faux.ts";
/**
 * Regression test for the static `agent_<name>` delegation tool (buildSubagentTool,
 * agent/subagent-tools.ts) silently reporting a failed or aborted child run as a normal
 * success: the ToolResult never set `isError`, and the text was just the child's raw
 * (possibly empty) output with no indication anything went wrong. A parent agent reading
 * that result had no way to distinguish "the sub-task succeeded" from "the sub-task
 * errored out and this is whatever partial text it left behind".
 *
 * Uses a STATIC subagent (`subagents: [...]` on defineAgent), which registers the
 * `agent_<name>` tool — distinct from the unified `Agent` tool (buildAgentTool), which
 * already surfaces `status:` text via its own `spawnResult` helper.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineAgent, defineModel, Runner, type Message, type ToolResultMessage } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function subagentToolResult(messages: readonly Message[], toolName: string): ToolResultMessage | undefined {
  return messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === toolName);
}

function textOf(m: ToolResultMessage | undefined): string {
  return m?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
}

async function runWithChildStopReason(stopReason: "stop" | "error" | "aborted"): Promise<ToolResultMessage | undefined> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const child = defineAgent({ name: "flaky", model, instructions: "Do the sub-task." });
  const main = defineAgent({ name: "main", model, instructions: "Delegate to flaky.", subagents: [child] });

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("agent_flaky", { input: "do the thing" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(stopReason === "stop" ? "child succeeded" : "child output before trouble", { stopReason }),
    fauxAssistantMessage("main acknowledges", { stopReason: "stop" }),
  ]);
  const runner = testRunner({});
  const r = await runner.run(main, "delegate", {});
  faux.unregister();
  return subagentToolResult(r.messages, "agent_flaky");
}

async function main(): Promise<void> {
  const okResult = await runWithChildStopReason("stop");
  check("completed child: tool result is not marked isError", okResult?.isError !== true);
  check("completed child: text is the raw output with no status prefix", textOf(okResult) === "child succeeded");

  const errorResult = await runWithChildStopReason("error");
  check("errored child: tool result IS marked isError", errorResult?.isError === true);
  check("errored child: text carries a status line so the parent can tell something went wrong", /status: error/.test(textOf(errorResult)));
  check("errored child: the child's partial output is still included, not swallowed", textOf(errorResult).includes("child output before trouble"));

  const abortedResult = await runWithChildStopReason("aborted");
  check("aborted child: tool result IS marked isError", abortedResult?.isError === true);
  check("aborted child: text carries a status line", /status: aborted/.test(textOf(abortedResult)));

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — agent_<name> tool propagates isError/status for abnormal child termination");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
