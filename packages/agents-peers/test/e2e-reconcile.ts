/**
 * Durability: the write-ahead ledger, the restart pass over it, and the card store that keeps
 * parked teammates discoverable across a restart.
 *
 * The window the ledger closes: `steerTo` only puts a message on an in-memory queue, so a crash
 * before the recipient consumes it loses the message. The ledger records it first and clears it
 * only when the recipient's `message.appended` proves it entered their conversation — so whatever
 * is left after a restart is exactly what was lost.
 *
 * The window the cards close: the roster is built from LIVE events, so without them a restart
 * would leave every parked teammate off the roster — undiscoverable, unaddressable, and its
 * stranded messages dropped by reconcile as "unknown recipient".
 *
 * Every "process" here is a harness with `peers({ repo })` registered; the host reaches the
 * network through its handle, the repo is the test's own object.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness } from "operon-agents";
import { createFilePeerRepo, PEERS_SERVICE, peers, sharedLabelVisibility, type PeerMemberOptions, type PeerNetworkHandle, type PeerRepo } from "../src/index.ts";

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
  /** A "process": one harness over the given repo. */
  const boot = (repo: PeerRepo) => {
    const harness = createHarness({
      model: faux.getChatModel()!,
      permission: { mode: "yolo" },
      extensions: [peers({ visibility: sharedLabelVisibility, repo })],
    });
    return { harness, net: harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE) };
  };

  // ── The ledger clears only once the message is really in the recipient's conversation ──
  {
    const dir = await mkdtemp(join(tmpdir(), "peers-repo-"));
    const repo = createFilePeerRepo(dir);
    const { harness } = boot(repo);
    const alice = await harness.createSession(asMember({ name: "alice", team: "t", type: "lead" }));
    const bob = await harness.createSession(asMember({ name: "bob", team: "t", type: "dba", description: "Postgres tuning" }));

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "bob", message: "HELLO_BOB" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("sent", { stopReason: "stop" }),
      fauxAssistantMessage("bob replies", { stopReason: "stop" }),
    ]);
    await alice.prompt("ping bob");
    await settle();

    check("ledger: settles once the recipient consumed it", (await repo.mailbox.pending("t/bob")).length === 0);
    const cards = await readFile(join(dir, "cards.json"), "utf8");
    check("cards: both teammates' identity cards reached disk", cards.includes('"alice"') && cards.includes(bob.id) && cards.includes("Postgres tuning"));
    await harness.close();

    // ── "Restart": a fresh process over the same directory seeds the roster from the cards alone ──
    const restarted = boot(createFilePeerRepo(dir));
    // Through `list()`, the public entry point — it is what awaits seeding.
    const bobRef = (await restarted.net.list()).find((ref) => ref.name === "bob");
    check("seed: a parked teammate is back on the roster with no live event", bobRef?.status === "parked" && bobRef.kind === "session");
    check("seed: its team label and session id survived the restart", bobRef?.labels?.includes("t") === true && bobRef.sessionId === bob.id);
    check("seed: its card survived too", bobRef?.type === "dba" && bobRef.description === "Postgres tuning");
    await restarted.harness.close();
  }

  // ── A recipient that is no longer on the roster is dropped, not retried forever ──
  {
    const dir = await mkdtemp(join(tmpdir(), "peers-repo-"));
    const repo = createFilePeerRepo(dir);
    const { harness, net } = boot(repo);
    await harness.createSession(asMember({ name: "alice", team: "t" }));

    // Planted directly: a live crash cannot be reproduced deterministically here, and the ledger's
    // contract is what matters — an entry survives, and reconcile decides what to do with it.
    await repo.mailbox.enqueue({ messageId: "pm_orphan", from: "alice", to: "agent-that-is-gone", content: "NOWHERE_TO_GO", queuedAt: Date.now() });
    check("ledger: the planted entry survives in the store", (await repo.mailbox.pending("agent-that-is-gone")).length === 1);

    const report = await net.reconcile();
    check("reconcile: an unknown recipient is dropped, not retried forever", report.dropped === 1 && report.redelivered === 0);
    check("reconcile: and the ledger is cleared", (await repo.mailbox.pending("agent-that-is-gone")).length === 0);
    await harness.close();
  }

  // ── Reconcile redelivers to a recipient that IS reachable ──
  {
    const dir = await mkdtemp(join(tmpdir(), "peers-repo-"));
    const repo = createFilePeerRepo(dir);
    const { harness, net } = boot(repo);
    await harness.createSession(asMember({ name: "alice", team: "t" }));
    const bob = await harness.createSession(asMember({ name: "bob", team: "t" }));

    // Plant a ledger entry as if a previous process had died mid-delivery.
    await repo.mailbox.enqueue({ messageId: "pm_lost", from: "t/alice", to: "t/bob", content: "SURVIVED_THE_CRASH", queuedAt: Date.now() });
    const bobSaw: string[] = [];
    bob.onEvent((event) => { if (event.type === "message.appended") bobSaw.push(JSON.stringify(event)); });

    faux.setResponses([fauxAssistantMessage("bob handles the recovered message", { stopReason: "stop" })]);
    const report = await net.reconcile();
    await settle();

    check("reconcile: redelivered the stranded message", report.redelivered === 1 && report.dropped === 0);
    check("reconcile: it reached the recipient's conversation", bobSaw.join("|").includes("SURVIVED_THE_CRASH"));
    check("reconcile: and the ledger cleared itself again", (await repo.mailbox.pending("t/bob")).length === 0);
    await harness.close();
  }

  // ── mailboxCapacity is a hard limit, enforced atomically inside enqueue ──
  {
    const dir = await mkdtemp(join(tmpdir(), "peers-repo-"));
    const repo = createFilePeerRepo(dir);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repo.mailbox.enqueue({ messageId: `pm_${i}`, from: "a", to: "b", content: "x", queuedAt: Date.now() }, { capacity: 2 }),
      ),
    );
    const accepted = results.filter((r) => r.accepted).length;
    check("capacity: concurrent sends cannot overfill the mailbox", accepted === 2 && (await repo.mailbox.pending("b")).length === 2);
  }

  faux.unregister();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
