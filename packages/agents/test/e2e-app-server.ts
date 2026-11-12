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
import { createHarness, type ExtensionDefinition } from "../src/index.ts";
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
    ...faux.harnessModel(),
    config: { workDir: work, defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "manual" } } }
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
      invokableMethods.has("background.readOutput") &&
        invokableMethods.has("background.readOutputDelta") &&
        !invokableMethods.has("background.getOutput") &&
        !invokableMethods.has("background.getOutputSnapshot") &&
        !invokableMethods.has("background.getOutputDelta"),
    );

    const { sessionId } = await client.newSession();
    check("session/new: returns a session id", typeof sessionId === "string" && sessionId.length > 0);

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
      const running = harness.getSession(sessionId);
      await client.resumeSession(sessionId);
      check("resume: reconnect during approval keeps the running instance", harness.getSession(sessionId) === running && running?.status.state === "running");
      const queued = await client.followUp(sessionId, "after the command, confirm the follow-up");
      activeFollowUpAccepted = queued.accepted;
      return { decision: "approved" };
    });
    const r2 = await client.prompt(sessionId, "run echo");
    check("prompt #2: reverse-RPC approval reached the host", approvalAsked);
    check("follow-up: accepted while a run is active", activeFollowUpAccepted);
    check("prompt #2: completes after approval", r2.status === "completed");
    check("follow-up: the run's own answer stays its own", r2.output.includes("ran the command"));
    const followUpAnswered = (): boolean =>
      events.some((e) => e.type === "message.appended" && e.message.role === "assistant" && JSON.stringify(e.message.content).includes("handled the queued follow-up"));
    for (let i = 0; i < 100 && !followUpAnswered(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    check("follow-up: runs as a run of its own", followUpAnswered());
    const bashResult = [...r2.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "Bash");
    const bashText =
      bashResult && bashResult.role === "toolResult" ? bashResult.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
    check("prompt #2: approved tool actually ran", bashText.includes("BASH_OK"));
    // Tool *results* come back in the run result (the engine doesn't surface them as live
    // events); what crosses the wire live is the message/turn stream — assert it coexisted
    // with the reverse-RPC approval round-trip.
    check("prompt #2: assistant message streamed over the wire", events.some((e) => e.type === "message.appended"));

    // ── control plane via session/invoke ──
    // `getRecords` reflects conversation state: after two prompts the append log is non-empty.
    const records = await client.invoke<unknown[]>(sessionId, "getRecords");
    check("invoke: getRecords returns the append log after prompts", Array.isArray(records) && records.length > 0);
    const skills = await client.invoke<unknown[]>(sessionId, "skills.listSkills");
    check("invoke: skills.listSkills returns an array", Array.isArray(skills));
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
    let invalid = false;
    try {
      await client2.prompt("", "hi");
    } catch (e) {
      invalid = (e as { code?: number }).code === -32602 && (e as Error).message.includes("sessionId");
    }
    check("error: malformed params → -32602 naming the field", invalid);
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
async function restoreHalf(): Promise<void> {
  const faux = registerFauxProvider();
  let restores = 0;
  let failNext = false;
  // What the host knows and the harness does not is supplied where the harness asks for it — the
  // server keeps no restore hook of its own.
  const harness = createHarness<string>({
    ...faux.harnessModel(),
    resolveSession: ({ operation }) => {
      if (operation !== "restore") return;
      restores++;
      if (failNext) { failNext = false; throw new Error("assembly unavailable"); }
      return { bindings: { context: "host context" } };
    },
    config: { defaults: { ...faux.harnessModel().config.defaults } }
  });
  const [hostT, serverT] = pairedTransports();
  const server = new AppServer({ harness, transport: serverT });
  const serving = server.serve();
  const client = new AppServerClient(hostT);
  try {
    await client.initialize();
    const { sessionId } = await client.newSession();
    const original = harness.getSession(sessionId);
    await client.resumeSession(sessionId);
    check("resume: loaded instance reused without restoration", restores === 0 && harness.getSession(sessionId) === original);
    await client.closeSession(sessionId);
    const results = await Promise.all([client.resumeSession(sessionId), client.resumeSession(sessionId)]);
    const restored = harness.getSession(sessionId);
    check("resume: concurrent requests restore once", restores === 1 && results.every((r) => r.sessionId === sessionId));
    check("resume: host configuration used", restored !== original && restored?.context === "host context");
    await client.closeSession(sessionId);
    failNext = true;
    const failed = await client.resumeSession(sessionId).then(() => false, () => true);
    check("resume: failed assembly creates no replacement", failed && harness.getSession(sessionId) === undefined);
    await client.resumeSession(sessionId);
    check("resume: failure does not block retry", harness.getSession(sessionId) !== undefined);
    await client.closeSession(sessionId);
    // A close that lands while the restore is in flight cancels it: the resume is refused rather
    // than handed a session that is already closed.
    const raced = await Promise.allSettled([client.resumeSession(sessionId), client.closeSession(sessionId)]);
    check("resume/close: a close during restoration wins", raced[0].status === "rejected" && raced[1].status === "fulfilled" && harness.getSession(sessionId) === undefined);
    await client.resumeSession(sessionId);
    check("resume/close: the session restores afterwards", harness.getSession(sessionId) !== undefined);
    await client.closeSession(sessionId);
    const before = (await harness.listSessions()).length;
    const missing = await client.resumeSession("missing").then(() => false, () => true);
    check("resume: missing history never creates a conversation", missing && (await harness.listSessions()).length === before);
  } finally {
    client.close();
    await serving;
    faux.unregister();
  }
}

// Wiring belongs to the session INSTANCE, and to every instance the harness opens: one closed
// behind the server's back and reopened, and one an extension created that no client asked for.
async function wiringHalf(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage("first", { stopReason: "stop" }),
    fauxAssistantMessage("second", { stopReason: "stop" }),
    fauxAssistantMessage("child", { stopReason: "stop" }),
  ]);
  const spawner: ExtensionDefinition = {
    id: "spawner",
    harness: (host) => ({ spawn: () => host.createSession({ title: "spawned" }) }),
    session() {},
  };
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [spawner],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "manual" } } }
  });
  const [hostT, serverT] = pairedTransports();
  const server = new AppServer({ harness, transport: serverT });
  const serving = server.serve();
  const client = new AppServerClient(hostT);
  try {
    await client.initialize({ approval: false, question: false });
    const events: AgentEvent[] = [];
    client.onEvent((event) => events.push(event));
    const { sessionId } = await client.newSession({ config: { permission: { mode: "yolo" }, limits: { maxTurns: 7 } } });
    const created = harness.getSession(sessionId)!;
    check("config: session/new carries the session's setup", created.permissionMode === "yolo" && created.config.limits?.maxTurns === 7);
    const rejected = await client.newSession({ config: { nonsense: true } as never }).then(() => false, () => true);
    check("config: an unknown key is refused, not dropped", rejected);
    await client.prompt(sessionId, "one");
    const firstRun = events.filter((event) => event.type === "agent.started").length;
    // Closed by something other than `session/close` — an extension, the host — then reopened.
    await harness.closeSession(sessionId);
    await client.resumeSession(sessionId);
    const reopened = harness.getSession(sessionId)!;
    check("config: the setup is restored with the session", reopened !== created && reopened.permissionMode === "yolo" && reopened.config.limits?.maxTurns === 7);
    await client.prompt(sessionId, "two");
    check("wiring: a reopened session's events still reach the client", firstRun > 0 && events.filter((event) => event.type === "agent.started").length > firstRun);

    const { id: childId } = await harness.services.handle<{ spawn(): Promise<{ id: string }> }>("spawner").spawn();
    const seen = events.length;
    await harness.getSession(childId)!.prompt("three");
    check("wiring: a session an extension created is forwarded too", events.slice(seen).some((event) => event.type === "agent.started" && event.sessionId === childId));

    const fork = await client.forkSession(sessionId, { config: { limits: { maxTurns: 3 } } });
    const forked = harness.getSession(fork.sessionId)!;
    check("config: session/fork adjusts the source's setup field by field", forked.config.limits?.maxTurns === 3 && forked.permissionMode === "yolo");
  } finally {
    client.close();
    await serving;
    faux.unregister();
  }
}

async function durableHitlHalf(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "af-appsrv-hitl-"));
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Bash", { command: "touch .probe && echo HITL_OK" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);
  const harness = createHarness({
    ...faux.harnessModel(),
    config: { workDir: work, defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "manual" } } }
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
  await restoreHalf();
  await wiringHalf();
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
