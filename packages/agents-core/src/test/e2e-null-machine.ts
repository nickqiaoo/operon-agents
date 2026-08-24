import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineAgent, defineModel, readTool, Runner, type Message } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function toolResult(messages: readonly Message[], name: string): { text: string; isError: boolean } {
  const m = [...messages].reverse().find((x) => x.role === "toolResult" && x.toolName === name);
  if (!m || m.role !== "toolResult") return { text: "", isError: false };
  return { text: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: m.isError ?? false };
}

// ── Mode 1 / scenario A: a session with NO machine opens and runs (stateless, no filesystem) ──
async function testStatelessRun(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("done, no filesystem needed", { stopReason: "stop" })]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "stateless", model, instructions: "x" });

  // No machine, no store, no capabilities — the canonical stateless server config.
  const runner = new Runner({});
  const result = await runner.run(agent, "hello");
  faux.unregister();

  check("stateless: run completes with no machine configured", result.status === "completed");
  check("stateless: produced output", result.output.includes("no filesystem needed"));
}

// ── Mode 1 / scenario B: a file tool that slips through fails LOUDLY via NullMachine ──
async function testFileToolRefused(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Read", { path: "/etc/hosts" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("ok, filesystem is disabled here", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const agent = defineAgent({ name: "leaky", model, instructions: "x", tools: [readTool] });

  const runner = new Runner({ permission: { mode: "yolo" } });
  const result = await runner.run(agent, "read a file");
  faux.unregister();

  const read = toolResult(result.messages, "Read");
  check("null-machine: Read fails with a clear error", read.isError && /filesystem disabled|NullMachine/.test(read.text));
  check("null-machine: loop survives the refusal", result.status === "completed");
}

async function main(): Promise<void> {
  await testStatelessRun();
  await testFileToolRefused();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ NULL-MACHINE E2E PASS — stateless run with no machine + file tools refused loudly");
  } else {
    console.log("❌ NULL-MACHINE E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ NULL-MACHINE E2E ERROR:", error);
  process.exit(1);
});
