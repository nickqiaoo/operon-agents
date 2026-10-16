/**
 * Reopening through the harness reads every shard from its newest checkpoint, not the whole log.
 *
 * The hard case is a crash in the middle of a turn that compacted: a compaction runs INSIDE a
 * turn, so the `agent.started` / `turn.started` it ran under — and a steer queued before it —
 * sit behind the checkpoint. A tail-only read must still see them, or the harness's orphan repair
 * would never close that turn and the UI would show it running forever. The checkpoint carries
 * them as its `#frame`; these checks pin that the tail-seeded projection matches a whole-log one
 * and that the orphan is closed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness } from "../src/index.ts";
import {
  DiskSessionRepository,
  ListenerSink,
  Runner,
  Session,
  SessionProjection,
  defineAgent,
  defineTool,
  readSessionTails,
  type AgentRecord,
  type SessionStore,
} from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function readAll(store: SessionStore): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const record of store.readRecords()) out.push(record);
  return out;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the log");
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "operon-checkpoint-reopen-"));
  try {
    const repository = new DiskSessionRepository(home);
    const handle = await repository.create({ workDir: home });

    // ── the "crashed" process: a turn that compacts, queues a steer, then never finishes ──
    const faux = registerFauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("work", { step: "one" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("work", { step: "crash" }), { stopReason: "toolUse" }),
    ]);
    let session!: Session;
    let reachedCrash!: () => void;
    const crashed = new Promise<void>((resolve) => (reachedCrash = resolve));
    const work = defineTool({
      name: "work",
      description: "work",
      params: z.object({ step: z.string() }),
      resolve: (args) => ({
        approvalRule: `work(${args.step})`,
        run: async () => {
          if (args.step !== "crash") return { content: [{ type: "text" as const, text: "did one" }] };
          session.steer.followUp("do this next");
          const live = session.liveContext("main")!;
          live.applyCompaction({ summary: "earlier work", compactedCount: live.messages.length - 1, tokensBefore: 100, tokensAfter: 10 });
          reachedCrash();
          return new Promise(() => undefined); // the process dies here
        },
      }),
    });
    session = await Session.open({ sessionId: handle.id, store: handle.store, permissionOptions: { mode: "yolo" } });
    const agent = defineAgent({ name: "root", model: faux.getChatModel()!, instructions: "x", tools: [work] });
    void new Runner({}).run(agent, "start", { session });
    await crashed;
    await waitFor(async () => (await readAll(handle.store)).some((record) => record.type === "context.apply_compaction"));

    // ── what a tail read sees, against the whole log ──
    const reader = (await repository.open(handle.id))!.store;
    const whole = await readAll(reader);
    const tails = await readSessionTails(reader);
    const checkpoint = whole.find((record) => record.type === "context.apply_compaction") as { checkpoint?: Record<string, unknown> } | undefined;
    check("the mid-turn checkpoint carries the shard's lifecycle (#frame)", checkpoint?.checkpoint?.["#frame"] !== undefined);
    check(`the tail read is shorter than the log (${tails.length} of ${whole.length})`, tails.length < whole.length && tails[0]?.type === "context.apply_compaction");

    const fromWhole = (await SessionProjection.attach({ id: handle.id, events: new ListenerSink() }, whole)).snapshot();
    const fromTails = (await SessionProjection.attach({ id: handle.id, events: new ListenerSink() }, tails)).snapshot();
    const a = fromWhole.agents.find((entry) => entry.address === "main");
    const b = fromTails.agents.find((entry) => entry.address === "main");
    check("tail projection: same history", JSON.stringify(a?.messages) === JSON.stringify(b?.messages) && (b?.messages.length ?? 0) > 0);
    check("tail projection: the agent is still live, by name", b?.live === true && b.agent === "root" && a?.agent === b.agent);
    check("tail projection: the turn opened before the checkpoint is still open", b?.turn !== undefined && b.turn.turnId === a?.turn?.turnId);
    check("tail projection: the tool call in flight is still in flight", JSON.stringify(b?.turn?.toolCalls.map((call) => call.toolName)) === JSON.stringify(a?.turn?.toolCalls.map((call) => call.toolName)));
    check("tail projection: the steer queued before the checkpoint is still pending", b?.pendingSteers.length === 1 && a?.pendingSteers.length === 1);

    // ── the harness reopens from tails and closes the orphan ──
    const harness = createHarness({ harness: () => ({ sessionRepository: repository }), model: faux.getChatModel()!, permission: { mode: "yolo" } });
    const recovered = await harness.resumeSession(handle.id);
    const main = recovered.snapshot().agents.find((entry) => entry.address === "main");
    check("harness reopen: the orphan turn is closed", main?.turn === undefined && main.live === false);
    const lifecycle = (await readAll(reader)).flatMap((record) => (record.type === "event.lifecycle" ? [record.event] : []));
    check("harness reopen: the failed turn is journaled", lifecycle.some((event) => event.type === "turn.ended" && event.reason === "failed" && event.turnId === a?.turn?.turnId));
    check("harness reopen: the orphan agent frame is journaled closed", lifecycle.some((event) => event.type === "agent.ended" && event.agent === "root"));
    check("harness reopen: the history is the checkpoint's", JSON.stringify(main?.messages) === JSON.stringify(a?.messages));
    await recovered.close();
    await harness.close();
    faux.unregister();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ HARNESS CHECKPOINT REOPEN E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ HARNESS CHECKPOINT REOPEN E2E PASS — ${checks.length} checks: tail-only reopen keeps a mid-turn crash's lifecycle`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
