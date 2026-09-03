/**
 * `harness`-bearing extensions loaded from FILES (design: docs/architecture.md §5.4-5.5): a
 * bundle whose default export has a `harness` half constructs a process-level shared object; the
 * manager runs `harness` once, registers the result as a service under the extension's `id`, and
 * hands the SAME definition to every session (its `session` is the per-session half). Loading is
 * the approval; reloading is one coordinated act (barrier → swap the half → replace the service).
 */
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, type Message } from "../src/index.ts";

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

// One definition, both halves: `harness` returns the shared object (registered under the id
// "shapes"); `session` is the per-session half, reaching it through the `shared` handle.
const sharedSource = (version: string): string => `
export default {
  id: "shapes",
  harness(host) {
    return { render: () => "${version}", dataDir: () => host.dataDir, close: () => {} };
  },
  session(api, { shared }) {
    api.registerTool({
      name: "Shape",
      description: "Render via the shared shape service.",
      parameters: { type: "object", properties: {} },
      execute: () => "${version}-half:" + shared.render(),
    });
  },
};
`;

// A consumer: names the service it `uses` on the definition (no manifest field, no lookup by
// name) and receives it resolved as `ctx.services.shapes`.
const consumerSource = `
export default {
  id: "uses-shape",
  uses: ["shapes"],
  session(api, { services }) {
    const svc = services.shapes;
    api.registerTool({
      name: "Consume",
      description: "Third-party consumer of the shapes service.",
      parameters: { type: "object", properties: {} },
      execute: () => "consumed:" + svc.render(),
    });
  },
};
`;

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "extension-e2e-"));
  const shapesDir = join(dir, "shapes");
  await mkdir(shapesDir);
  await writeFile(join(shapesDir, "manifest.json"), JSON.stringify({ id: "shapes" }));
  await writeFile(join(shapesDir, "index.js"), sharedSource("v1"));

  const consumerDir = join(dir, "uses-shape");
  await mkdir(consumerDir);
  await writeFile(join(consumerDir, "manifest.json"), JSON.stringify({ id: "uses-shape" }));
  await writeFile(join(consumerDir, "index.js"), consumerSource);

  const faux = registerFauxProvider();
  const harness = createHarness({ model: faux.getChatModel()!, permission: { mode: "yolo" }, extensionDir: dir });
  const manager = harness.extensions!;

  const listed = await manager.list();
  check("list: nothing is loaded without approval", listed.every((p) => p.state === "new"));

  // Consumption is checked at load: the consumer cannot load before its provider.
  let fastFailed = "";
  await manager.load("uses-shape").catch((error) => { fastFailed = String(error); });
  check("uses: loading a consumer before its provider fails fast, naming the service", fastFailed.includes('"shapes"'));
  check("uses: the failed load left no approval behind", (await manager.list()).find((p) => p.id === "uses-shape")?.state === "new");

  await manager.load("shapes");
  check("create: loading ran harness() and published the service under the id", harness.services.has("shapes"));
  const dataDir = harness.services.handle<{ dataDir(): string | undefined }>("shapes").dataDir();
  check("create: host.dataDir is a per-extension folder outside the bundle, created up front", dataDir === join(dir, ".data", "shapes") && existsSync(dataDir));
  check("list: the data root is not listed as an extension", !(await manager.list()).some((p) => p.id === ".data"));
  await manager.load("uses-shape");

  const session = await harness.createSession();
  check("session: a new session is born with the per-session half AND the consumer", session.attachedExtensionIds().includes("shapes") && session.attachedExtensionIds().includes("uses-shape"));

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Consume", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  const first = await session.prompt("use both");
  const firstText = toolResultText(first.messages);
  check("session: the per-session half consumes through the shared handle", firstText.includes("v1-half:v1"));
  check("session: the third-party consumer sees the same service", firstText.includes("consumed:v1"));

  // A session that opted out of both (`params: { [id]: false }`) is born with neither, and the
  // reload below must leave it that way.
  const off = await harness.createSession({ params: { shapes: false, "uses-shape": false } });
  check("params: `false` keeps the per-session half off this session", !off.attachedExtensionIds().includes("shapes") && !off.attachedExtensionIds().includes("uses-shape"));

  // ── Reload: edit the file, reload = one coordinated swap (service + per-session half) ──
  await writeFile(join(shapesDir, "index.js"), sharedSource("v2"));
  await utimes(join(shapesDir, "index.js"), new Date(), new Date(Date.now() + 5_000));
  check("trust: the edited extension reports as changed", (await manager.list()).find((p) => p.id === "shapes")?.state === "changed");

  await manager.reload("shapes");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Consume", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done again", { stopReason: "stop" }),
  ]);
  const second = await session.prompt("use both again");
  const secondText = toolResultText(second.messages);
  check("reload: the SAME session now runs the new per-session half against the new service", secondText.includes("v2-half:v2"));
  check("reload: the untouched consumer followed the service swap through its handle", secondText.includes("consumed:v2"));
  check("reload: the opted-out session stayed opted out", !off.attachedExtensionIds().includes("shapes"));

  // ── Unload: refused while a consumer is attached; clean after it is gone ──
  let refused = "";
  await manager.unload("shapes").catch((error) => { refused = String(error); });
  check("unload: refused while a session still runs a consumer, naming it", refused.includes("uses-shape"));

  await session.detachExtension("uses-shape");
  await manager.unload("shapes");
  check("unload: after the consumer detached, the extension unloads and the service is gone", !harness.services.has("shapes"));
  check("unload: the per-session half was removed from the live session", !session.attachedExtensionIds().includes("shapes"));

  await harness.close();
  faux.unregister();
  await rm(dir, { recursive: true, force: true });
}

await main();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
