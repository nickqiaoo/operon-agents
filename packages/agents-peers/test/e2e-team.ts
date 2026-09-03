/**
 * Teams an agent forms for itself. Capability follows birth: the lead holds `Team` (create /
 * spawn / scoped send), a spawned teammate is a SESSION born with the member `Hub` (and never
 * `Team`), and an ordinary delegation (`Agent`) never enters the peer world at all.
 *
 * The host wrote no factory: `peers({ teammates })` says what a "schema" teammate IS (its session
 * options) and the extension's own `harness` half spawns it, tagged a member through `params`.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness, type ExtensionDefinition } from "operon-agents";
import { defineAgent } from "operon-agents-core";
import { PEERS_SERVICE, peers, sharedLabelVisibility, type PeerMemberOptions, type PeerNetworkHandle } from "../src/index.ts";

/** Born a member: the per-session param `peers()` reads to mount the Hub with this identity. */
const asMember = (member: PeerMemberOptions) => ({ params: { [PEERS_SERVICE]: { member } } });

/** A harness-wide observer: every session (spawned teammates included) records what entered its
 *  conversation, keyed by session id — the test's window into sessions it did not create. */
const saw = new Map<string, string[]>();
const spy: ExtensionDefinition = {
  id: "spy",
  session(api) {
    let sessionId: string | undefined;
    api.on("session.start", (event) => { sessionId = event.sessionId; });
    api.onEvent((event) => {
      if (event.type !== "message.appended" || sessionId === undefined) return;
      let list = saw.get(sessionId);
      if (list === undefined) { list = []; saw.set(sessionId, list); }
      list.push(JSON.stringify(event));
    });
  },
};
const sawIn = (sessionId: string | undefined): string => (sessionId === undefined ? "" : (saw.get(sessionId) ?? []).join("|"));

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** A recipient's turn is started fire-and-forget by delivery; give it turns to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  const harness = createHarness({
    model,
    permission: { mode: "yolo" },
    extensions: [
      peers({
        visibility: sharedLabelVisibility,
        team: { type: "lead" },
        // The parameter boundary: the HOST decides what a "schema" teammate is; the model only
        // ever picks a type and a name.
        teammates: { schema: { title: "schema" } },
      }),
      spy,
    ],
  });
  const net = harness.workspaceService<PeerNetworkHandle>(PEERS_SERVICE, { workDir: process.cwd() });
  const rosterEntry = async (id: string) => (await net.list()).find((ref) => ref.agentId === id || ref.name === id);

  const helperRole = defineAgent({ name: "helper", model, instructions: "Do quick work." });
  const leadAgent = defineAgent({ name: "lead", model, instructions: "Coordinate.", subagents: [helperRole] });
  const lead = await harness.createSession({ agent: leadAgent });

  // ── Form a team, spawn a member ─────────────────────────────────────────────────────────
  let leadTools: string[] = [];
  faux.setResponses([
    (context) => {
      leadTools = (context.tools ?? []).map((tool) => tool.name);
      return fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: "db-migration" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(
      fauxToolCall("Team", { op: "spawn", type: "schema", name: "dba", prompt: "state the schema plan" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("team is up", { stopReason: "stop" }),
    // The member's FIRST turn — started by the initial prompt arriving as a peer message.
    fauxAssistantMessage("schema plan ready", { stopReason: "stop" }),
  ]);
  const formed = await lead.prompt("form a team and staff it");
  await settle();

  check("birth: the lead holds Team, not the member Hub", leadTools.includes("Team") && !leadTools.includes("Hub"));

  const leadRef = await rosterEntry(lead.id);
  const dba = await rosterEntry("dba");
  check("team: the lead joined the roster by creating the team", leadRef?.labels?.some((l) => l.endsWith(":db-migration")) === true);
  check("team: the label is namespaced by its creator, so a same-named team elsewhere is a different team", leadRef?.labels?.[0]?.startsWith(`team:${lead.id}:`) === true);
  check("spawn: the teammate is a SESSION under the name the model chose", dba?.kind === "session" && dba.name === "dba" && dba.sessionId !== undefined && dba.sessionId !== "dba");
  check("spawn: its roster id is scoped to the team, so another team's \"dba\" would be a different agent", dba?.agentId === `${leadRef?.labels?.[0]}/dba`);
  check("spawn: born into the team and nothing else", dba?.labels?.length === 1 && dba.labels[0] === leadRef?.labels?.[0]);
  check("spawn: reported to the model without waiting", JSON.stringify(formed.messages).includes("working on it"));

  const dbaSession = dba?.sessionId !== undefined ? harness.getSession(dba.sessionId) : undefined;
  check("spawn: the teammate's session is open on this harness", dbaSession !== undefined);
  check("spawn: the initial prompt reached the member's conversation as a peer message", sawIn(dbaSession?.id).includes("state the schema plan"));

  // ── The member reports back over its Hub; the reply wakes the lead ──────────────────────
  const leadSaw: string[] = [];
  lead.onEvent((event) => { if (event.type === "message.appended" && event.address === "main") leadSaw.push(JSON.stringify(event)); });
  let memberTools: string[] = [];
  faux.setResponses([
    (context) => {
      memberTools = (context.tools ?? []).map((tool) => tool.name);
      return fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "lead", message: "PLAN_READY" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("reported", { stopReason: "stop" }),
    fauxAssistantMessage("got the plan", { stopReason: "stop" }), // the lead's woken turn
  ]);
  await dbaSession!.prompt("report to your lead");
  await settle();
  check("birth: the member holds the Hub, not Team", memberTools.includes("Hub") && !memberTools.includes("Team"));
  check("member: its report reached the lead, addressed as \"lead\" rather than by session id", leadSaw.join("|").includes("PLAN_READY"));
  check("member: framed with the member as actor", leadSaw.join("|").includes('"dba"'));

  // ── The lead steers its member with Team send — scope, not visibility ───────────────────
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "send", to: "dba", message: "REVISE_THE_PLAN" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("steered", { stopReason: "stop" }),
    fauxAssistantMessage("revising", { stopReason: "stop" }), // dba's woken turn
  ]);
  const steered = await lead.prompt("tell dba to revise");
  await settle();
  check("team send: delivered to the member", JSON.stringify(steered.messages).includes("delivered"));
  check("team send: it arrived", sawIn(dbaSession?.id).includes("REVISE_THE_PLAN"));

  // ── Scope holds: someone else's member is out of reach ──────────────────────────────────
  const ops = await harness.createSession(asMember({ name: "ops", team: "team:host:other", type: "ops" }));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "send", to: "ops", message: "SHOULD_NOT_ARRIVE" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("out of scope", { stopReason: "stop" }),
  ]);
  const refused = await lead.prompt("message ops");
  await settle();
  check("team send: reaches ONLY the creator's own members", JSON.stringify(refused.messages).includes("not_visible"));

  // ── And an outside member cannot address this team either ───────────────────────────────
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "dba", message: "SHOULD_NOT_ARRIVE" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("cannot reach it", { stopReason: "stop" }),
  ]);
  const blocked = await ops.prompt("message dba");
  await settle();
  check("boundary: a team is a boundary, not a tag", JSON.stringify(blocked.messages).includes("not_visible"));
  check("boundary: nothing arrived", !sawIn(dbaSession?.id).includes("SHOULD_NOT_ARRIVE"));

  // ── An ordinary delegation never enters the peer world ──────────────────────────────────
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("Agent", { name: "quickie", subagent_type: "helper", description: "quick work", prompt: "do it" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done", { stopReason: "stop" }), // the delegate's inline run
    fauxAssistantMessage("delegation finished", { stopReason: "stop" }),
  ]);
  await lead.prompt("delegate something small");
  await settle();
  check("delegation: an Agent spawn is not on the roster", (await rosterEntry("quickie")) === undefined);

  faux.unregister();
  await harness.close();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
