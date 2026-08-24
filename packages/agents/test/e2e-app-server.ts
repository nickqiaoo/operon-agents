/**
 * app-server e2e — two halves:
 *   A) in-process over pairedTransports: full protocol incl. reverse-RPC approval,
 *      events, control-plane invoke, steer, fleet ops.
 *   B) a real child process over real stdio: proves NDJSON framing + full-duplex
 *      across a true process boundary (the cross-language path).
 */
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { defineModel, type AgentEvent } from "operon-agents-core";
import { createHarness } from "../src/index.ts";
import { AppServer } from "../src/app-server/server.ts";
import { AppServerClient } from "../src/app-server/client.ts";
import { pairedTransports } from "../src/app-server/codec.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const here = dirname(fileURLToPath(import.meta.url));

async function pairedHalf(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "af-appsrv-work-"));
  writeFileSync(join(work, "seed.txt"), "seed\n");
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("hello back", { stopReason: "stop" }), // prompt #1
    // Writes, so it reaches the approval instead of being cleared by bash-read-only-approve —
    // this prompt exists to exercise the reverse-RPC approval path.
    fauxAssistantMessage(fauxToolCall("Bash", { command: "touch .probe && echo BASH_OK" }), { stopReason: "toolUse" }), // prompt #2
    fauxAssistantMessage("ran the command", { stopReason: "stop" }), // prompt #2 cont.
    fauxAssistantMessage("handled the queued follow-up", { stopReason: "stop" }), // prompt #2 follow-up turn
  ]);

  const harness = createHarness({
    model: faux.getChatModel()!,
    workDir: work,
    permission: { mode: "manual" }, // so a Bash call triggers a reverse approval
  });
  const [hostT, serverT] = pairedTransports();
  const server = new AppServer({ harness, transport: serverT });
  void server.serve();
  const client = new AppServerClient(hostT);

  try {
    const init = await client.initialize({ approval: true, question: true });
    const invokableMethods = new Set<string>(init.invokableMethods);
    check("init: handshake returns protocolVersion", init.protocolVersion === 1);
    check("init: advertises invokable methods", init.invokableMethods.includes("getRecords"));
    check(
      "init: advertises the two background output read protocols only",
      invokableMethods.has("readBackgroundTaskOutput") &&
        invokableMethods.has("readBackgroundTaskOutputDelta") &&
        !invokableMethods.has("getBackgroundTaskOutput") &&
        !invokableMethods.has("getBackgroundTaskOutputSnapshot") &&
        !invokableMethods.has("getBackgroundTaskOutputDelta"),
    );

    const { sessionId } = await client.newSession();
    check("session/new: returns a session id", typeof sessionId === "string" && sessionId.length > 0);

    const idleFollowUp = await client.followUp(sessionId, "should not be stranded");
    check("follow-up: rejected while the session is idle", idleFollowUp.accepted === false);

    const events: AgentEvent[] = [];
    client.onEvent((e) => events.push(e));

    // ── prompt #1: plain text, no approval ──
    const r1 = await client.prompt(sessionId, "hi");
    check("prompt #1: completes", r1.status === "completed");
    check("prompt #1: output flows back", r1.output.includes("hello back"));
    check("prompt #1: events streamed over the wire", events.some((e) => e.type === "agent.started"));
    check("prompt #1: events carry sessionId", events.every((e) => e.sessionId === sessionId));

    // ── prompt #2: Bash tool call → reverse-RPC approval ──
    let approvalAsked = false;
    let activeFollowUpAccepted = false;
    client.setApprovalHandler(async (req, sid) => {
      approvalAsked = req.toolName === "Bash" && sid === sessionId;
      const queued = await client.followUp(sessionId, "after the command, confirm the follow-up");
      activeFollowUpAccepted = queued.accepted;
      return { decision: "approved" };
    });
    const r2 = await client.prompt(sessionId, "run echo");
    check("prompt #2: reverse-RPC approval reached the host", approvalAsked);
    check("follow-up: accepted while a run is active", activeFollowUpAccepted);
    check("prompt #2: completes after approval", r2.status === "completed");
    check("follow-up: runs as the next turn", r2.output.includes("handled the queued follow-up"));
    const bashResult = [...r2.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "Bash");
    const bashText =
      bashResult && bashResult.role === "toolResult" ? bashResult.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
    check("prompt #2: approved tool actually ran", bashText.includes("BASH_OK"));
    // Tool *results* come back in the run result (the engine doesn't machine them as live
    // events); what crosses the wire live is the message/turn stream — assert it coexisted
    // with the reverse-RPC approval round-trip.
    check("prompt #2: assistant message streamed over the wire", events.some((e) => e.type === "message.appended"));

    // ── control plane via session/invoke ──
    // `getRecords` reflects conversation state: after two prompts the append log is non-empty.
    const records = await client.invoke<unknown[]>(sessionId, "getRecords");
    check("invoke: getRecords returns the append log after prompts", Array.isArray(records) && records.length > 0);
    const skills = await client.invoke<unknown[]>(sessionId, "listSkills");
    check("invoke: listSkills returns an array", Array.isArray(skills));
    await client.invoke(sessionId, "setPermissionMode", "yolo");
    check("invoke: setPermissionMode (void) resolves", true);

    // ── session/snapshot: the projection read over the wire ──
    const snap = await client.snapshot(sessionId);
    check("snapshot: carries the exact-boundary event watermark", typeof snap.lastEventId === "string");
    const snapMain = snap.agents.find((agent) => agent.address === "main");
    check("snapshot: folded messages match the wire's message.appended count",
      snapMain !== undefined &&
        snapMain.messages.length === events.filter((e) => e.type === "message.appended" && e.address === "main").length);
    check("snapshot: idle session has no in-flight turn", snapMain?.turn === undefined);
    check("snapshot: directory covers main", snap.directory.some((entry) => entry.address === "main"));
    const limited = await client.snapshot(sessionId, { maxMessages: 1 });
    const limitedMain = limited.agents.find((agent) => agent.address === "main");
    check("snapshot: maxMessages caps the tail but keeps the true count",
      limitedMain?.messages.length === 1 && (limitedMain?.messageCount ?? 0) === (snapMain?.messages.length ?? -1));

    // ── steer + fleet ──
    const steer = await client.steer(sessionId, "by the way");
    check("steer: accepted", steer.accepted === true);
    const list = await client.listSessions();
    check("session/list: includes the session", list.some((s) => s.id === sessionId));

    // ── invoke rejects non-whitelisted methods ──
    let blocked = false;
    try {
      await client.invoke(sessionId, "close");
    } catch {
      blocked = true;
    }
    check("invoke: refuses non-whitelisted method (close)", blocked);

    // ── reverse-RPC declined when host can't answer ──
    const [h2, s2] = pairedTransports();
    const server2 = new AppServer({ harness, transport: s2 });
    void server2.serve();
    const client2 = new AppServerClient(h2);
    await client2.initialize({ approval: false, question: false });
    // unknown session → SessionNotFound (-32001)
    let notFound = false;
    try {
      await client2.prompt("does-not-exist", "hi");
    } catch (e) {
      notFound = (e as { code?: number }).code === -32001;
    }
    check("error: unknown session → -32001", notFound);
    client2.close();

    await client.closeSession(sessionId);
    check("session/close: succeeds", true);

    client.close();
  } finally {
    faux.unregister();
    rmSync(work, { recursive: true, force: true });
  }
}

async function subprocessHalf(): Promise<void> {
  const boot = join(here, "app-server-faux-boot.ts");
  const client = AppServerClient.spawn({
    command: execPath,
    args: ["--experimental-strip-types", "--no-warnings", boot],
  });
  try {
    const init = await withTimeout(client.initialize({ approval: false, question: false }), 15_000);
    check("subprocess: handshake over real stdio", init.protocolVersion === 1);
    const { sessionId } = await withTimeout(client.newSession(), 10_000);
    check("subprocess: session/new over real stdio", typeof sessionId === "string" && sessionId.length > 0);

    const events: AgentEvent[] = [];
    client.onEvent((e) => events.push(e));
    const result = await withTimeout(client.prompt(sessionId, "hello"), 15_000);
    check("subprocess: prompt completes across process boundary", result.status === "completed");
    check("subprocess: output crosses the wire", result.output.includes("hello from subprocess"));
    check("subprocess: events crossed the wire", events.some((e) => e.type === "agent.started"));
  } finally {
    client.close();
  }
}

// Durable HITL over the wire: a client with NO approval capability ⇒ the session has no
// approval handler ⇒ an approval-gated tool interrupts durably instead of prompting. The run
// returns `status:"interrupted"` with `interruptions`; `session/respond` supplies the answers
// and continues it to completion.
async function durableHitlHalf(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "af-appsrv-hitl-"));
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Bash", { command: "touch .probe && echo HITL_OK" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);
  const harness = createHarness({
    model: faux.getChatModel()!,
    workDir: work,
    permission: { mode: "manual" },
  });
  const [hostT, serverT] = pairedTransports();
  const server = new AppServer({ harness, transport: serverT });
  void server.serve();
  const client = new AppServerClient(hostT);
  try {
    // No approval capability → server registers no approval handler → durable interrupts.
    await client.initialize({ approval: false, question: false });
    const { sessionId } = await client.newSession();

    const interrupted = await client.prompt(sessionId, "run echo");
    check("hitl-wire: prompt interrupts durably (no approval capability)", interrupted.status === "interrupted");
    check("hitl-wire: interruptions crossed the wire", interrupted.interruptions?.[0]?.toolName === "Bash");

    const toolCallId = interrupted.interruptions![0]!.toolCallId;
    const done = await client.respond(sessionId, { [toolCallId]: { decision: "approved" } });
    check("hitl-wire: session/respond resumes to completion", done.status === "completed");
    const bash = [...done.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "Bash");
    const bashText = bash && bash.role === "toolResult" ? bash.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
    check("hitl-wire: approved tool ran after respond", bashText.includes("HITL_OK"));

    await client.closeSession(sessionId);
    client.close();
  } finally {
    faux.unregister();
    rmSync(work, { recursive: true, force: true });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms).unref()),
  ]);
}

async function main(): Promise<void> {
  await pairedHalf();
  await durableHitlHalf();
  await subprocessHalf();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ APP-SERVER E2E PASS — handshake / prompt / events / reverse-RPC approval / durable HITL (respond) / invoke / fleet / real subprocess");
  } else {
    console.log("❌ APP-SERVER E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ APP-SERVER E2E ERROR:", error);
  process.exit(1);
});
