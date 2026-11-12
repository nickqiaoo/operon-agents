/**
 * A turn's id counts up over the whole life of its session: `<session>-t1`, `-t2`, `-t3`.
 *
 * The number used to come from a counter that starts over with every run, so the first turn of
 * every prompt was `-t1` and whatever was keyed by turn saw one endless turn — a per-turn budget
 * was spent once for the whole session.
 *
 * Nothing extra is stored to count them. Each turn journals a `turn.started` anyway, so the count
 * is read back from the log — and from the checkpoint, when the turns counted sit behind one and
 * a reopen never reads their records.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DiskSessionRepository, defineTool, readSessionTails, type AgentEvent } from "operon-agents-core";
import { createHarness, defineAgent, type HarnessSession } from "../src/index.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok" : "  FAIL"} ${name}${ok || detail === "" ? "" : ` (${detail})`}`);
  if (!ok) failed += 1;
}

const home = mkdtempSync(join(tmpdir(), "operon-turn-id-"));
const faux = registerFauxProvider();
const stop = (text: string) => fauxAssistantMessage(text, { stopReason: "stop" });

/** The turns that started on the root frame, in order. */
const started: string[] = [];
function watch(session: HarnessSession): void {
  session.onEvent((event: AgentEvent) => {
    if (event.type === "turn.started" && event.address === "main") started.push(event.turnId);
  });
}

let current!: HarnessSession;
/** Compacts the conversation from inside a turn, which is where a checkpoint is written. */
const squash = defineTool({
  name: "squash",
  description: "compact the conversation",
  parameters: z.object({}),
  resolve: () => ({
    approvalRule: "squash",
    run: async () => {
      const live = current.core.liveContext("main")!;
      live.applyCompaction({ summary: "earlier work", compactedCount: live.messages.length - 1, tokensBefore: 100, tokensAfter: 10 });
      await live.flush();
      return { content: [{ type: "text" as const, text: "squashed" }] };
    },
  }),
});

const open = () =>
  createHarness({
    infrastructure: () => ({ sessionRepository: new DiskSessionRepository(home) }),
    ...faux.harnessModel(),
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" }, agent: "default" } },
    registry: { agents: { default: defineAgent({ name: "root", model: faux.getChatModel()!, instructions: "x", tools: [squash] }) } }
  });

try {
  // ── One run after another ──
  let harness = open();
  current = await harness.createSession({ workDir: home });
  const id = current.id;
  watch(current);
  faux.setResponses([stop("one"), stop("two"), stop("three")]);
  await current.prompt("first");
  await current.prompt("second");
  await current.prompt("third");
  check("each prompt's turn takes the next number", started.join(" ") === `${id}-t1 ${id}-t2 ${id}-t3`, started.join(" "));

  // ── Closed and brought back in the same process ──
  await current.close();
  current = await harness.resumeSession(id);
  watch(current);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("squash", {}), { stopReason: "toolUse" }), stop("four"), stop("five")]);
  await current.prompt("fourth, and compact");
  check("a reopened session goes on counting", started.at(-1) === `${id}-t4`, started.join(" "));
  await current.prompt("fifth");
  check("and so does the turn after a compaction", started.at(-1) === `${id}-t5`, started.join(" "));
  await harness.close();

  // ── A new process: what it reads starts at the checkpoint, behind which four turns began ──
  const tails = await readSessionTails((await new DiskSessionRepository(home).open(id))!.store);
  const turnRecords = tails.filter((record) => record.type === "event.lifecycle" && record.event.type === "turn.started");
  check("the reopen reads only the one turn after the checkpoint", tails[0]?.type === "context.apply_compaction" && turnRecords.length === 1, `${turnRecords.length} of 5`);
  harness = open();
  current = await harness.resumeSession(id);
  watch(current);
  faux.setResponses([stop("six")]);
  await current.prompt("sixth");
  check("it still knows how many turns there were", started.at(-1) === `${id}-t6`, started.join(" "));
  check("no id was handed out twice", new Set(started).size === started.length && started.length === 6);
  await harness.close();
} finally {
  faux.unregister();
  rmSync(home, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
if (failed > 0) process.exit(1);
