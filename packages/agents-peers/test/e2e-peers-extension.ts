/**
 * `peers(config)` is ONE `ExtensionDefinition` (with a `workspace` half) on TWO channels. The same
 * scenario runs twice:
 *   (a) by value  — `createHarness({ extensions: [peers(cfg)] })`, the server form;
 *   (b) from file — a bundle in `extensionDir` whose default export IS `peers(cfg)`, the desktop
 *                   form, then `reload` under live sessions.
 * The host writes no mount, no member wiring and no service name in either form. A spawned
 * teammate is born with `Hub` ONLY — never `Team`: it is a member, not a team-former.
 */
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness, type Harness } from "operon-agents";
import { PEERS_SERVICE, peers, sharedLabelVisibility, type PeerNetworkHandle } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 10));
}

const peersUrl = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;

// What an author would esbuild-bundle; in-repo the import resolves straight to source. The
// bundle's default export is just `peers(config)` — the identical thing the server passes by
// value. A file repo in the data dir the framework hands the extension (`host.dataDir`, outside
// the bundle) makes the roster survive a reload — and an update that replaces the bundle.
const bundleSource = `
import { createFilePeerRepo, peers, sharedLabelVisibility } from ${JSON.stringify(peersUrl)};

export default peers({
  repo: ({ dataDir }) => createFilePeerRepo(dataDir),
  visibility: sharedLabelVisibility,
  teammates: { member: { title: "teammate" } },
});
`;

type Faux = ReturnType<typeof registerFauxProvider>;

/** Form a team, spawn a teammate, message it — identical on both channels. */
async function exercise(harness: Harness, faux: Faux, label: string) {
  let leadTools: string[] = [];
  const lead = await harness.createSession();
  faux.setResponses([
    (context) => {
      leadTools = (context.tools ?? []).map((tool) => tool.name);
      return fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: "alpha" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("Team", { op: "spawn", type: "member", name: "dba", prompt: "plan the schema" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("team is up", { stopReason: "stop" }),
    fauxAssistantMessage("dba plan ready", { stopReason: "stop" }),
  ]);
  const formed = await lead.prompt("form a team");
  await settle();
  check(`${label}: an ordinary session was born holding Team`, leadTools.includes("Team"));
  check(`${label}: the model was told without waiting`, JSON.stringify(formed.messages).includes("working on it"));

  // Host-side consumption goes through the very same handle the sessions use.
  const peersHandle = harness.workspaceService<PeerNetworkHandle>(PEERS_SERVICE, { workDir: process.cwd() });
  const roster = await peersHandle.list();
  check(`${label}: the lead joined the roster by creating the team`, roster.some((r) => r.agentId === lead.id));
  const dba = roster.find((r) => r.name === "dba");
  check(`${label}: the teammate is a real session the workspace half spawned`, dba?.kind === "session" && dba.sessionId !== undefined && dba.sessionId !== "dba");
  const member = dba?.sessionId !== undefined ? harness.getSession(dba.sessionId) : undefined;
  const memberSaw: string[] = [];
  member?.onEvent((event) => {
    if (event.type === "message.appended") memberSaw.push(JSON.stringify(event));
  });

  // The teammate holds Hub and NOT Team — capability follows birth, and a member is not a former.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "send", to: "dba", message: `PING_${label.toUpperCase()}` }), { stopReason: "toolUse" }),
    fauxAssistantMessage("pinged", { stopReason: "stop" }),
    (context) => {
      const dbaTools = (context.tools ?? []).map((tool) => tool.name);
      check(`${label}: the teammate holds Hub but NOT Team`, dbaTools.includes("Hub") && !dbaTools.includes("Team"));
      return fauxAssistantMessage("dba ack", { stopReason: "stop" });
    },
  ]);
  const sent = await lead.prompt("ping the dba");
  await settle();
  check(`${label}: cross-session delivery, wired entirely by the extension`, JSON.stringify(sent.messages).includes("delivered"));
  check(`${label}: the teammate received it`, memberSaw.join("|").includes(`PING_${label.toUpperCase()}`));
  return { lead, memberSaw };
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  // ── (a) By value: the server form ──
  {
    const harness = createHarness({
      model,
      permission: { mode: "yolo" },
      extensions: [peers({ visibility: sharedLabelVisibility, teammates: { member: { title: "teammate" } } })],
    });
    check("value: the workspace half's service is declared before the first session (a consumer may `uses` it)", harness.services.has(PEERS_SERVICE));
    await exercise(harness, faux, "value");
    await harness.close();
    check("value: closing the harness took the network down with it", !harness.services.has(PEERS_SERVICE));
  }

  // ── (b) From a file: the desktop form, same definition ──
  {
    const dir = await mkdtemp(join(tmpdir(), "peers-extension-e2e-"));
    const bundleDir = join(dir, "peers");
    await mkdir(bundleDir);
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify({ id: "peers", entry: "index.ts" }));
    await writeFile(join(bundleDir, "index.ts"), bundleSource);

    const harness = createHarness({ model, permission: { mode: "yolo" }, extensionDir: dir });
    check("file: nothing is registered before the host loads the bundle", !harness.services.has(PEERS_SERVICE));
    await harness.extensions!.load("peers");
    check("file: loading declared the peers service", harness.services.has(PEERS_SERVICE));
    const { lead, memberSaw } = await exercise(harness, faux, "file");
    check("file: state lives in the extension's data dir, outside the bundle folder", (await readdir(join(dir, ".data", "peers"))).length > 0);

    // Reload under live sessions: new network instance, same data dir → the roster re-seeds
    // and the same lead reaches the same teammate through the handle.
    await writeFile(join(bundleDir, "index.ts"), bundleSource);
    await utimes(join(bundleDir, "index.ts"), new Date(), new Date(Date.now() + 5_000));
    await harness.extensions!.reload("peers");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Team", { op: "send", to: "dba", message: "PING_AFTER_RELOAD" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("pinged again", { stopReason: "stop" }),
      fauxAssistantMessage("dba ack again", { stopReason: "stop" }),
    ]);
    const again = await lead.prompt("ping the dba again");
    await settle();
    check("reload: the SAME lead session messages through the replacement network", JSON.stringify(again.messages).includes("delivered"));
    check("reload: the teammate, untouched, received it (roster re-seeded from the data dir)", memberSaw.join("|").includes("PING_AFTER_RELOAD"));

    await harness.close();
    await rm(dir, { recursive: true, force: true });
  }

  faux.unregister();
}

await main();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
