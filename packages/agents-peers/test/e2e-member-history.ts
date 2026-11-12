/**
 * `getMemberHistory(agentId)` reads a teammate's transcript by roster id — and a parked teammate
 * stays parked: no session is resumed, no turn starts, no wake is counted.
 *
 * Also pinned: the lead (a root creator) reads its own session the same way, an id off the roster
 * is refused, and a network built without the host's `readSessionMessages` refuses rather than
 * falling back to resuming the session.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness, type TranscriptPage } from "operon-agents";
import { PEERS_SERVICE, createPeerNetwork, peers, sharedLabelVisibility, type PeerNetworkHandle } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 10));
}

function texts(page: TranscriptPage): string {
  return page.items
    .filter((item) => item.kind === "message" && item.origin?.kind !== "injection")
    .map((item) => (item.kind === "message" ? item.message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : ""))
    .join("|");
}

async function rejects(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(() => false, () => true);
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [peers({ visibility: sharedLabelVisibility, teammates: { member: { title: "teammate" } } })],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
  });
  const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);

  const lead = await harness.createSession();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: "alpha" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Team", { op: "spawn", type: "member", name: "dba", prompt: "PLAN_THE_SCHEMA" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("team is up", { stopReason: "stop" }),
    fauxAssistantMessage("DBA_PLAN_READY", { stopReason: "stop" }),
  ]);
  await lead.prompt("form a team");
  await settle();

  const dba = (await net.list()).find((ref) => ref.name === "dba");
  check("setup: the teammate is on the roster", dba !== undefined);
  if (dba === undefined) process.exit(1);

  // Park it: its session closes, the roster keeps the seat.
  await harness.closeSession(dba.sessionId);
  await settle();
  check("setup: the teammate is parked and not loaded", (await net.getAgent(dba.agentId))?.status === "parked" && harness.getSession(dba.sessionId) === undefined);

  const wakesBefore = (await net.stats()).totals.wakes;
  let opened = 0;
  harness.onSessionOpened(() => {
    opened += 1;
  });
  const history = await net.getMemberHistory(dba.agentId);
  check("member: the assignment it was sent is on its transcript", texts(history).includes("PLAN_THE_SCHEMA"));
  check("member: so is what it answered", texts(history).includes("DBA_PLAN_READY"));
  check("member: the peer delivery keeps its peer origin", history.items.some((item) => item.kind === "message" && item.origin?.kind === "external"));
  await settle();
  check("member: reading did not resume it", opened === 0 && harness.getSession(dba.sessionId) === undefined);
  check("member: it is still parked", (await net.getAgent(dba.agentId))?.status === "parked");
  check("member: no wake was counted", (await net.stats()).totals.wakes === wakesBefore);

  const page = await net.getMemberHistory(dba.agentId, { limit: 1 });
  check("member: pages newest first", page.items.length === 1 && texts(page) === "DBA_PLAN_READY" && page.next !== undefined);

  const own = await net.getMemberHistory(lead.id);
  check("lead: a root creator reads its own session's transcript", texts(own).includes("form a team") && texts(own).includes("team is up"));

  check("unknown: an id off the roster is refused", await rejects(net.getMemberHistory("team:nobody:x/ghost")));

  const bare = createPeerNetwork({ visibility: sharedLabelVisibility, resumeSession: () => Promise.reject(new Error("must not resume")) });
  await bare.registerMemberSession({ name: "solo", team: "team:x:y" }, dba.sessionId);
  check("unwired: without readSessionMessages it refuses instead of resuming", await rejects(bare.getMemberHistory("team:x:y/solo")));

  await harness.close();
  faux.unregister();

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ MEMBER HISTORY E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ MEMBER HISTORY E2E PASS — ${checks.length} checks: a parked teammate's transcript is read without waking it`);
  process.exit(0);
}

void main();
