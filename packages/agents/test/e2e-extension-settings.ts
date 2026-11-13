/**
 * Extension settings: a manifest declares them (a JSON Schema subset), the framework validates,
 * stores and defaults them, the extension reads them as `host.settings` / `ctx.settings`, and a
 * host reads and writes them through `harness.extensions` — loaded or not.
 *
 * - The schema subset: a supported schema passes; anything outside it is refused when the
 *   manifest is read (the folder lists as `error`), never silently ignored.
 * - Reading is lenient: defaults fill what is missing, unknown keys are dropped, an invalid field
 *   falls back to its default and is reported — and the extension still loads.
 * - Writing is strict: an invalid value is refused with its issues and nothing is stored.
 * - A write to a loaded extension reloads it: `host.settings` is the new value, an open session
 *   keeps running and its half sees the new value too.
 * - An extension that is not loaded (not even approved) can be read and written.
 * - A host's own `ExtensionSettingsStore` is used instead of the files.
 * - The values are not in the extension's `dataDir`: writing there changes nothing.
 */
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, ExtensionSettingsInvalidError, type ExtensionSettingsStore, type Message, type SettingsSchema } from "../src/index.ts";
import { resolveSettings, validateSettings, validateSettingsSchema } from "../src/advanced.ts";

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

const SCHEMA = {
  type: "object",
  properties: {
    greeting: { type: "string", title: "Greeting", default: "hello", maxLength: 20 },
    level: { type: "integer", minimum: 0, maximum: 9, default: 1 },
    mode: { type: "string", format: "permission-mode", default: "workspace" },
    model: { type: "string", format: "model" },
    flags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    budget: {
      type: "object",
      properties: { max: { type: "integer", minimum: 0, default: 100 }, soft: { type: "boolean" } },
    },
    kinds: {
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      default: { builtin: { title: "Built in" } },
      additionalProperties: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" }, notes: { type: "string", "x-multiline": true } },
      },
    },
  },
} as const satisfies SettingsSchema;

// Reports what each half was handed; writes into its own dataDir to show that changes nothing.
const source = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
let runs = 0;
export default {
  id: "configured",
  async harness(host) {
    runs += 1;
    const settings = host.settings;
    await writeFile(join(host.dataDir, "tamper.json"), JSON.stringify({ greeting: "TAMPERED" }));
    return { settings: () => settings, runs: () => runs, frozen: () => Object.isFrozen(settings) };
  },
  session(api, { settings }) {
    api.registerTool({
      name: "Show",
      description: "Show the settings this session's half was given.",
      parameters: { type: "object", properties: {} },
      execute: () => "SEEN:" + JSON.stringify(settings),
    });
  },
};
`;

function schemaChecks(): void {
  check("schema: a schema inside the subset passes", validateSettingsSchema(SCHEMA).length === 0);
  const refused = (schema: unknown, needle: string): boolean => validateSettingsSchema(schema).some((issue) => issue.message.includes(needle));
  check("schema: an unsupported keyword is refused by name", refused({ type: "object", properties: { x: { type: "string", oneOf: [] } } }, '"oneOf" is not supported'));
  check("schema: x-secret is not supported yet", refused({ type: "object", properties: { token: { type: "string", "x-secret": true } } }, '"x-secret" is not supported'));
  check("schema: a keyword for another type is refused", refused({ type: "object", properties: { n: { type: "integer", maxLength: 3 } } }, '"maxLength" does not apply to a integer'));
  check("schema: an unknown keyword is refused", refused({ type: "object", properties: { n: { type: "integer", widget: "slider" } } }, 'unknown keyword "widget"'));
  check("schema: a default that does not fit is refused", refused({ type: "object", properties: { n: { type: "integer", minimum: 5, default: 1 } } }, '"default" is not a valid value'));
  check("schema: an unknown format is refused", refused({ type: "object", properties: { c: { type: "string", format: "color" } } }, '"format" must be one of'));
  check("schema: the root must be an object", refused({ type: "string" }, "must be an object schema"));

  const strict = validateSettings(SCHEMA, { level: 12, mode: "sideways", kinds: { Bad: { title: "x" }, ok: {} }, extra: 1 });
  const paths = strict.map((issue) => issue.path);
  check("write: every issue is reported at its path", ["level", "mode", "kinds.Bad", "kinds.ok.title", "extra"].every((path) => paths.includes(path)));
  check("write: a valid value has no issues", validateSettings(SCHEMA, { greeting: "hi", kinds: { mine: { title: "Mine" } }, flags: ["a"] }).length === 0);

  const read = resolveSettings(SCHEMA, { greeting: 42, level: 3, junk: true, budget: { soft: true }, kinds: { mine: { title: "Mine" }, Nope: { title: "x" }, broken: { notes: "no title" } } });
  const value = read.value as Record<string, any>;
  check("read: a missing field takes its default", value.mode === "workspace");
  check("read: a missing field of a nested object takes its default", value.budget?.max === 100 && value.budget?.soft === true);
  check("read: an invalid field falls back to its default", value.greeting === "hello" && read.issues.some((issue) => issue.path === "greeting"));
  check("read: a valid field is kept", value.level === 3);
  check("read: an unknown key is dropped", !("junk" in value));
  check("read: a stored table replaces the default one", value.kinds?.mine?.title === "Mine" && value.kinds?.builtin === undefined);
  check("read: a table entry under a bad key, or missing a required field, is dropped and reported", value.kinds?.Nope === undefined && value.kinds?.broken === undefined
    && read.issues.some((issue) => issue.path === "kinds.Nope") && read.issues.some((issue) => issue.path === "kinds.broken"));
  const empty = resolveSettings(SCHEMA, undefined).value as Record<string, any>;
  check("read: nothing stored reads as every default", empty.greeting === "hello" && empty.level === 1 && empty.kinds?.builtin?.title === "Built in" && empty.budget?.max === 100 && empty.model === undefined);
  check("read: stored garbage reads as the defaults, reported", resolveSettings(SCHEMA, "garbage").issues.length === 1);
}

async function harnessChecks(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "extension-settings-e2e-"));
  try {
    const extDir = join(dir, "configured");
    await mkdir(extDir);
    await writeFile(join(extDir, "manifest.json"), JSON.stringify({ id: "configured", name: "Configured", settings: SCHEMA }));
    await writeFile(join(extDir, "index.js"), source);
    const badDir = join(dir, "bad");
    await mkdir(badDir);
    await writeFile(join(badDir, "manifest.json"), JSON.stringify({ id: "bad", settings: { type: "object", properties: { x: { type: "string", oneOf: [] } } } }));
    await writeFile(join(badDir, "index.js"), "export default { id: 'bad', session() {} };");

    const faux = registerFauxProvider();
    const harness = createHarness({ ...faux.harnessModel(), extensionDir: dir });
    const manager = harness.extensions!;

    const listed = await manager.list();
    const bad = listed.find((status) => status.id === "bad");
    check("manifest: a schema outside the subset makes the folder unusable", bad?.state === "error" && (bad.error ?? "").includes('"oneOf" is not supported'));
    const configured = listed.find((status) => status.id === "configured");
    check("list: settings are reported before the code is loaded", configured?.state === "new" && configured.settings?.value.greeting === "hello" && configured.settings.schema.type === "object");

    // Not loaded, not approved: read and write anyway.
    const settingsFile = join(dir, ".settings", "configured.json");
    let refusal: unknown;
    try {
      await manager.setSettings("configured", { level: 99 });
    } catch (error) {
      refusal = error;
    }
    check("write: an invalid value is refused with its issues", refusal instanceof ExtensionSettingsInvalidError && refusal.issues.some((issue) => issue.path === "level"));
    check("write: and nothing was stored", !existsSync(settingsFile));
    await manager.setSettings("configured", { greeting: "hi", level: 2, kinds: { mine: { title: "Mine" } } });
    check("unloaded: a valid value is stored", JSON.parse(await readFile(settingsFile, "utf8")).greeting === "hi");
    check("unloaded: writing settings neither loads nor approves", (await manager.list()).find((status) => status.id === "configured")?.state === "new");
    check("unloaded: reading returns the stored value over the defaults", (await manager.getSettings("configured"))?.value.mode === "workspace" && (await manager.getSettings("configured"))?.value.greeting === "hi");

    // An invalid stored value (an update changed the schema, say) still loads.
    await writeFile(settingsFile, JSON.stringify({ greeting: "hi", level: "three", gone: 1 }));
    await manager.load("configured");
    const service = harness.services.handle<{ settings(): Promise<Record<string, any>>; runs(): Promise<number>; frozen(): Promise<boolean> }>("configured");
    const first = await service.settings();
    check("load: an invalid stored field reads as its default, and the extension loads", first.level === 1 && first.greeting === "hi" && !("gone" in first));
    check("load: the issue is reported to the host", (await manager.getSettings("configured"))?.issues.some((issue) => issue.path === "level") === true);
    check("load: host.settings is read-only", await service.frozen());

    // A session open across the change.
    const session = await harness.createSession();
    const show = async (): Promise<string> => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("Show", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("shown", { stopReason: "stop" }),
      ]);
      return toolResultText((await session.prompt("show")).messages);
    };
    check("session: its half is handed the settings", (await show()).includes('"greeting":"hi"'));

    await manager.setSettings("configured", { greeting: "changed", kinds: {} });
    check("change: the extension was reloaded — harness ran again", (await service.runs()) === 2);
    check("change: host.settings is the new value", (await service.settings()).greeting === "changed");
    check("change: the open session was not interrupted", harness.getSession(session.id) === session && session.status.state !== "closed");
    check("change: and its half now sees the new value", (await show()).includes('"greeting":"changed"'));
    check("change: an emptied table stays empty (the default does not come back)", JSON.stringify((await service.settings()).kinds) === "{}");

    // dataDir is the extension's own; its settings are elsewhere.
    const dataDir = join(dir, ".data", "configured");
    check("dataDir: the extension wrote into its data folder", existsSync(join(dataDir, "tamper.json")));
    check("dataDir: the settings are not in it", !settingsFile.startsWith(dataDir) && (await manager.getSettings("configured"))?.value.greeting === "changed");

    // Concurrent writes land one at a time, last one wins.
    await Promise.all([
      manager.setSettings("configured", { greeting: "one" }),
      manager.setSettings("configured", { greeting: "two" }),
    ]);
    check("concurrent: writes are serialized, the last one is what is stored and read", (await service.settings()).greeting === "two" && (await service.runs()) === 4);
    await harness.close();

    // A host's own store.
    const kept = new Map<string, unknown>([["configured", { greeting: "from-host-store" }]]);
    const puts: string[] = [];
    const store: ExtensionSettingsStore = {
      get: async (id) => kept.get(id),
      put: async (id, value) => {
        puts.push(id);
        kept.set(id, value);
      },
    };
    const hosted = createHarness({ ...faux.harnessModel(), extensionDir: dir, extensionSettings: store });
    await hosted.extensions!.load("configured");
    const hostedService = hosted.services.handle<{ settings(): Promise<Record<string, any>> }>("configured");
    check("store: a host's store is read", (await hostedService.settings()).greeting === "from-host-store");
    await hosted.extensions!.setSettings("configured", { greeting: "written" });
    check("store: and written, instead of the files", puts.includes("configured") && JSON.parse(await readFile(settingsFile, "utf8")).greeting === "two");
    await hosted.close();
    faux.unregister();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  schemaChecks();
  await harnessChecks();
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ EXTENSION SETTINGS E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ EXTENSION SETTINGS E2E PASS — ${checks.length} checks`);
  process.exit(0);
}

void main();
