/**
 * Fleet accounting and the ceiling built on it.
 *
 * `maxTurns` bounds one agent. It cannot stop ten agents each burning their own budget, and it
 * cannot see that they kept waking each other to do it — peer messaging spends money without
 * anyone prompting. So the network measures, and the measurement is what the budget acts on.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness } from "operon-agents";
import { PEERS_SERVICE, peers, sharedLabelVisibility, type PeerMemberOptions, type PeerNetworkHandle, type PeerOptions } from "../src/index.ts";

/** Born a member: the per-session param `peers()` reads to mount the Hub with this identity. */
const asMember = (member: PeerMemberOptions) => ({ params: { [PEERS_SERVICE]: { member } } });

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  /** One harness per scenario, the network reached through its handle like any host would. */
  const open = (options: Omit<PeerOptions, "visibility">) => {
    const harness = createHarness({
      model: faux.getChatModel()!,
      permission: { mode: "yolo" },
      extensions: [peers({ visibility: sharedLabelVisibility, ...options })],
    });
    return { harness, net: harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE) };
  };

  // ── Accounting ──
  {
    const { harness, net } = open({});
    const alice = await harness.createSession(asMember({ name: "alice", team: "t" }));
    await harness.createSession(asMember({ name: "bob", team: "t" }));

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "bob", message: "one" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("sent", { stopReason: "stop" }),
      fauxAssistantMessage("bob replies", { stopReason: "stop" }),
    ]);
    await alice.prompt("ping bob");
    await settle();

    const stats = await net.stats();
    const aliceRow = stats.agents.find((a) => a.agentId === "t/alice");
    const bobRow = stats.agents.find((a) => a.agentId === "t/bob");

    check("stats: the sender is credited with the send", aliceRow?.messagesSent === 1);
    check("stats: the recipient with the receipt", bobRow?.messagesReceived === 1);
    check("stats: an idle recipient counts as a wake", bobRow?.wakes === 1);
    check("stats: token usage is attributed per agent", (aliceRow?.totalTokens ?? 0) > 0 && (bobRow?.totalTokens ?? 0) > 0);
    check("stats: totals aggregate across the fleet", stats.totals.totalTokens === stats.agents.reduce((n, a) => n + a.totalTokens, 0));
    // `usage.updated` reports a run's RUNNING TOTAL; summing raw events would double-count.
    const beforeSecondPrompt = (await net.stats()).totals.totalTokens;
    faux.setResponses([fauxAssistantMessage("just talking", { stopReason: "stop" })]);
    await alice.prompt("say something");
    await settle();
    const afterSecondPrompt = (await net.stats()).totals.totalTokens;
    check("stats: a second run adds a delta, not a duplicate total", afterSecondPrompt > beforeSecondPrompt && afterSecondPrompt < beforeSecondPrompt * 3);

    await harness.close();
  }

  // ── The ceiling ──
  {
    const { harness, net } = open({ budget: { maxWakes: 1 } });
    const alice = await harness.createSession(asMember({ name: "alice", team: "t" }));
    await harness.createSession(asMember({ name: "bob", team: "t" }));

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "bob", message: "first" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("sent one", { stopReason: "stop" }),
      fauxAssistantMessage("bob replies", { stopReason: "stop" }),
    ]);
    const first = await alice.prompt("ping bob");
    await settle();
    check("budget: the first send goes through", JSON.stringify(first.messages).includes("delivered"));
    check("budget: and consumed the wake allowance", (await net.stats()).totals.wakes === 1);

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "bob", message: "second" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("could not send", { stopReason: "stop" }),
    ]);
    const second = await alice.prompt("ping bob again");
    await settle();
    const transcript = JSON.stringify(second.messages);
    check("budget: the next send is refused once the ceiling is reached", transcript.includes("quota_exceeded"));
    check("budget: with the reason spelled out", transcript.includes("wake budget"));
    // The point of pausing rather than aborting: the agent still finished its own turn.
    check("budget: the sender's own run still completed", second.status === "completed");

    await harness.close();
  }

  faux.unregister();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
