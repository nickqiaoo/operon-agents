// Durable INPUT suspension answered through the Harness facade.
//
// `HarnessSession.resume` used to wrap every answer as `{ kind: "approval" }` — a run
// durably suspended on a tool's `ctx.suspend` (an input interrupt) could never be answered
// through the facade at all: the harness was approval-only while the core Runner already
// accepted `{ kind: "input", data }`. This exercises the pass-through: bare
// ApprovalResponses still work (shorthand), and discriminated InterruptAnswers reach the
// suspended tool cross-process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineModel, defineAgent, DiskSessionRepository, type Tool } from "operon-agents-core";
import { createHarness } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface PickState {
  readonly candidates: string[];
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "af-input-resume-home-"));
  const work = mkdtempSync(join(tmpdir(), "af-input-resume-work-"));

  const counters = { searches: 0, books: 0 };
  // Raw Tool (no defineTool) so the test needs no direct zod dependency.
  const pickTool: Tool = {
    schema: {
      name: "pick",
      description: "search candidates, ask the user to pick one, then book it",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    },
    resolve: (rawArgs) => {
      const { topic } = rawArgs as { topic: string };
      return {
        approvalRule: `pick(${topic})`,
        run: async (ctx) => {
          if (ctx.resumed) {
            const state = ctx.resumed.state as PickState;
            const { choice } = ctx.resumed.answer as { choice: string };
            counters.books++;
            return { content: [{ type: "text" as const, text: `booked:${choice} of:${state.candidates.join(",")}` }] };
          }
          counters.searches++;
          const candidates = [`${topic}-A`, `${topic}-B`];
          ctx.suspend({ kind: "choice", display: { title: `pick one ${topic}`, candidates } }, { candidates } satisfies PickState);
          return undefined as never;
        },
      };
    },
  };

  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pick", { topic: "flight" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Booked the flight you picked.", { stopReason: "stop" }),
  ]);
  const model = faux.getChatModel()!;
  const picker = defineAgent({ name: "picker", model, instructions: "x", tools: [pickTool] });

  try {
    // ── Process 1: the tool suspends for input; the run interrupts durably ──
    const harness1 = createHarness({ model, repository: new DiskSessionRepository(home), workDir: work, permission: { mode: "yolo" } });
    const session1 = await harness1.createSession({ agent: picker });
    const sessionId = session1.id;

    const first = await session1.prompt("book me a flight");
    const pending = first.interruptions?.[0];
    check("input-resume: prompt interrupts durably on the tool's suspend", first.status === "interrupted");
    check("input-resume: pending interrupt is kind 'input'", pending?.kind === "input" && pending.toolName === "pick");
    check("input-resume: search phase ran once before pausing", counters.searches === 1 && counters.books === 0);

    await session1.close();
    await harness1.close();

    // ── Process 2: a fresh harness answers the INPUT suspension via resume ──
    const harness2 = createHarness({ model, repository: new DiskSessionRepository(home), workDir: work, permission: { mode: "yolo" } });
    const session2 = await harness2.resumeSession(sessionId, { agent: picker });
    check("input-resume: reopened durable pause reports interrupted", session2.status.state === "interrupted");
    check("input-resume: reopened pause exposes pending input", (await session2.pendingInterruptions())[0]?.kind === "input");

    const second = await session2.resume({ [pending!.approvalId]: { kind: "input", data: { choice: "flight-A" } } });
    check("input-resume: resume with a { kind: 'input' } answer completes the run", second.status === "completed");
    check("input-resume: the answer + saved state reached the suspended tool", counters.books === 1 && second.messages.some((m) => JSON.stringify(m.content).includes("booked:flight-A of:flight-A,flight-B")));
    check("input-resume: final output surfaced", second.output.includes("Booked the flight"));

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
    console.log("✅ HARNESS INPUT-RESUME E2E PASS — durable input suspension answered through HarnessSession.resume");
  } else {
    console.log("❌ HARNESS INPUT-RESUME E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ HARNESS INPUT-RESUME E2E ERROR:", error);
  process.exit(1);
});
