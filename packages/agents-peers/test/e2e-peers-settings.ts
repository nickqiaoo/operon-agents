/**
 * `peers` configured by its own settings — no host service at all.
 *
 * (a) `peersOptionsFromSettings`: each field becomes the option it stands for; an unset model is
 *     left out (so the teammate inherits its lead's), and the result layers under `peers()`'s own
 *     defaults (member protocol, title).
 * (b) A FILE bundle whose manifest declares `PEERS_SETTINGS_SCHEMA`, loaded into a harness that
 *     registers no services: it forms a team and spawns from the types in its settings, and a
 *     settings change (`harness.extensions.setSettings`) reloads it onto the new types and budget.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../agents/test/faux.ts";
import { createHarness, type Harness } from "operon-agents";
import { validateSettingsSchema } from "operon-agents/advanced";
import {
  DEFAULT_MEMBER_INSTRUCTIONS,
  PEERS_SERVICE,
  PEERS_SETTINGS_SCHEMA,
  peersOptionsFromSettings,
  type PeerNetworkHandle,
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

function conversion(): void {
  check("schema: PEERS_SETTINGS_SCHEMA is inside the supported subset", validateSettingsSchema(PEERS_SETTINGS_SCHEMA).length === 0);
  const options = peersOptionsFromSettings({
    budget: { maxWakes: 7, maxTotalTokens: 1000 },
    types: {
      coder: { title: "Coder", description: "Writes code", model: "faux/third", permissionMode: "auto", instructions: "Write tests." },
      helper: { title: "Helper", permissionMode: "workspace" },
    },
  });
  const coder = options.teammates?.coder as Record<string, any> | undefined;
  const helper = options.teammates?.helper as Record<string, any> | undefined;
  check("convert: the budget passes through", options.budget?.maxWakes === 7 && options.budget.maxTotalTokens === 1000);
  check("convert: title → typeTitle, description, instructions", coder?.typeTitle === "Coder" && coder.description === "Writes code" && coder.instructions === "Write tests.");
  check("convert: model → config.model, permissionMode → config.permission.mode", coder?.config?.model === "faux/third" && coder.config.permission?.mode === "auto");
  check("convert: no model ⇒ no config.model (the lead's is inherited)", helper !== undefined && helper.config?.model === undefined && helper.config?.permission?.mode === "workspace");
  check("convert: no settings ⇒ no options", Object.keys(peersOptionsFromSettings(undefined)).length === 0);
  check("convert: no types ⇒ no teammates option", peersOptionsFromSettings({ budget: {} }).teammates === undefined);
}

const peersUrl = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;
const bundleSource = `
import { createFilePeerRepo, peers, peersOptionsFromSettings, sharedLabelVisibility } from ${JSON.stringify(peersUrl)};
export default peers((host) => ({
  visibility: sharedLabelVisibility,
  repo: createFilePeerRepo(host.dataDir),
  team: { type: "lead" },
  ...peersOptionsFromSettings(host.settings),
}));
`;

async function spawn(harness: Harness, faux: Faux, type: string, name: string): Promise<{ lead: { id: string }; said: string }> {
  const lead = await harness.createSession();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Team", { op: "create", name: `t-${name}` }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Team", { op: "spawn", type, name, prompt: "work" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
    fauxAssistantMessage("teammate reply", { stopReason: "stop" }),
  ]);
  const said = JSON.stringify((await lead.prompt("go")).messages);
  await settle();
  return { lead, said };
}

async function bundle(faux: Faux): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "peers-settings-e2e-"));
  try {
    const bundleDir = join(dir, "peers");
    await mkdir(bundleDir);
    // What a product's packaging does: the schema, with its own default types and budget.
    const schema = structuredClone(PEERS_SETTINGS_SCHEMA) as any;
    schema.properties.types.default = { coder: { title: "Coder", instructions: "CODER_ORDERS" } };
    schema.properties.budget.properties.maxWakes.default = 50;
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify({ id: "peers", name: "Teams", entry: "index.ts", settings: schema }));
    await writeFile(join(bundleDir, "index.ts"), bundleSource);

    // No `services`: nothing host-specific for the bundle to lean on.
    const harness = createHarness({
      ...faux.harnessModel(),
      extensionDir: dir,
      config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
    });
    const view = await harness.extensions!.getSettings("peers");
    check("bundle: the product defaults are what it reads before anything is set", (view?.value.types as any)?.coder?.title === "Coder" && (view?.value.budget as any)?.maxWakes === 50);
    await harness.extensions!.load("peers");
    const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);

    const first = await spawn(harness, faux, "coder", "c1");
    const c1 = (await net.list()).find((ref) => ref.name === "c1");
    const c1Session = c1 === undefined ? undefined : harness.getSession(c1.sessionId);
    check("bundle: a default type spawns with no host service registered", c1 !== undefined && first.said.includes("working on it"));
    check("bundle: the teammate's prompt is the protocol, then the type's instructions", c1Session?.config.appendSystemPrompt === `${DEFAULT_MEMBER_INSTRUCTIONS}\n\nCODER_ORDERS`);
    check("bundle: its permission mode is the schema default", c1Session?.permissionMode === "workspace");
    check("bundle: its title uses the type's title", (await harness.listSessions()).find((summary) => summary.id === c1?.sessionId)?.title === "c1 · Coder");
    check("bundle: the teammates talk over Hub", (await harness.readSessionMessages(c1!.sessionId)).items.some((item) => item.kind === "message" && JSON.stringify(item.message).includes("work")));

    await harness.extensions!.setSettings("peers", {
      budget: { maxWakes: 3 },
      types: { reviewer: { title: "Reviewer", model: "faux/other", permissionMode: "manual" } },
    });
    const net2 = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE);
    const dropped = await spawn(harness, faux, "coder", "c2");
    check("settings change: a type no longer configured is refused", dropped.said.includes("Unknown teammate type"));
    await spawn(harness, faux, "reviewer", "r1");
    const r1 = (await net2.list()).find((ref) => ref.name === "r1");
    const r1Session = r1 === undefined ? undefined : harness.getSession(r1.sessionId);
    check("settings change: a new type spawns, on its own model and mode", r1Session?.modelSetting === "faux/other" && r1Session.permissionMode === "manual");
    check("settings change: the roster survived the reload (file repo in dataDir)", (await net2.list()).some((ref) => ref.name === "c1"));
    await harness.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "other" }, { id: "third" }] });
  conversion();
  await bundle(faux);
  faux.unregister();
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ PEERS SETTINGS E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ PEERS SETTINGS E2E PASS — ${checks.length} checks: peers runs on its own settings, no host service`);
  process.exit(0);
}

void main();
