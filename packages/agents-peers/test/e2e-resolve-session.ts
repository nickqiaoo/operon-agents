import assert from "node:assert/strict";
/**
 * Peer delivery brings a closed recipient back through `harness.resumeSession(id)`: restored from
 * what is stored with it, plus whatever the host's `resolveSession` supplies — and refused, not
 * opened on defaults, when the host refuses. A teammate is created on behalf of its lead, and a
 * fork of a teammate does not take its seat.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness, LocalEnvironment } from "operon-agents";
import { PEERS_SERVICE, peers, createPeerNetwork, sharedLabelVisibility, type PeerMemberOptions, type PeerNetworkHandle } from "../src/index.ts";

const asMember = (member: PeerMemberOptions) => ({ config: { extensions: { [PEERS_SERVICE]: { member } } } });

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** The recipient's turn is started fire-and-forget by delivery. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

const REOPENED_MARK = "REOPENED_WITH_RESOLVED_OPTIONS";

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  /** Every recipient `host restoration` was asked about, in order. */
  const resolvedFor: string[] = [];
  let failResolve = false;
  const harness = createHarness({
    ...faux.harnessModel(),
    resolveSession: ({ operation, session, stored }) => {
      if (operation !== "restore") return;
      resolvedFor.push(session.id);
      if (failResolve) throw new Error("NO_ASSEMBLY_FOR_SESSION");
      return { config: { ...stored, appendSystemPrompt: REOPENED_MARK } };
    },
    extensions: [
      peers({
        visibility: sharedLabelVisibility,
      }),
    ],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });

  const alice = await harness.createSession(asMember({ name: "alice", team: "team:host:alpha" }));
  const bob = await harness.createSession(asMember({ name: "bob", team: "team:host:alpha" }));

  // Which request is whose depends on timing, so every one is recorded.
  let requests: string[] = [];
  const recorded = (message: ReturnType<typeof fauxAssistantMessage>) => (context: unknown) => {
    requests.push(JSON.stringify(context));
    return message;
  };
  const send = async (message: string): Promise<string> => {
    requests = [];
    faux.setResponses([
      recorded(fauxAssistantMessage(fauxToolCall("Hub", { op: "send", to: "bob", message }), { stopReason: "toolUse" })),
      recorded(fauxAssistantMessage("sent", { stopReason: "stop" })),
      recorded(fauxAssistantMessage("bob answers", { stopReason: "stop" })),
    ]);
    const result = await alice.prompt(`send ${message}`);
    await settle();
    return JSON.stringify(result.messages);
  };

  // ── An open recipient is handed the message as it stands ──
  await send("WHILE_OPEN");
  check("open: host restoration is not asked", resolvedFor.length === 0);
  check("open: the recipient keeps what it was created with", requests.every((request) => !request.includes(REOPENED_MARK)));

  // ── A closed one is reopened with what the host resolves ──
  await bob.close();
  check("closed: the recipient is no longer open", harness.getSession(bob.id) === undefined);
  const woken = await send("WAKE_UP");
  check("closed: the send is delivered", woken.includes("delivered"));
  check("closed: host restoration is asked once, for that recipient", resolvedFor.length === 1 && resolvedFor[0] === bob.id);
  const reopened = harness.getSession(bob.id);
  check("closed: delivery reopened it", reopened !== undefined && reopened !== bob);
  const withMark = requests.filter((request) => request.includes(REOPENED_MARK));
  check("closed: its turn runs on the resolved options", withMark.length === 1 && withMark[0]!.includes("WAKE_UP"));
  check("closed: and on the history it had before", withMark[0]?.includes("WHILE_OPEN") === true);

  // ── Open again: not asked a second time, not rebuilt ──
  await send("STILL_OPEN");
  check("reopened: host restoration is not asked again", resolvedFor.length === 1);
  check("reopened: the same instance takes the message", harness.getSession(bob.id) === reopened);

  // ── A resolve that fails does not fall back to the harness's defaults ──
  await reopened!.close();
  failResolve = true;
  const refused = await send("NEVER_ARRIVES");
  check("failure: the delivery is reported unreachable, with the cause", refused.includes("unreachable") && refused.includes("NO_ASSEMBLY_FOR_SESSION"));
  check("failure: the session is not opened on defaults", harness.getSession(bob.id) === undefined);

  // The standalone network still requires an explicit host operation.
  // @ts-expect-error The lower-level factory has the same requirement.
  assert.throws(() => createPeerNetwork({ visibility: sharedLabelVisibility }), /requires a host resumeSession/);
  check("configuration: missing host restoration is rejected immediately", true);

  // ── A fork of a teammate is an ordinary session: it does not take the teammate's seat ──
  failResolve = false;
  const network = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);
  const seatBefore = (await network.getAgent("team:host:alpha/alice"))?.sessionId;
  const fork = await harness.forkSession(alice.id);
  check("fork: the member identity is not copied", fork.config.extensions?.[PEERS_SERVICE] === undefined);
  check("fork: the roster still points at the original", seatBefore === alice.id && (await network.getAgent("team:host:alpha/alice"))?.sessionId === alice.id);

  faux.unregister();
  await harness.close();
  await spawnedOnBehalfOfTheLead();
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

/** A teammate is created from its lead: same directory and owner, and never outside the lead's sandbox. */
async function spawnedOnBehalfOfTheLead(): Promise<void> {
  const faux = registerFauxProvider();
  const spawn = (name: string) => [
    fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: "crew" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Team", { op: "spawn", type: "helper", name, prompt: "hello" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("spawned", { stopReason: "stop" }),
    fauxAssistantMessage("helper here", { stopReason: "stop" }),
  ];
  const definition = () => peers({ visibility: sharedLabelVisibility, teammates: { helper: { title: "helper" } } });
  const dir = process.cwd();

  // No host resolver: the lead runs in a sandbox, so a teammate without one is refused.
  const bare = createHarness({
    ...faux.harnessModel(),
    extensions: [definition()],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const sandboxed = await bare.createSession({ bindings: { environment: new LocalEnvironment(dir) } });
  faux.setResponses(spawn("one"));
  const refused = JSON.stringify((await sandboxed.prompt("spawn a helper")).messages);
  await settle();
  check("spawn: a sandboxed lead's teammate is not opened on the harness's own machine", refused.includes("Could not create teammate") && bare.sessions.size === 1);
  check("spawn: the refusal names what is missing", refused.includes("needs environment provided"));
  await bare.close();

  // With one: it is asked for the teammate, told who it is created from.
  const sources: Array<string | undefined> = [];
  const hosted = createHarness({
    ...faux.harnessModel(),
    extensions: [definition()],
    resolveSession: ({ operation, origin, session, source }) => {
      if (operation === "create" && origin.kind === "extension") sources.push(source?.id);
      return { bindings: { environment: new LocalEnvironment(session.workDir) } };
    },
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const lead = await hosted.createSession({ workDir: dir, ownerKey: "tenant-a" });
  faux.setResponses(spawn("two"));
  await lead.prompt("spawn a helper");
  await settle();
  const teammate = [...hosted.sessions.values()].find((session) => session.id !== lead.id);
  check("spawn: the host is asked for the teammate, with its lead as the source", sources.length === 1 && sources[0] === lead.id);
  check("spawn: the teammate takes its lead's directory and owner", teammate?.workDir === lead.workDir && teammate?.ownerKey === "tenant-a");
  check("spawn: and runs in an environment of its own", teammate?.requires.includes("environment") === true && teammate.environment !== lead.environment);
  await hosted.close();
  faux.unregister();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
