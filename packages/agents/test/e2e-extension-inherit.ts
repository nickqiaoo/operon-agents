/**
 * `host.createSession({ from, inherit: ["model"] })`: a session an extension creates on behalf of
 * another takes that one's CURRENT model — a runtime `setModel` included, read from storage when
 * the source is not loaded — unless its own `config.model` says otherwise. A source on the harness
 * default has nothing to copy. `inherit` needs `from` and accepts only what it knows.
 */
import { createHarness, type ExtensionDefinition } from "../src/index.ts";
import type { ExtensionHostContext } from "../src/advanced.ts";
import { registerFauxProvider } from "./faux.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function rejects(run: () => Promise<unknown>, needle: string): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(needle);
  }
}

async function main(): Promise<void> {
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "other" }, { id: "third" }] });
  let host: ExtensionHostContext | undefined;
  const capture: ExtensionDefinition = {
    id: "spawner",
    harness(given) {
      host = given;
      return {};
    },
    session() {},
  };
  const harness = createHarness({ ...faux.harnessModel(), extensions: [capture] });
  const create = (options: Parameters<ExtensionHostContext["createSession"]>[0]) => host!.createSession(options);

  const lead = await harness.createSession();
  const onDefault = await create({ from: lead.id, inherit: ["model"] });
  check("default: a source on the harness default has no model to copy", harness.getSession(onDefault.id)?.modelSetting === undefined);

  lead.setModel("faux/other");
  const inherited = await create({ from: lead.id, inherit: ["model"] });
  check("loaded: the source's current model is copied", harness.getSession(inherited.id)?.modelSetting === "faux/other");
  const own = await create({ from: lead.id, inherit: ["model"], config: { model: "faux/third" } });
  check("own: a model the new session names wins", harness.getSession(own.id)?.modelSetting === "faux/third");
  const plain = await create({ from: lead.id });
  check("opt-in: without inherit the model is not copied", harness.getSession(plain.id)?.modelSetting === undefined);

  await harness.closeSession(lead.id);
  const fromStored = await create({ from: lead.id, inherit: ["model"] });
  check("stored: a source that is not loaded is read where it is stored", harness.getSession(lead.id) === undefined && harness.getSession(fromStored.id)?.modelSetting === "faux/other");

  check("refused: inherit needs from", await rejects(() => create({ inherit: ["model"] }), "needs one"));
  check("refused: an unknown setting", await rejects(() => create({ from: lead.id, inherit: ["tools" as "model"] }), "`inherit` lists settings"));

  await harness.close();
  faux.unregister();
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ EXTENSION INHERIT E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ EXTENSION INHERIT E2E PASS — ${checks.length} checks`);
  process.exit(0);
}

void main();
