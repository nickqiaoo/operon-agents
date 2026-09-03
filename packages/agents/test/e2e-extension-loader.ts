import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createExtensionLoader, createHarness, type Message } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function toolResultText(messages: readonly Message[]): string {
  return messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

const echoPluginSource = (tag: string): string => `
export default {
  id: "echo-plugin",
  session(api) {
    api.registerTool({
      name: "PluginEcho",
      description: "Echo from a file plugin.",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      execute: (args) => \`${tag}:\${args.value}\`,
    });
  },
};
`;

async function writePlugin(dir: string, name: string, manifest: object, source: string, mtimeSeconds: number): Promise<string> {
  const pluginDir = join(dir, name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "manifest.json"), JSON.stringify(manifest));
  const entry = join(pluginDir, "index.js");
  await writeFile(entry, source);
  // Pin mtime explicitly so "edited" is unambiguous regardless of filesystem timestamp granularity.
  await utimes(entry, mtimeSeconds, mtimeSeconds);
  return entry;
}

const dir = await mkdtemp(join(tmpdir(), "operon-plugins-"));
const T1 = 1_700_000_000;
const T2 = 1_700_000_100;

const FRAMEWORK_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
await writePlugin(dir, "echo-plugin", { id: "echo-plugin", version: "1.0.0", engine: FRAMEWORK_VERSION, name: "Echo", description: "Echoes its input." }, echoPluginSource("v1"), T1);

const loader = createExtensionLoader({ directory: dir });

// ── Trust: nothing loads before an explicit, manual load() ──
{
  const statuses = await loader.list();
  check("list: display metadata (name, description, version) rides along", statuses[0]?.name === "Echo" && statuses[0]?.description === "Echoes its input." && statuses[0]?.version === "1.0.0");
  check("trust: an unseen plugin lists as 'new'", statuses.length === 1 && statuses[0]?.state === "new");
  const { loaded, skipped } = await loader.loadApproved();
  check("trust: loadApproved never touches an unapproved plugin", loaded.length === 0 && skipped.length === 1 && skipped[0]?.state === "new");
}

// ── Load + attach: the file becomes a live tool on a real session ──
const faux = registerFauxProvider();
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("PluginEcho", { value: "hi" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("v1 done", { stopReason: "stop" }),
  fauxAssistantMessage(fauxToolCall("PluginEcho", { value: "hi" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("v2 done", { stopReason: "stop" }),
]);
const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" } });
const session = await harness.createSession();
{
  const definition = await loader.load("echo-plugin");
  await session.attachExtension(definition);
  const result = await session.prompt("use it");
  check("load: the file plugin's spec tool executes on the session", toolResultText(result.messages).includes("v1:hi"));
  check("load: the plugin now lists as 'loaded'", (await loader.list())[0]?.state === "loaded");
}

// ── Edit: the change is visible but never auto-loaded; reload is the consent ──
{
  await writePlugin(dir, "echo-plugin", { id: "echo-plugin", version: "1.0.1" }, echoPluginSource("v2"), T2);
  check("edit: a changed entry lists as 'changed'", (await loader.list())[0]?.state === "changed");

  // A fresh loader (≈ process restart) must skip the changed file — an agent writing into the
  // plugin dir must not get code executed on next open.
  const restarted = createExtensionLoader({ directory: dir });
  const { loaded, skipped } = await restarted.loadApproved();
  check("edit: after restart, loadApproved skips the changed plugin", loaded.length === 0 && skipped.some((s) => s.state === "changed"));

  const definition = await loader.reloadInto(session, "echo-plugin");
  check("reload: hands back the new module's definition", definition.id === "echo-plugin");
  const result = await session.prompt("use it again");
  check("reload: the session now runs the edited code", toolResultText(result.messages).includes("v2:hi"));
  check("reload: approval rolled forward — lists as 'loaded'", (await loader.list())[0]?.state === "loaded");

  // And a restart AFTER the reload honors the new approval.
  const restartedAfter = createExtensionLoader({ directory: dir });
  const after = await restartedAfter.loadApproved();
  check("reload: after restart the re-approved plugin auto-loads", after.loaded.length === 1 && after.loaded[0]?.id === "echo-plugin");
}

// ── Unload revokes approval ──
{
  await loader.unload("echo-plugin");
  check("unload: approval revoked — back to 'new'", (await loader.list())[0]?.state === "new");

  // ── engine: a bundle built for a newer framework is refused BEFORE its code is imported ──
  await writePlugin(dir, "future-plugin", { id: "future-plugin", version: "1.0.0", engine: "99.0.0" }, echoPluginSource("future"), T1);
  const future = (await loader.list()).find((p) => p.id === "future-plugin");
  check("engine: a bundle needing a newer framework lists as 'error', naming the version", future?.state === "error" && future.error?.includes("99.0.0") === true);
  let refused = "";
  await loader.load("future-plugin").catch((error) => { refused = String(error); });
  check("engine: and cannot be loaded", refused.includes("99.0.0"));
  check("engine: the current framework version satisfies an equal `engine`", (await loader.list()).find((p) => p.id === "echo-plugin")?.state === "new");
  check("unload: definitions() no longer carries it", loader.definitions().length === 0);
}

// ── Shapes and failure modes ──
{
  await writePlugin(dir, "factory-plugin", { id: "factory-plugin" }, `
export default () => ({ id: "factory-plugin", session() {} });
`, T1);
  const definition = await loader.load("factory-plugin");
  check("shape: a factory default export is called to get the definition", definition.id === "factory-plugin");

  await writePlugin(dir, "mismatch-plugin", { id: "mismatch-plugin" }, `
export default { id: "something-else", session() {} };
`, T1);
  const mismatch = await loader.load("mismatch-plugin").then(() => false, () => true);
  check("shape: manifest/code id mismatch rejects", mismatch);

  await mkdir(join(dir, "broken-plugin"), { recursive: true });
  const statuses = await loader.list();
  check("shape: a folder without a manifest lists as 'error'", statuses.some((s) => s.state === "error" && s.dir.endsWith("broken-plugin")));
  check("shape: a broken sibling does not block the healthy ones", statuses.some((s) => s.id === "factory-plugin" && s.state === "loaded"));
}

await harness.close();
faux.unregister();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
