/**
 * Regression test for the `auto`-mode judge reading the WRONG frame's transcript under
 * concurrency. The PermissionManager is a session-level singleton; its judge context
 * (live transcript + tool registry) used to be wired through mutable setters that every
 * frame's turn overwrote (`setTranscriptProvider`/`setToolProvider`), so two `Agent(...)`
 * tool calls running in parallel would clobber each other and the judge could vet one
 * sub-agent's action against the OTHER sub-agent's conversation.
 *
 * Now each frame binds its own providers into a per-turn authorizer closure
 * (`PermissionManager.authorizerFor`), so concurrent frames can't interfere.
 *
 * The test forces real overlap: both children's FIRST model calls block on a shared
 * barrier, so both frames are mid-turn before either child's Bash call reaches the
 * judge. With the old setter wiring this deterministically fed at least one judge call
 * the sibling's transcript.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Context, type FauxResponseStep } from "./faux.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, defineAgent, defineModel, LocalMachine, Runner, type AutoApprover, type Message } from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function textOf(messages: readonly Message[]): string {
  return messages
    .map((m) => (Array.isArray(m.content) ? m.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("") : ""))
    .join("\n");
}

/** First user message's text — the stable routing key for "whose conversation is this". */
function firstUserText(context: Context): string {
  for (const m of context.messages) {
    if (m.role === "user") return typeof m.content === "string" ? m.content : textOf([m as Message]);
  }
  return "";
}

function hasToolResult(context: Context): boolean {
  return context.messages.some((m) => m.role === "toolResult");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-fw-frame-judge-"));
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  const worker = defineAgent({ name: "worker", model, instructions: "Run the requested command.", tools: [bashTool] });
  const main_ = defineAgent({ name: "main", model, instructions: "Spawn both workers.", subagents: [worker] });

  // Barrier: both children's first model calls must be in flight before either returns its
  // Bash tool call, guaranteeing the two frames authorize concurrently.
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const barrier = (): Promise<void> => {
    arrived += 1;
    if (arrived === 2) release();
    return Promise.race([
      gate,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("children never overlapped — Agent tool calls appear to be serialized")), 10_000).unref(),
      ),
    ]);
  };

  // One router handles every model call; the queue order between the two children is racy
  // by design, so each queued step is the same factory.
  const router = async (context: Context): Promise<ReturnType<typeof fauxAssistantMessage>> => {
    const head = firstUserText(context);
    if (head.includes("TASK_ALPHA") || head.includes("TASK_BETA")) {
      const which = head.includes("TASK_ALPHA") ? "ALPHA" : "BETA";
      if (hasToolResult(context)) return fauxAssistantMessage(`${which} done`, { stopReason: "stop" });
      await barrier();
      // Must write, or bash-read-only-approve clears it before the judge is consulted —
      // and this test is entirely about which frame each consultation sees.
      return fauxAssistantMessage(fauxToolCall("Bash", { command: `touch .${which} && echo ${which}` }), { stopReason: "toolUse" });
    }
    // Main agent: first spawn both children in ONE batch (parallel), then finish.
    if (hasToolResult(context)) return fauxAssistantMessage("all done", { stopReason: "stop" });
    return fauxAssistantMessage(
      [
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "TASK_ALPHA: run echo ALPHA", description: "alpha task" }),
        fauxToolCall("Agent", { subagent_type: "worker", prompt: "TASK_BETA: run echo BETA", description: "beta task" }),
      ],
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses(Array.from({ length: 6 }, (): FauxResponseStep => (context) => router(context)));

  // The judge records (command, transcript) per consultation so we can pin each call to
  // the frame it was supposed to vet.
  const seen: Array<{ command: string; transcript: string; toolNames: string[] }> = [];
  const autoApprover: AutoApprover = {
    classify: async ({ ctx, transcript, tools }) => {
      const command = String((ctx.toolCall.arguments as Record<string, unknown>)["command"] ?? "");
      seen.push({ command, transcript: textOf(transcript), toolNames: (tools ?? []).map((t) => t.schema.name) });
      return { decision: "allow" };
    },
  };

  const runner = new Runner({
    machine: new LocalMachine(dir),
    permission: { mode: "auto", autoApprover },
  });
  const result = await runner.run(main_, "SPAWN_BOTH workers now", {});
  faux.unregister();
  rmSync(dir, { recursive: true, force: true });

  check("run completed", result.status === "completed");
  check("judge consulted once per child", seen.length === 2);
  const alpha = seen.find((s) => s.command.includes("ALPHA"));
  const beta = seen.find((s) => s.command.includes("BETA"));
  check("both children reached the judge", alpha !== undefined && beta !== undefined);
  check("ALPHA judge saw ALPHA's own transcript", alpha !== undefined && alpha.transcript.includes("TASK_ALPHA"));
  check("ALPHA judge did NOT see the sibling's transcript", alpha !== undefined && !alpha.transcript.includes("TASK_BETA"));
  check("BETA judge saw BETA's own transcript", beta !== undefined && beta.transcript.includes("TASK_BETA"));
  check("BETA judge did NOT see the sibling's transcript", beta !== undefined && !beta.transcript.includes("TASK_ALPHA"));
  check("judge received the frame's tool registry", seen.every((s) => s.toolNames.includes("Bash")));

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — concurrent frames each feed the auto-mode judge their OWN transcript/tools");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
