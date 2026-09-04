/**
 * Telemetry through the real harness: `HarnessOptions.telemetry` → `T.Telemetry` → the core
 * Session subscribes the projection on open → registry events arrive at a product appender with
 * `session_id` context. Also: no option = nothing counted; resume flips `resumed`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import { createTelemetryService, MemoryAppender, PostHogAppender } from "../src/telemetry.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "af-telemetry-"));
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Bash", { command: "echo TELEMETRY_OK" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
    fauxAssistantMessage("again", { stopReason: "stop" }),
  ]);

  // One process-lifetime service; a product appender on it. Mode (b) PostHog with a fake client
  // stands in for desktop's consent-gated sink.
  const telemetry = createTelemetryService();
  const memory = new MemoryAppender();
  telemetry.addAppender(memory);
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  telemetry.addAppender(new PostHogAppender({ client: { capture: (m) => void captured.push({ event: m.event, properties: m.properties }) }, app: { name: "test-product", version: "0.0.1" } }));

  const harness = createHarness({ model: faux.getChatModel()!, workDir: work, permission: { mode: "yolo" }, telemetry });
  try {
    const session = await harness.createSession({ workDir: work });
    await session.prompt("run it");
    const names = memory.events.map((e) => e.name);
    const started = memory.events.find((e) => e.name === "session_started");
    const finished = memory.events.find((e) => e.name === "turn_finished");
    const tool = memory.events.find((e) => e.name === "tool_call");

    check("harness: session_started once, resumed=false, session_id from context", started !== undefined && started.properties.resumed === false && started.properties.session_id === session.id);
    check("harness: turn_started + turn_finished for the prompt", names.includes("turn_started") && finished !== undefined && finished.properties.reason === "completed");
    check("harness: turn_finished counts 2 steps and 1 tool call", finished?.properties.step_count === 2 && finished?.properties.tool_call_count === 1);
    check("harness: tool_call names the tool, never its args", tool?.properties.tool_name === "Bash" && tool?.properties.outcome === "success" && !("args" in (tool?.properties ?? {})));
    check("harness: PostHog appender saw the same events, enriched", captured.some((c) => c.event === "turn_finished" && c.properties.app_name === "test-product" && c.properties.session_id === session.id));
    check("harness: no delta / content events leaked", !names.some((n) => n.includes("delta") || n.includes("message")));

    // Resume: same id reopened from the repository → resumed=true.
    const id = session.id;
    await harness.closeSession(id);
    const before = memory.events.length;
    const resumed = await harness.resumeSession(id);
    await resumed.prompt("again");
    const startedAgain = memory.events.slice(before).find((e) => e.name === "session_started");
    check("harness: resumeSession reports resumed=true", startedAgain !== undefined && startedAgain.properties.resumed === true && startedAgain.properties.session_id === id);
  } finally {
    await harness.close();
  }

  // No `telemetry` option: nothing is subscribed, nothing is counted, nothing throws.
  faux.setResponses([fauxAssistantMessage("silent", { stopReason: "stop" })]);
  const silent = createHarness({ model: faux.getChatModel()!, workDir: work, permission: { mode: "yolo" } });
  try {
    const s = await silent.createSession({ workDir: work });
    await s.prompt("hi");
    check("harness: without the option the service sees nothing new", memory.events.filter((e) => e.name === "session_started").length === 2);
  } finally {
    await silent.close();
    rmSync(work, { recursive: true, force: true });
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
