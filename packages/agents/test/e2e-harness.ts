import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineModel, defineAgent, DiskSessionRepository, type AgentEvent } from "operon-agents-core";
import { createHarness } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "af-harness-home-"));
  const work = mkdtempSync(join(tmpdir(), "af-harness-work-"));
  const filePath = join(work, "note.txt");
  writeFileSync(filePath, "hello from disk\n");

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("hi there", { stopReason: "stop" }), // prompt #1
    fauxAssistantMessage(fauxToolCall("Read", { path: filePath }), { stopReason: "toolUse" }), // prompt #2
    fauxAssistantMessage("read it", { stopReason: "stop" }),
    fauxAssistantMessage("here is the SECRET", { stopReason: "stop" }), // prompt #3 (guardrail facade)
  ]);
  const model = faux.getChatModel()!;

  try {
    const harness = createHarness({ model, repository: new DiskSessionRepository(home), workDir: work, permission: { mode: "yolo" } });

    const session = await harness.createSession();
    check("harness: createSession returns a session with an id", typeof session.id === "string" && session.id.length > 0);

    const events: AgentEvent[] = [];
    const unsub = session.onEvent((e) => events.push(e));

    // ── prompt #1: plain run, events flow ──
    const result = await session.prompt("hello");
    check("harness: prompt completes", result.status === "completed");
    check("harness: prompt returns output", result.output.includes("hi there"));
    check("harness: onEvent received events", events.some((e) => e.type === "agent.started"));

    // ── listSessions sees the new session ──
    const list = await harness.listSessions();
    check("harness: listSessions includes the new session", list.some((s) => s.id === session.id));

    // ── prompt #2: default agent has filesystemTools() → Read works ──
    const read = await session.prompt("read the note");
    const readResult = [...read.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "Read");
    const readText =
      readResult && readResult.role === "toolResult"
        ? readResult.content.map((c) => (c.type === "text" ? c.text : "")).join("")
        : "";
    check("harness: filesystem tool reads a real file", readText.includes("hello from disk"));

    // ── guardrail facade: a tripwire resolves as status "guardrail_blocked", not a throw ──
    const guarded = defineAgent({
      name: "guarded",
      model,
      instructions: "x",
      guardrails: { output: [{ name: "no-secret", execute: ({ output }) => ({ tripwireTriggered: output.includes("SECRET") }) }] },
    });
    const gSession = await harness.createSession({ agent: guarded });
    const gEvents: AgentEvent[] = [];
    gSession.onEvent((e) => gEvents.push(e));
    let threw = false;
    let blocked: Awaited<ReturnType<typeof gSession.prompt>> | undefined;
    try {
      blocked = await gSession.prompt("tell me a secret");
    } catch {
      threw = true;
    }
    check("harness: guardrail tripwire does NOT throw (facade returns a result)", !threw);
    check("harness: guardrail tripwire → status 'guardrail_blocked'", blocked?.status === "guardrail_blocked");
    check(
      "harness: guardrail_blocked result carries stage + name",
      blocked?.guardrail?.stage === "output" && blocked?.guardrail?.guardrail === "no-secret",
    );
    check("harness: guardrail.blocked event still emitted on the stream", gEvents.some((e) => e.type === "guardrail.blocked"));
    await gSession.close();

    unsub();
    await session.close();
    check("harness: session closed and deregistered", !harness.sessions.has(session.id));

    await harness.close();
  } finally {
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ HARNESS E2E PASS — createHarness / createSession / onEvent / prompt / listSessions / filesystem tool");
  } else {
    console.log("❌ HARNESS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ HARNESS E2E ERROR:", error);
  process.exit(1);
});
