/**
 * `peers(options, { uses })` with options computed from the host, and the `onTeammateCreated` hook.
 *
 * (a) Options as a function of the host, reading a host service named in `uses`, from a FILE
 *     bundle — the desktop form. A reload re-runs the function, so a config change lands: new
 *     teammate types, new creator options, without touching a live session.
 * (b) `onTeammateCreated` runs once the teammate exists and holds its seat, BEFORE its
 *     assignment is routed — its transcript is still empty when the hook sees it.
 * (c) A hook that throws aborts the spawn: the creator is told, the session is closed, the seat
 *     is freed, and the same name can be spawned again.
 */
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness, type Harness } from "operon-agents";
import { PEERS_SERVICE, peers, sharedLabelVisibility, type PeerMemberOptions, type PeerNetworkHandle } from "../src/index.ts";

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
    teammates: Object.fromEntries(settings.types.map((type) => [type, { title: type }])),
  };
}, { uses: ["test-host"] });
`;

/** A lead that forms a team and spawns one teammate of `type`; returns what `Team spawn` said. */
async function spawnOne(harness: Harness, faux: Faux, type: string, name: string): Promise<{ lead: { id: string }; spawned: string }> {
  const lead = await harness.createSession();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: `t-${name}` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Team", { op: "spawn", type, name, prompt: "work" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
    fauxAssistantMessage("teammate reply", { stopReason: "stop" }),
  ]);
  const result = await lead.prompt("go");
  await settle();
  return { lead, spawned: JSON.stringify(result.messages) };
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

async function onTeammateCreated(faux: Faux): Promise<void> {
  let harness: Harness | undefined;
  const seen: Array<{ sessionId: string; member: PeerMemberOptions; itemsAtHook: number; loaded: boolean }> = [];
  let failNext = false;
  harness = createHarness({
    ...faux.harnessModel(),
    extensions: [
      peers({
        visibility: sharedLabelVisibility,
        teammates: { member: { title: "teammate" } },
        async onTeammateCreated(sessionId, member) {
          const page = await harness!.readSessionMessages(sessionId);
          seen.push({ sessionId, member, itemsAtHook: page.items.length, loaded: harness!.getSession(sessionId) !== undefined });
          if (failNext) {
            failNext = false;
            throw new Error("HOST_SETUP_BROKE");
          }
        },
      }),
    ],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
  });
  const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);

  await spawnOne(harness, faux, "member", "dba");
  const hook = seen[0];
  check("hook: called once for the spawn", seen.length === 1);
  check("hook: told the session and the member identity", hook !== undefined && hook.member.name === "dba" && hook.member.type === "member" && hook.member.team.startsWith("team:"));
  check("hook: the session is loaded when it runs", hook?.loaded === true);
  check("hook: it runs before the assignment is routed — the transcript is still empty", hook?.itemsAtHook === 0);
  const dba = (await net.list()).find((ref) => ref.name === "dba");
  check("hook: afterwards the teammate got its assignment", dba !== undefined && (await harness.readSessionMessages(dba.sessionId)).items.some((item) => item.kind === "message" && JSON.stringify(item.message).includes("work")));

  // A hook that throws: the spawn is abandoned, not half-kept.
  failNext = true;
  const broken = await spawnOne(harness, faux, "member", "ops");
  const failed = seen[1];
  check("failure: the creator is told why", broken.spawned.includes("HOST_SETUP_BROKE") && broken.spawned.includes("could not be set up"));
  check("failure: the seat left the roster", !(await net.list()).some((ref) => ref.name === "ops"));
  check("failure: the session was closed", failed !== undefined && harness.getSession(failed.sessionId) === undefined);
  check("failure: no assignment was routed to it", failed !== undefined && (await harness.readSessionMessages(failed.sessionId)).items.filter((item) => item.kind === "message" && item.origin?.kind === "external").length === 0);

  // The name is free again: the same lead's team takes "ops" on a retry.
  const lead = await harness.createSession();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: "retry" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Team", { op: "spawn", type: "member", name: "ops", prompt: "again" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
    fauxAssistantMessage("ops reply", { stopReason: "stop" }),
  ]);
  await lead.prompt("retry");
  await settle();
  check("failure: the freed name can be spawned again", (await net.list()).some((ref) => ref.name === "ops"));
  await harness.close();
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  await fileBundleWithHostOptions(faux);
  await onTeammateCreated(faux);
  faux.unregister();

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ PEERS OPTIONS E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ PEERS OPTIONS E2E PASS — ${checks.length} checks: host-computed options reload, and the teammate setup hook gates the spawn`);
  process.exit(0);
}

void main();
