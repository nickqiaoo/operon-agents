import { T } from "operon-agents-core";
// Durable human-in-the-loop through the Harness facade.
//
// When no approval handler is registered, the session's MutableResponder reports
// isLiveApprover() === false, so an approval-gated tool call interrupts DURABLY instead of
// auto-rejecting ("no live responder ⇒ durable"). The run pauses, persists interruption control state to the
// session store, and returns `status:"interrupted"` with `interruptions`. A later
// `session.resume(answers)` — even from a fresh process that reopens the session from the
// same durable store — applies the approvals and continues the run.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineModel, defineAgent, DiskSessionRepository, writeTool } from "operon-agents-core";
import { createHarness } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "af-hitl-home-"));
  const work = mkdtempSync(join(tmpdir(), "af-hitl-work-"));
  const file = join(work, "approved.txt");

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Write", { path: file, content: "written after approval\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("wrote it", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  interface AppContext {
    readonly process: "initial" | "resumed";
    readonly seenByAgent: string[];
  }
  const writer = defineAgent<AppContext>({
    name: "writer",
    model,
    instructions: ({ context }) => {
      context?.seenByAgent.push(context.process);
      return `process=${context?.process ?? "missing"}`;
    },
    tools: [writeTool],
  });

  try {
    // ── Process 1: prompt pauses durably (manual mode, no approval handler) ──
    const initialContext: AppContext = { process: "initial", seenByAgent: [] };
    const harness1 = createHarness<AppContext>({ model, harness: (s) => s.register(T.SessionRepository, new DiskSessionRepository(home), { owned: false }), workDir: work, permission: { mode: "manual" } });
    const session1 = await harness1.createSession({ agent: writer, context: initialContext });
    const sessionId = session1.id;

    const first = await session1.prompt("write the file");
    check("hitl-harness: prompt interrupts durably (no approval handler)", first.status === "interrupted");
    check("hitl-harness: interruptions surfaced the Write approval", first.interruptions?.[0]?.toolName === "Write");
    check("hitl-harness: interruption id present on the result", typeof first.interruption?.id === "string");
    check("hitl-harness: file not written before approval", !existsSync(file));
    check("hitl-harness: initial process context reached Agent instructions", initialContext.seenByAgent.join() === "initial");
    const toolCallId = first.interruptions![0]!.toolCallId;

    // Simulate the process going away entirely.
    await session1.close();
    await harness1.close();

    // ── Process 2: a fresh harness reopens the session and resumes with answers ──
    const resumedContext: AppContext = { process: "resumed", seenByAgent: [] };
    const harness2 = createHarness<AppContext>({ model, harness: (s) => s.register(T.SessionRepository, new DiskSessionRepository(home), { owned: false }), workDir: work, permission: { mode: "manual" } });
    const session2 = await harness2.resumeSession(sessionId, { agent: writer, context: resumedContext });
    check("hitl-harness: reopened durable pause reports interrupted before resume", session2.status.state === "interrupted");
    check("hitl-harness: reopened pause exposes its pending approval", (await session2.pendingInterruptions())[0]?.toolCallId === toolCallId);
    check(
      "hitl-harness: reopened Projection contains the durable pause",
      session2.snapshot().agents.find((entry) => entry.address === "main")?.turn?.paused?.[0]?.toolCallId === toolCallId,
    );

    const second = await session2.resume({ [toolCallId]: { decision: "approved" } });
    check("hitl-harness: cross-process resume completes", second.status === "completed");
    check("hitl-harness: file written after approval", existsSync(file) && readFileSync(file, "utf8") === "written after approval\n");
    check("hitl-harness: final output surfaced", second.output.includes("wrote it"));
    check("hitl-harness: reopened session used the re-provided context", resumedContext.seenByAgent.join() === "resumed");

    // Interruption state was consumed by resume → a second resume has nothing to continue.
    let threw = false;
    try {
      await session2.resume({ [toolCallId]: { decision: "approved" } });
    } catch {
      threw = true;
    }
    check("hitl-harness: resume with no pending interruption throws", threw);

    await session2.close();
    await harness2.close();
  } finally {
    faux.unregister();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ HARNESS HITL E2E PASS — durable interrupt + cross-process resume");
  } else {
    console.log("❌ HARNESS HITL E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ HARNESS HITL E2E ERROR:", error);
  process.exit(1);
});
