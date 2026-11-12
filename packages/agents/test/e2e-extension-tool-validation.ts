/**
 * A plain `ExtensionToolSpec` is checked against its JSON Schema before `execute` runs: a bad call
 * goes back to the model as a tool error, and a schema that cannot compile fails at registration.
 */
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, type AgentEvent, type ExtensionDefinition } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const faux = registerFauxProvider();
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("Echo", { value: 1 }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("Echo", { value: "ok" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("done", { stopReason: "stop" }),
]);

const executed: unknown[] = [];
let badSchemaRejected = false;
const extension: ExtensionDefinition = {
  id: "validated",
  session(api) {
    api.registerTool({
      name: "Echo",
      description: "Echo a value",
      // `z.toJSONSchema` tags its output with a newer draft than the validator's default.
      parameters: z.toJSONSchema(z.object({ value: z.string() })) as Record<string, unknown>,
      execute(args) {
        executed.push(args);
        return "echoed";
      },
    });
    try {
      api.registerTool({ name: "Broken", description: "Bad schema", parameters: { type: "not-a-type" }, execute: () => "never" });
    } catch {
      badSchemaRejected = true;
    }
  },
};

const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [extension],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
try {
  const session = await harness.createSession();
  const results: Array<{ isError: boolean; text: string }> = [];
  session.onEvent((event: AgentEvent) => {
    if (event.type !== "message.appended" || event.message.role !== "toolResult") return;
    results.push({ isError: event.message.isError, text: JSON.stringify(event.message.content) });
  });
  const result = await session.prompt("go");

  check("the run completes", result.status === "completed");
  check("a schema that cannot compile fails at registration", badSchemaRejected);
  check("execute only ran for the valid call", executed.length === 1 && (executed[0] as { value: unknown }).value === "ok");
  check("the invalid call came back as a tool error", results[0]?.isError === true && results[0].text.includes("Invalid arguments"));
  check("the valid call succeeded", results[1]?.isError === false);
} finally {
  await harness.close();
  faux.unregister();
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exit(1);
