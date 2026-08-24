// SessionProjection: fold correctness + the snapshot/subscribe seam guarantee.
import { fauxAssistantMessage } from "./faux.ts";
import {
  ListenerSink,
  MemoryStore,
  SessionProjection,
  type AgentEvent,
  type Message,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const SESSION = "sess_projection";

function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function ev(body: Record<string, unknown>, address = "main"): AgentEvent {
  return { eventId: `evt_test_${Math.random().toString(36).slice(2)}`, address, sessionId: SESSION, ...body } as unknown as AgentEvent;
}

async function main(): Promise<void> {
  // ── 1. in-flight fold through a full turn ──
  {
    const p = new SessionProjection(SESSION);
    p.apply(ev({ type: "agent.started", agent: "root" }));
    p.apply(ev({ type: "turn.started", turnId: "t1" }));
    p.apply(ev({ type: "turn.step.started", turnId: "t1", step: 1, stepId: "s1" }));
    p.apply(ev({ type: "thinking.delta", turnId: "t1", delta: "hm" }));
    p.apply(ev({ type: "thinking.delta", turnId: "t1", delta: "m" }));
    let turn = p.snapshot().agents[0]!.turn!;
    check("thinking deltas accumulate into thinkingTail", turn.thinkingTail === "hmm");

    p.apply(ev({ type: "content.part", turnId: "t1", step: 1, part: { type: "thinking", thinking: "hmm" } }));
    p.apply(ev({ type: "assistant.delta", turnId: "t1", delta: "hel" }));
    p.apply(ev({ type: "assistant.delta", turnId: "t1", delta: "lo" }));
    turn = p.snapshot().agents[0]!.turn!;
    check("completed part clears its tail and is kept", turn.thinkingTail === "" && turn.parts.length === 1);
    check("text deltas accumulate into textTail", turn.textTail === "hello");

    p.apply(ev({ type: "content.part", turnId: "t1", step: 1, part: { type: "text", text: "hello" } }));
    p.apply(ev({ type: "tool.call.started", toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } }));
    p.apply(ev({ type: "tool.progress", toolCallId: "c1", toolName: "bash", args: {}, update: { output: "…" } }));
    p.apply(ev({ type: "tool.detachable", toolCallId: "c1", toolName: "bash" }));
    turn = p.snapshot().agents[0]!.turn!;
    const call = turn.toolCalls[0]!;
    check("running tool call tracked with progress + detachable", turn.toolCalls.length === 1 && call.progress !== undefined && call.detachable);

    // The step's assistant message absorbs the parts.
    const assistant = fauxAssistantMessage("hello");
    p.apply(ev({ type: "message.appended", message: assistant }));
    turn = p.snapshot().agents[0]!.turn!;
    check("assistant message.appended absorbs parts/tails", turn.parts.length === 0 && turn.textTail === "");
    check("tool call survives message.appended until its result", turn.toolCalls.length === 1);

    p.apply(ev({ type: "tool.result", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false }));
    turn = p.snapshot().agents[0]!.turn!;
    check("tool.result removes the running call", turn.toolCalls.length === 0);

    p.apply(ev({ type: "turn.ended", turnId: "t1", reason: "completed" }));
    const agent = p.snapshot().agents[0]!;
    check("turn.ended clears in-flight state", agent.turn === undefined);
    check("messages accumulated by reference", agent.messages.length === 1 && agent.messages[0] === assistant);

    p.apply(ev({ type: "agent.ended", agent: "root" }));
    check("agent.ended flips live off", !p.snapshot().agents[0]!.live);
  }

  // ── 2. the seam: snapshot + subscribe in one tick is exact ──
  {
    const p = new SessionProjection(SESSION);
    p.apply(ev({ type: "turn.started", turnId: "t1" }));
    const m1 = userMessage("early");
    p.apply(ev({ type: "message.appended", message: m1 }));

    // Late joiner: one synchronous block.
    const snap = p.snapshot();
    check("snapshot: exposes the last folded event id watermark", snap.lastEventId !== undefined);
    const seen: AgentEvent[] = [];
    const unsub = p.subscribe((event) => seen.push(event));

    const m2 = userMessage("late");
    p.apply(ev({ type: "message.appended", message: m2 }));
    p.apply(ev({ type: "turn.ended", turnId: "t1", reason: "completed" }));

    const inSnapshot = snap.agents[0]!.messages;
    const fromEvents = seen.filter((event) => event.type === "message.appended");
    check(
      "seam: every message exactly once across snapshot ∪ events",
      inSnapshot.length === 1 && inSnapshot[0] === m1 && fromEvents.length === 1 && (fromEvents[0] as { message?: Message }).message === m2,
    );
    unsub();
    p.apply(ev({ type: "turn.started", turnId: "t2" }));
    check("unsubscribe stops delivery", seen.length === 2);
  }

  // ── 3. attach: seed from store, then live events on top ──
  {
    const store = new MemoryStore();
    await store.appendRecord({
      type: "context.append_message",
      eventId: "evt_hist_main",
      time: 123,
      message: userMessage("m-hist"),
      address: "main",
    });
    await store.appendRecord({
      type: "context.append_message",
      eventId: "evt_hist_helper",
      message: userMessage("h-hist"),
      address: "main/helper",
    });
    const events = new ListenerSink();
    const p = await SessionProjection.attach({ id: SESSION, store, events });

    const seeded = p.snapshot();
    const byAddress = new Map(seeded.agents.map((agent) => [agent.address, agent]));
    check(
      "attach seeds every shard's reduced history",
      byAddress.get("main")?.messages.length === 1 && byAddress.get("main/helper")?.messages.length === 1,
    );
    check("attach preserves durable record time", byAddress.get("main")?.lastEventAt === 123);

    // Live events flow through the sink (including a child sink's address prefixing).
    await events.emit(ev({ type: "turn.started", turnId: "t1" }));
    const child = events.child("helper");
    await child.emit(ev({ type: "message.appended", message: userMessage("h-live") }, "" as string));
    const after = new Map(p.snapshot().agents.map((agent) => [agent.address, agent]));
    check("live fold lands on top of the seed", after.get("main")?.turn?.turnId === "t1");
    check("child-sink events fold under their address", after.get("helper")?.messages.length === 1);

    p.detach();
    await events.emit(ev({ type: "turn.ended", turnId: "t1", reason: "completed" }));
    check("detach stops folding", p.snapshot().agents.find((a) => a.address === "main")?.turn?.turnId === "t1");
  }

  // ── 4. pending steers match by steerId ──
  {
    const p = new SessionProjection(SESSION);
    const queued = userMessage("queued");
    p.apply(ev({ type: "steer.queued", steerId: "st1", channel: "follow_up", origin: { kind: "user" }, message: queued }));
    check("steer.queued tracked as pending", p.snapshot().agents[0]!.pendingSteers.length === 1);
    p.apply(ev({ type: "message.appended", message: queued, origin: { kind: "user", steerId: "st1" } }));
    check("consuming message.appended clears the pending steer", p.snapshot().agents[0]!.pendingSteers.length === 0);
  }

  // ── 5. paused state and its clearing ──
  {
    const p = new SessionProjection(SESSION);
    p.apply(ev({ type: "turn.started", turnId: "t1" }));
    p.apply(ev({ type: "tool.call.started", toolCallId: "c1", toolName: "write", args: {} }));
    p.apply(
      ev({
        type: "turn.paused",
        pending: [{ kind: "approval", toolCallId: "c1", toolName: "write", approvalRule: "write", approvalId: "a1", frameId: "f1", address: "main", agent: { name: "root" } }],
      }),
    );
    check("turn.paused surfaces pending approvals", p.snapshot().agents[0]!.turn?.paused?.length === 1);
    p.apply(ev({ type: "tool.result", toolCallId: "c1", toolName: "write", result: { content: [] }, isError: false }));
    check("tool.result clears its pending approval", p.snapshot().agents[0]!.turn?.paused === undefined);
  }

  // ── 6. snapshot tail limiting + directory ──
  {
    const p = new SessionProjection(SESSION);
    p.apply(ev({ type: "agent.started", agent: "root" }));
    for (let i = 0; i < 5; i++) p.apply(ev({ type: "message.appended", message: userMessage(`m${String(i)}`) }));
    const limited = p.snapshot({ maxMessages: 2 }).agents[0]!;
    check(
      "maxMessages keeps the tail and reports the true count",
      limited.messages.length === 2 && limited.messageCount === 5 && (limited.messages[1] as { content?: unknown }).content === "m4",
    );
    const dir = p.directory();
    check("directory summarizes without message bodies", dir.length === 1 && dir[0]!.live && !dir[0]!.running && dir[0]!.lastMessage !== undefined);
  }

  // ── 7. default snapshot size stays bounded ──
  {
    const p = new SessionProjection(SESSION);
    for (let i = 0; i < 205; i++) {
      p.apply(ev({ type: "message.appended", message: userMessage(`m${i}`) }));
    }
    const agent = p.snapshot().agents[0]!;
    check("snapshot: defaults to the last 200 messages", agent.messages.length === 200 && agent.messageCount === 205);
  }

  // ── workflow runs: folded live, and seeded from the journal for a late arrival ──
  {
    const p = new SessionProjection(SESSION);
    const wf = (progress: Record<string, unknown>): AgentEvent =>
      ev({ type: "workflow.progress", runId: "run-1", toolCallId: "call-9", progress }, "workflow:run-1");

    p.apply(wf({ type: "phase", index: 1, title: "Scan", kind: "normal" }));
    p.apply(wf({ type: "agent", record: { index: 0, label: "scan:a", phase: "Scan", state: "queued" } }));
    p.apply(wf({ type: "agent", record: { index: 0, label: "scan:a", phase: "Scan", agentId: "a1", address: "main/a1", state: "running" } }));
    p.apply(wf({ type: "log", message: "1 of 2" }));
    p.apply(wf({ type: "agent", record: { index: 1, label: "scan:b", phase: "Scan", agentId: "a2", address: "main/a2", state: "running" } }));
    // The same agent moving on — must REPLACE its entry, not add a second one.
    p.apply(wf({ type: "agent", record: { index: 0, label: "scan:a", phase: "Scan", agentId: "a1", address: "main/a1", state: "done", resultPreview: "3 hits" } }));
    p.apply(wf({ type: "outcome", status: "completed", ok: true }));

    const run = p.snapshot().workflows.find((w) => w.runId === "run-1");
    check("workflow fold: the run appears with its tool call", run?.toolCallId === "call-9");
    check("workflow fold: phases are collected", run?.phases.length === 1 && run.phases[0]?.title === "Scan");
    check("workflow fold: an agent's later state replaces its earlier one", run?.agents.length === 2);
    check("workflow fold: and carries the newest state", run?.agents.find((a) => a.index === 0)?.state === "done");
    check("workflow fold: agent identity survives running → done replacement", run?.agents.find((a) => a.index === 0)?.address === "main/a1");
    check("workflow fold: the running one is still listed", run?.agents.find((a) => a.index === 1)?.state === "running");
    check("workflow fold: the script's narration is kept in order", run?.logs.join("|") === "1 of 2");
    check("workflow fold: outcome settles the run", run?.live === false);
    check("workflow fold: workflow journal address is not an agent", !p.snapshot().directory.some((entry) => entry.address === "workflow:run-1"));
  }

  // A consumer that opens a RUNNING workflow sees the steps taken before it arrived — the
  // journal is replayed through the same fold, so seeded and watched are indistinguishable.
  {
    const store = new MemoryStore();
    const entry = (data: Record<string, unknown>, time: number) => ({
      address: "workflow:run-2",
      type: "custom" as const,
      name: "wf_journal",
      eventId: `evt_wf_run_2_${String(time)}`,
      time,
      data,
    });
    for (const record of [
      entry({ type: "run", name: "nightly", scriptBody: "..." }, 1),
      entry({ type: "phase", index: 1, title: "Build", kind: "normal" }, 2),
      entry({ type: "started", key: "k1", agentId: "a1", address: "main/a1", index: 0, label: "build:x", phase: "Build" }, 3),
      entry({ type: "result", key: "k1", agentId: "a1", address: "main/a1", index: 0, label: "build:x", phase: "Build", result: 1 }, 4),
      entry({ type: "error", key: "k2", agentId: "a2", address: "main/a2", index: 1, label: "build:y", phase: "Build", error: "boom" }, 5),
      entry({ type: "log", message: "halfway" }, 6),
    ]) await store.appendRecord(record);
    const p = await SessionProjection.attach({ id: SESSION, store, events: new ListenerSink() });
    const run = p.snapshot().workflows.find((w) => w.runId === "run-2");
    check("workflow seed: prior phases are recovered", run?.phases[0]?.title === "Build");
    check("workflow seed: a finished agent shows as done", run?.agents.find((a) => a.index === 0)?.state === "done");
    check("workflow seed: completed result carries the same preview as live publication", run?.agents.find((a) => a.index === 0)?.resultPreview === "1");
    check("workflow seed: persisted address rejoins the agent conversation", run?.agents.find((a) => a.index === 0)?.address === "main/a1");
    check("workflow seed: a failed agent keeps its error", run?.agents.find((a) => a.index === 1)?.error === "boom");
    check("workflow seed: narration is recovered", run?.logs.join("|") === "halfway");
    check("workflow seed: no outcome yet ⇒ still live", run?.live === true);
    check("workflow seed: lastEventAt comes from the durable record", run?.lastEventAt === 6);

    // Live events continue on top of the seed without disturbing it.
    p.apply(ev({ type: "workflow.progress", runId: "run-2", progress: { type: "log", message: "done" } }, "workflow:run-2"));
    const after = p.snapshot().workflows.find((w) => w.runId === "run-2");
    check("workflow seed: live events extend the seeded state", after?.logs.join("|") === "halfway|done");
  }

  // An outcome closes the run.
  {
    const store = new MemoryStore();
    await store.appendRecord({
      address: "workflow:run-3",
      type: "custom",
      name: "wf_journal",
      eventId: "evt_wf_run_3_outcome",
      time: 1,
      data: { type: "outcome", status: "completed", ok: true, failures: [], agentCount: 2 },
    });
    const p = await SessionProjection.attach({ id: SESSION, store, events: new ListenerSink() });
    check("workflow seed: an outcome marks the run settled", p.snapshot().workflows.find((w) => w.runId === "run-3")?.live === false);
    check("workflow seed: journal address never enters the agent directory", !p.snapshot().directory.some((entry) => entry.address === "workflow:run-3"));
  }

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
