/**
 * What `peers()` makes of a teammate on its own, and how a host finds teammates without a hook.
 *
 * (a) Options as a function of the host, reading a host service named in `uses`, from a FILE
 *     bundle. A reload re-runs the function, so a config change lands: new teammate types, new
 *     creator options, without touching a live session.
 * (b) The member protocol: on by default, replaced by a string, dropped by `false`; a type's own
 *     instructions follow it, after whatever `config.appendSystemPrompt` said.
 * (c) The title: `<name> · <typeTitle>` by default, the type's key standing in for a missing
 *     `typeTitle`; a type's `title` overrides it.
 * (d) The model: the type's when it names one; otherwise the lead's CURRENT model.
 * (e) `teammateOf`: a teammate's identity; `undefined` for an ordinary session and for a fork.
 * (f) A host that finds teammates in `onSessionOpened`: it sees the whole first turn; and when it
 *     throws, the spawn fails, nothing of the session is left (not even its record), and the name
 *     is free for a retry in the same team.
 * (g) A host whose `resolveSession` lays its own setup over every open (a workspace's limits,
 *     say): a teammate keeps its identity, prompt, model and mode across a park and a wake.
 */
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness, resolveSessionConfig, type Harness } from "operon-agents";
import type { AgentEvent } from "operon-agents-core";
import {
  DEFAULT_MEMBER_INSTRUCTIONS,
  PEERS_SERVICE,
  peers,
  sharedLabelVisibility,
  teammateOf,
  type PeerNetworkHandle,
  type PeerOptions,
} from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 10));
}

type Faux = ReturnType<typeof registerFauxProvider>;

const peersUrl = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;
const bundleSource = `
import { peers, sharedLabelVisibility } from ${JSON.stringify(peersUrl)};
export default peers(async (host) => {
  const settings = await host.services["test-host"].settings();
  return {
    visibility: sharedLabelVisibility,
    team: { type: settings.leadType },
    teammates: Object.fromEntries(settings.types.map((type) => [type, { typeTitle: type }])),
  };
}, { uses: ["test-host"] });
`;

/** Have `lead` spawn one teammate (forming `team` first when asked); returns what the turn said. */
async function spawnFrom(lead: { prompt(input: string): Promise<{ messages: unknown }> }, faux: Faux, type: string, name: string, team?: string): Promise<string> {
  faux.setResponses([
    ...(team !== undefined ? [fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: team }), { stopReason: "toolUse" })] : []),
    fauxAssistantMessage(fauxToolCall("Team", { op: "spawn", type, name, prompt: "work" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
    fauxAssistantMessage("teammate reply", { stopReason: "stop" }),
  ]);
  const result = await lead.prompt("go");
  await settle();
  return JSON.stringify(result.messages);
}

/** A lead that forms a team and spawns one teammate of `type`. */
async function spawnOne(harness: Harness, faux: Faux, type: string, name: string): Promise<{ lead: { id: string }; spawned: string }> {
  const lead = await harness.createSession();
  return { lead, spawned: await spawnFrom(lead, faux, type, name, `t-${name}`) };
}

async function fileBundleWithHostOptions(faux: Faux): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "peers-options-e2e-"));
  try {
    const bundleDir = join(dir, "peers");
    await mkdir(bundleDir);
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify({ id: "peers", entry: "index.ts" }));
    await writeFile(join(bundleDir, "index.ts"), bundleSource);

    let settings = { leadType: "captain", types: ["alpha"] };
    let reads = 0;
    const harness = createHarness({
      ...faux.harnessModel(),
      extensionDir: dir,
      services: { "test-host": { settings: async () => { reads += 1; return settings; } } },
      config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
    });
    await harness.extensions!.load("peers");
    const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);
    check("host options: the function read the host service named in uses", reads === 1);

    const first = await spawnOne(harness, faux, "alpha", "a1");
    check("host options: a type from the host's settings spawns", (await net.list()).some((ref) => ref.name === "a1"));
    check("host options: the creator joined with the host's creator type", (await net.getAgent(first.lead.id))?.type === "captain");

    // The host's settings change; a reload re-runs the function.
    settings = { leadType: "skipper", types: ["beta"] };
    await utimes(join(bundleDir, "index.ts"), new Date(), new Date(Date.now() + 5_000));
    await harness.extensions!.reload("peers");
    check("reload: the options were read again", reads === 2);
    const net2 = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);
    const refused = await spawnOne(harness, faux, "alpha", "a2");
    check("reload: a type the new settings dropped is refused", refused.spawned.includes("Unknown teammate type") && !(await net2.list()).some((ref) => ref.name === "a2"));
    const second = await spawnOne(harness, faux, "beta", "b1");
    check("reload: a type the new settings added spawns", (await net2.list()).some((ref) => ref.name === "b1"));
    check("reload: a creator mounted after the reload takes the new creator type", (await net2.getAgent(second.lead.id))?.type === "skipper");
    await harness.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function harnessWith(faux: Faux, options: Partial<PeerOptions>): Harness {
  return createHarness({
    ...faux.harnessModel(),
    extensions: [peers({ visibility: sharedLabelVisibility, ...options })],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
  });
}

/** The session of the roster member called `name`. */
async function memberSession(harness: Harness, name: string) {
  const ref = (await harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE).list()).find((row) => row.name === name);
  return ref === undefined ? undefined : harness.getSession(ref.sessionId);
}

async function titleOf(harness: Harness, sessionId: string | undefined): Promise<string | undefined> {
  return (await harness.listSessions()).find((summary) => summary.id === sessionId)?.title;
}

async function teammateDefaults(faux: Faux): Promise<void> {
  // (b)–(d) with the default protocol.
  const harness = harnessWith(faux, {
    teammates: {
      coder: { typeTitle: "Coder", instructions: "CODER_ORDERS", config: { appendSystemPrompt: "TYPE_PROMPT" } },
      plain: {},
      pinned: { title: "Pinned one", config: { model: "faux/third" } },
    },
  });
  const lead = await harness.createSession();
  // The lead switched models at runtime: that is what an inheriting teammate takes.
  lead.setModel("faux/other");
  await spawnFrom(lead, faux, "coder", "c1", "crew");
  await spawnFrom(lead, faux, "plain", "p1");
  await spawnFrom(lead, faux, "pinned", "x1");

  const coder = await memberSession(harness, "c1");
  const plain = await memberSession(harness, "p1");
  const pinned = await memberSession(harness, "x1");
  const prompt = coder?.config.appendSystemPrompt ?? "";
  check("prompt: the member protocol is there by default", prompt.startsWith(DEFAULT_MEMBER_INSTRUCTIONS));
  check("prompt: an appendSystemPrompt the type set is kept, after the protocol", prompt.indexOf("TYPE_PROMPT") > prompt.indexOf(DEFAULT_MEMBER_INSTRUCTIONS));
  check("prompt: the type's instructions come last", prompt.endsWith("CODER_ORDERS") && prompt.indexOf("CODER_ORDERS") > prompt.indexOf("TYPE_PROMPT"));
  check("prompt: a type without instructions gets the protocol alone", plain?.config.appendSystemPrompt === DEFAULT_MEMBER_INSTRUCTIONS);

  check("title: <name> · <typeTitle> by default", (await titleOf(harness, coder?.id)) === "c1 · Coder");
  check("title: the type's key stands in for a missing typeTitle", (await titleOf(harness, plain?.id)) === "p1 · plain");
  check("title: a type's title overrides the default", (await titleOf(harness, pinned?.id)) === "Pinned one");

  check("model: a type without one takes the lead's current model", coder?.modelSetting === "faux/other" && plain?.modelSetting === "faux/other");
  check("model: a type that names one runs on it", pinned?.modelSetting === "faux/third");

  // (e) teammateOf.
  const identity = coder === undefined ? undefined : teammateOf(coder);
  check("teammateOf: a teammate's identity", identity?.name === "c1" && identity.type === "coder" && identity.team === `team:${lead.id}:crew` && identity.agentId === `team:${lead.id}:crew/c1`);
  check("teammateOf: the session it was spawned from", identity?.creatorSessionId === lead.id);
  check("teammateOf: an ordinary session is not a teammate", teammateOf(lead) === undefined);
  const fork = coder === undefined ? undefined : await harness.forkSession(coder.id);
  check("teammateOf: a fork of a teammate is not one", fork !== undefined && teammateOf(fork) === undefined);
  await harness.close();

  // (b) the protocol replaced, and dropped.
  for (const [memberInstructions, expected, label] of [
    ["HOUSE_RULES", "HOUSE_RULES\n\nCODER_ORDERS", "a string replaces the protocol"],
    [false, "CODER_ORDERS", "false drops the protocol, the type's instructions stay"],
  ] as const) {
    const other = harnessWith(faux, { memberInstructions, teammates: { coder: { instructions: "CODER_ORDERS" } } });
    const otherLead = await other.createSession();
    await spawnFrom(otherLead, faux, "coder", "c2", "crew");
    check(`prompt: ${label}`, (await memberSession(other, "c2"))?.config.appendSystemPrompt === expected);
    await other.close();
  }
  const bare = harnessWith(faux, { memberInstructions: false, teammates: { plain: {} } });
  await spawnFrom(await bare.createSession(), faux, "plain", "p2", "crew");
  check("prompt: nothing to append appends nothing", (await memberSession(bare, "p2"))?.config.appendSystemPrompt === undefined);
  await bare.close();
}

async function hostFindsTeammates(faux: Faux): Promise<void> {
  const harness = harnessWith(faux, { teammates: { member: {} } });
  const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);
  const firstTurn: AgentEvent[] = [];
  let failNext = false;
  let failedId: string | undefined;
  harness.onSessionOpened((session, info) => {
    const member = teammateOf(session);
    if (member === undefined || info.operation !== "create") return;
    if (failNext) {
      failNext = false;
      failedId = session.id;
      throw new Error("HOST_RECORD_BROKE");
    }
    // Subscribed before the session can run: its first turn is seen whole.
    return session.onEvent((event) => {
      if (event.address === "main") firstTurn.push(event);
    });
  });

  const lead = await harness.createSession();
  await spawnFrom(lead, faux, "member", "dba", "ops");
  const types = firstTurn.map((event) => event.type);
  check("observe: the host sees the teammate's turn start", types.includes("agent.started"));
  check("observe: … its assignment arrive", firstTurn.some((event) => event.type === "message.appended" && JSON.stringify(event).includes("work")));
  check("observe: … and its answer", firstTurn.some((event) => event.type === "message.appended" && JSON.stringify(event).includes("teammate reply")));

  // The host cannot set the teammate up: the spawn is rolled back, not half-kept.
  failNext = true;
  const broken = await spawnFrom(lead, faux, "member", "ops");
  check("failure: the lead is told why", broken.includes("Could not create teammate") && broken.includes("HOST_RECORD_BROKE"));
  check("failure: the name is not on the roster", !(await net.list()).some((ref) => ref.name === "ops"));
  check("failure: the session is not open", failedId !== undefined && harness.getSession(failedId) === undefined);
  check("failure: and its record is gone too", failedId !== undefined && (await harness.inspectSession(failedId, { includeDeleted: true })) === undefined);

  // Same lead, same team: the name is free again.
  const retried = await spawnFrom(lead, faux, "member", "ops");
  check("failure: the same name spawns on a retry in the same team", !retried.includes("already taken") && (await net.list()).some((ref) => ref.name === "ops" && ref.labels?.includes(`team:${lead.id}:ops`)));
  await harness.close();
}

async function hostResolvesEveryOpen(faux: Faux): Promise<void> {
  const workspace = { limits: { maxTurns: 7 } };
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [peers({ visibility: sharedLabelVisibility, teammates: { coder: { instructions: "CODER_ORDERS", config: { permission: { mode: "auto" } } } } })],
    // The final config, both on create (over what was asked) and on restore (over what was stored).
    resolveSession: (request) => {
      if (request.operation === "create" && request.origin.kind === "extension") return { config: resolveSessionConfig(workspace, request.requested.config ?? {}) };
      if (request.operation === "restore") return { config: resolveSessionConfig(request.stored ?? {}, workspace) };
      return undefined;
    },
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
  });
  const lead = await harness.createSession();
  lead.setModel("faux/other");
  await spawnFrom(lead, faux, "coder", "c9", "crew");
  const born = await memberSession(harness, "c9");
  check("host config: a new teammate runs on the host's setup and keeps its own", born?.config.limits?.maxTurns === 7 && born.config.appendSystemPrompt?.endsWith("CODER_ORDERS") === true && teammateOf(born) !== undefined);
  const id = born!.id;
  await harness.closeSession(id);

  // A message to the parked teammate wakes it.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "send", to: "c9", message: "again" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("sent", { stopReason: "stop" }),
    fauxAssistantMessage("woken reply", { stopReason: "stop" }),
  ]);
  await lead.prompt("nudge");
  await settle();
  const woken = harness.getSession(id);
  check("wake: the teammate was restored", woken !== undefined && woken !== born);
  check("wake: still a teammate (its seat survived)", woken !== undefined && teammateOf(woken)?.name === "c9");
  check("wake: its prompt survived", woken?.config.appendSystemPrompt === `${DEFAULT_MEMBER_INSTRUCTIONS}\n\nCODER_ORDERS`);
  check("wake: its model and mode survived", woken?.modelSetting === "faux/other" && woken.permissionMode === "auto");
  check("wake: and the host's setup applies again", woken?.config.limits?.maxTurns === 7);
  await harness.close();
}

async function main(): Promise<void> {
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "other" }, { id: "third" }] });
  await fileBundleWithHostOptions(faux);
  await teammateDefaults(faux);
  await hostFindsTeammates(faux);
  await hostResolvesEveryOpen(faux);
  faux.unregister();

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ PEERS OPTIONS E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ PEERS OPTIONS E2E PASS — ${checks.length} checks: teammate prompt, title and model; teammateOf; a host that finds teammates in onSessionOpened`);
  process.exit(0);
}

void main();
