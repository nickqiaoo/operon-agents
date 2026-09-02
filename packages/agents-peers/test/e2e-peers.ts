/**
 * A HOST-arranged standing team, end to end — and a demonstration that peer messaging needs
 * nothing from the engine: this is built on `api.onEvent`, `api.registerTool`,
 * `actions.openSession` and `handle.steerTo`, all public.
 *
 * One `peers()` registered on the harness; members are made at birth by a session param
 * (`params: { peers: { member } }`): identity and the Hub arrive with birth, no spawn involved.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness } from "operon-agents";
import { PEERS_SERVICE, peers, sharedLabelVisibility, type PeerMemberOptions, type PeerNetworkHandle } from "../src/index.ts";

/** Born a member: the per-session param `peers()` reads to mount the Hub with this identity. */
const asMember = (member: PeerMemberOptions) => ({ params: { [PEERS_SERVICE]: { member } } });

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** The recipient's turn is started fire-and-forget by delivery. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [peers({ visibility: sharedLabelVisibility, limits: { maxOutboundPerTurn: 2 } })],
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
      aliceTools = (context.tools ?? []).map((tool) => tool.name);
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
  check("park: a parked teammate is still addressable", !JSON.stringify(revived.messages).includes("unknown_agent"));
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
  check("limits: the third send in one turn is refused", JSON.stringify(budgeted.messages).includes("quota_exceeded"));

  faux.unregister();
  await harness.close();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
