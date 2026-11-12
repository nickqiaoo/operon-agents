/**
 * A HOST-arranged standing team, end to end — and a demonstration that peer messaging needs
 * nothing from the engine: this is built on `api.onEvent`, `api.registerTool`,
 * host `resumeSession` and `handle.steerTo`, all public.
 *
 * One `peers()` registered on the harness; members are made at birth by a session param
 * (`config.extensions.peers: { member }`): identity and the Hub arrive with birth, no spawn involved.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, offeredToolNames } from "../../agents/test/faux.ts";
import { createHarness } from "operon-agents";
import { PEERS_SERVICE, peers, sharedLabelVisibility, type PeerMemberOptions, type PeerNetworkHandle } from "../src/index.ts";

/** Born a member: the per-session param `peers()` reads to mount the Hub with this identity. */
const asMember = (member: PeerMemberOptions) => ({ config: { extensions: { [PEERS_SERVICE]: { member } } } });

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, detail = ""): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}${detail === "" ? "" : ` (${detail})`}`);
}

/** The recipient's turn is started fire-and-forget by delivery. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [peers({ visibility: sharedLabelVisibility, limits: { maxOutboundPerTurn: 2 } })],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  // The host reaches the network the same way sessions do: through its handle.
  const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);

  const alice = await harness.createSession(asMember({ name: "alice", team: "team:host:alpha", type: "lead", description: "Coordinates the work" }));
  const bob = await harness.createSession(asMember({ name: "bob", team: "team:host:alpha", type: "dba", description: "Postgres schema and query tuning" }));
  const outsider = await harness.createSession(asMember({ name: "outsider", team: "team:host:beta" }));

  const roster = await net.list();
  check("roster: every member registered itself at birth", roster.length === 3);
  check("roster: the name is the identity, not the session id", roster.find((r) => r.name === "alice")?.sessionId === alice.id);
  // Without a stated identity every teammate lists as an anonymous `member` and a model cannot
  // tell who to ask.
  check("roster: a stated type distinguishes teammates", roster.find((r) => r.name === "bob")?.type === "dba");
  check("roster: and its description rides along", roster.find((r) => r.name === "bob")?.description?.includes("Postgres") === true);
  check("roster: an unstated one still falls back", roster.find((r) => r.name === "outsider")?.type === "member");

  // ── Alice sees only her team, and messages Bob ──
  let aliceTools: string[] = [];
  const bobSaw: string[] = [];
  bob.onEvent((event) => { if (event.type === "message.appended") bobSaw.push(JSON.stringify(event)); });
  faux.setResponses([
    (context) => {
      aliceTools = offeredToolNames(context);
      return fauxAssistantMessage(fauxToolCall("Hub", { op: "list" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "bob", message: "PING_FROM_ALICE" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("messaged bob", { stopReason: "stop" }),
    fauxAssistantMessage("bob acknowledges", { stopReason: "stop" }),
  ]);
  const first = await alice.prompt("see who is around, then ping bob");
  await settle();
  const firstTranscript = JSON.stringify(first.messages);

  check("hub: a member is born holding the tool", aliceTools.includes("Hub"));
  check("hub: a member is NOT a team-former (no Team)", !aliceTools.includes("Team"));
  check("hub: the roster shows the same-team teammate", firstTranscript.includes('"bob"'));
  check("hub: the model can see WHAT that teammate is", firstTranscript.includes("dba") && firstTranscript.includes("Postgres"));
  check("hub: and hides the other team", !firstTranscript.includes("outsider"));
  check("send: reported delivered", firstTranscript.includes("delivered"));
  check("send: bob's conversation received it", bobSaw.join("|").includes("PING_FROM_ALICE"));
  check("send: framed with the sender as actor", bobSaw.join("|").includes("alice"));
  check("send: an idle recipient answers in its own turn", bobSaw.join("|").includes("bob acknowledges"));

  // ── The boundary holds even though the target is real and live ──
  const outsiderSaw: string[] = [];
  outsider.onEvent((event) => { if (event.type === "message.appended") outsiderSaw.push(JSON.stringify(event)); });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "outsider", message: "SHOULD_NOT_ARRIVE" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("could not reach them", { stopReason: "stop" }),
  ]);
  const blocked = await alice.prompt("message the outsider");
  await settle();
  check("visibility: a cross-team send is refused", JSON.stringify(blocked.messages).includes("not_visible"));
  check("visibility: nothing reached them", !outsiderSaw.join("|").includes("SHOULD_NOT_ARRIVE"));

  // ── A closed teammate is parked, and a message wakes it ──
  await bob.close();
  const bobRef = async () => (await net.list()).find((r) => r.name === "bob");
  check("park: closing leaves it on the roster", (await bobRef())?.status === "parked");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "bob", message: "WAKE_UP" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("pinged the sleeper", { stopReason: "stop" }),
    fauxAssistantMessage("bob is awake", { stopReason: "stop" }),
  ]);
  const revived = await alice.prompt("message bob again");
  await settle();
  // The last tool result is this send's: "not unknown" alone also holds for a send refused on
  // other grounds, which never reaches the sleeper at all.
  const sendResult = JSON.stringify(revived.messages.filter((message) => message.role === "toolResult").at(-1));
  check("park: a parked teammate is still addressable", !sendResult.includes("unknown_agent"));
  check("park: the send to it is delivered", sendResult.includes("delivered"), sendResult);
  const bobAgain = harness.getSession(bob.id);
  check("park: delivery reopened its session", bobAgain !== undefined && bobAgain !== bob);
  const bobTranscript = JSON.stringify(bobAgain?.snapshot());
  check("park: the woken teammate took the message", bobTranscript.includes("WAKE_UP"));
  check("park: and answered it in a turn of its own", bobTranscript.includes("bob is awake"));
  check("park: reopening it kept the team label", (await bobRef())?.labels?.includes("team:host:alpha") === true);

  // ── Per-turn outbound budget ──
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("Hub", { op: "send", to: "bob", message: "one" }),
        fauxToolCall("Hub", { op: "send", to: "bob", message: "two" }),
        fauxToolCall("Hub", { op: "send", to: "bob", message: "three" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("sent what I could", { stopReason: "stop" }),
    fauxAssistantMessage("bob replies again", { stopReason: "stop" }),
    fauxAssistantMessage("and again", { stopReason: "stop" }),
  ]);
  const budgeted = await alice.prompt("send three messages at once");
  await settle();
  // One per send, in order. A budget that never refilled would refuse all three.
  const sends = budgeted.messages.filter((message) => message.role === "toolResult").slice(-3).map((message) => JSON.stringify(message));
  check("limits: a new turn starts with a full budget", sends.slice(0, 2).every((result) => result.includes("delivered")), sends.join(" | "));
  check("limits: the third send in one turn is refused", sends[2]?.includes("quota_exceeded") === true);

  faux.unregister();
  await harness.close();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
