/**
 * The `Team` tool advertises the spawnable teammate types up front — their keys and what each is
 * for — so a lead picks a real type instead of guessing one and learning the list from the error.
 *
 * (a) `buildTeamTool` renders the types into its description and the spawn `type` parameter; with
 *     no types it keeps the discover-by-error note and invents no list.
 * (b) Wiring: a lead session on a `peers()` harness actually receives that tool — the types flow
 *     from the extension's `teammates` through `mountTeam` into the schema the model is offered.
 */
import { createHarness } from "operon-agents";
import { fauxAssistantMessage, offeredTools, registerFauxProvider } from "../../agents/test/faux.ts";
import { buildTeamTool, peers, sharedLabelVisibility, type PeerNetworkHandle, type TeammateTypeInfo } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 10));
}

const stub = {} as PeerNetworkHandle;
const types: readonly TeammateTypeInfo[] = [
  { type: "coder", description: "writes and edits code" },
  { type: "reviewer", description: "reviews changes" },
  { type: "researcher" },
];

function rendering(): void {
  const schema = buildTeamTool(stub, () => "lead", {}, types).schema;
  const params = JSON.stringify(schema.parameters);
  check("render: the description lists the spawnable keys", schema.description.includes("coder, reviewer, researcher"));
  check("render: the type parameter lists every type", params.includes("coder") && params.includes("reviewer") && params.includes("researcher"));
  check("render: the type parameter carries each description", params.includes("writes and edits code") && params.includes("reviews changes"));

  const empty = buildTeamTool(stub, () => "lead", {}, []).schema;
  check("render: no types invents no list", !empty.description.includes("Spawnable teammate types"));
  check("render: no types keeps the discover-by-error note", JSON.stringify(empty.parameters).includes("An unknown type fails and lists what is available"));
}

async function leadReceivesTheTypes(): Promise<void> {
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "main" }] });
  const harness = createHarness({
    ...faux.harnessModel(),
    extensions: [peers({
      visibility: sharedLabelVisibility,
      teammates: {
        coder: { description: "writes and edits code" },
        reviewer: { description: "reviews changes" },
        researcher: {},
      },
    })],
    config: { defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
  });
  const lead = await harness.createSession();
  let teamTool: unknown;
  faux.setResponses([
    (context) => {
      teamTool = offeredTools(context).find((tool) => tool.name === "Team");
      return fauxAssistantMessage("done", { stopReason: "stop" });
    },
  ]);
  await lead.prompt("go");
  await settle();
  const rendered = JSON.stringify(teamTool);
  check("wiring: the lead's Team tool lists the configured types", rendered.includes("coder") && rendered.includes("reviewer") && rendered.includes("researcher"));
  check("wiring: … with what each type is for", rendered.includes("writes and edits code") && rendered.includes("reviews changes"));
  await harness.close();
  faux.unregister();
}

async function main(): Promise<void> {
  rendering();
  await leadReceivesTheTypes();
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ TEAM TOOL TYPES E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ TEAM TOOL TYPES E2E PASS — ${checks.length} checks: the Team tool advertises spawnable types up front`);
  process.exit(0);
}

void main();