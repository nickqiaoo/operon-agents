/**
 * `create`-bearing extensions BY VALUE — `createHarness({ extensions: [def] })`, the server-side
 * twin of a file bundle in `extensionDir`. The SAME `ExtensionDefinition` (with a `create` half)
 * a bundle would default-export: `create` runs once at construction and its result registers as a
 * service under the id; `setup` runs per session with a handle to it plus this session's `params`.
 * No loader, no approval, no reload — only the channel differs. Also covers per-session `params`
 * and the `false`-skip.
 */
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, type ExtensionDefinition, type Message } from "../src/index.ts";

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

const disposed: string[] = [];

/** A by-value consumer of the `shapes` service: declares it in `uses` (typed through the third
 *  generic) and receives it resolved — never a lookup by name. */
const consumer: ExtensionDefinition<unknown, unknown, { shapes: Shape }> = {
  id: "consumer",
  uses: ["shapes"],
  setup(api, { services }) {
    api.registerTool({
      name: "Consume",
      description: "Consume the shared shape service.",
      parameters: { type: "object", properties: {} },
      execute: () => `consumed:${services.shapes.render()}`,
    });
  },
};

interface Shape { render(): string; close(): void; }

/** The same shape a bundle would default-export; here it is a value in host code. `params` picks
 *  a per-session suffix, and `false` (handled by the framework) skips the extension entirely. */
const shapes = (version: string): ExtensionDefinition<Shape, { suffix?: string }> => ({
  id: "shapes",
  create() {
    return { render: () => version, close: () => { disposed.push(version); } };
  },
  setup(api, { shared, params }) {
    api.registerTool({
      name: "Shape",
      description: "Render via the shared shape service.",
      parameters: { type: "object", properties: {} },
      execute: () => `half:${shared.render()}${params?.suffix ?? ""}`,
    });
  },
});

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  // ── Sync create: registered before createHarness returns; params reach setup ──
  {
    const harness = createHarness({ model, permission: { mode: "yolo" }, extensions: [shapes("v1"), consumer] });
    check("sync: the service is registered the moment createHarness returns", harness.services.has("shapes"));
    check("host: the host consumes it through the same handle sessions use", harness.services.handle<Shape>("shapes").render() === "v1");
    let replaced = "";
    await harness.services.replace("shapes", { render: () => "v2" }).catch((error) => { replaced = String(error); });
    check("value channel: services default to NOT replaceable (a change is a restart)", replaced.includes("not replaceable"));

    const plain = await harness.createSession();
    check("session: born with the extension's per-session half", plain.attachedExtensionIds().includes("shapes"));
    faux.setResponses([fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }), fauxAssistantMessage("ok", { stopReason: "stop" })]);
    check("session: setup reaches the service, no params", toolResultText((await plain.prompt("x")).messages).includes("half:v1"));
    faux.setResponses([fauxAssistantMessage(fauxToolCall("Consume", {}), { stopReason: "toolUse" }), fauxAssistantMessage("ok", { stopReason: "stop" })]);
    check("uses: a consumer receives the provider's service resolved", toolResultText((await plain.prompt("x")).messages).includes("consumed:v1"));

    // params: routed to this session's setup as the third argument.
    const tagged = await harness.createSession({ params: { shapes: { suffix: "-A" } } });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }), fauxAssistantMessage("ok", { stopReason: "stop" })]);
    check("params: this session's params reached its setup", toolResultText((await tagged.prompt("x")).messages).includes("half:v1-A"));

    // params false: the extension is skipped for this session.
    const off = await harness.createSession({ params: { shapes: false } });
    check("params: `false` skips the extension for that session", !off.attachedExtensionIds().includes("shapes"));
    let refused = "";
    await off.attachExtension(shapes("v1")).catch((error) => { refused = String(error); });
    check("params: an explicit attach on an opted-out session is refused, naming the reason", refused.includes("opted out"));

    // params persist across resume: reopen picks the suffix back up without re-passing it.
    faux.setResponses([fauxAssistantMessage(fauxToolCall("Shape", {}), { stopReason: "toolUse" }), fauxAssistantMessage("ok", { stopReason: "stop" })]);
    await tagged.close();
    const reopened = await harness.resumeSession(tagged.id);
    check("params: a resumed session keeps its params without re-passing them", toolResultText((await reopened.prompt("x")).messages).includes("half:v1-A"));

    await harness.close();
    check("close: the service was unregistered and its instance disposed (close())", !harness.services.has("shapes") && disposed.includes("v1"));
  }

  // ── Async create: sessions wait for it; order is preserved ──
  {
    const order: string[] = [];
    const slow: ExtensionDefinition = {
      id: "slow",
      async create() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("slow");
        return { ping: () => "pong" };
      },
      setup() {},
    };
    const after: ExtensionDefinition = {
      id: "after",
      create() { order.push("after"); return { ok: () => true }; },
      setup() {},
    };
    const harness = createHarness({ model, permission: { mode: "yolo" }, extensions: [slow, after] });
    check("async: nothing from an async create is visible synchronously", !harness.services.has("slow") && !harness.services.has("after"));
    await harness.createSession();
    check("async: a session waits until every create has run", harness.services.has("slow") && harness.services.has("after"));
    check("async: creates run in the order given, even across an async one", order.join(",") === "slow,after");
    await harness.close();
  }

  // ── dataDir: by value, a data root is opt-in ──
  {
    let seen: string | undefined;
    const keeper: ExtensionDefinition = { id: "keeper", create(host) { seen = host.dataDir; return {}; }, setup() {} };
    const root = await mkdtemp(join(tmpdir(), "ext-data-"));
    const harness = createHarness({ model, permission: { mode: "yolo" }, extensionDataDir: root, extensions: [keeper] });
    check("dataDir: by value, host.dataDir is <extensionDataDir>/<id>, created before create runs", seen === join(root, "keeper") && existsSync(join(root, "keeper")));
    await harness.close();
    const bare = createHarness({ model, permission: { mode: "yolo" }, extensions: [{ id: "bare", create(host) { seen = host.dataDir; return {}; }, setup() {} }] });
    check("dataDir: without a data root it is undefined", seen === undefined);
    await bare.close();
  }

  // ── Failure modes ──
  {
    // `uses` is checked at registration, in order: a consumer listed before its provider (or
    // with no provider at all) fails createHarness itself, naming the service.
    let unordered = "";
    try {
      createHarness({ model, permission: { mode: "yolo" }, extensions: [consumer, shapes("v1")] });
    } catch (error) {
      unordered = String(error);
    }
    check("uses: a consumer listed before its provider fails at construction, naming the service", unordered.includes('"shapes"'));
  }
  {
    const broken: ExtensionDefinition = {
      id: "broken",
      async create() { throw new Error("boom"); },
      setup() {},
    };
    const harness = createHarness({ model, permission: { mode: "yolo" }, extensions: [broken] });
    let failed = "";
    await harness.createSession().catch((error) => { failed = String(error); });
    check("failure: the create error surfaces where a session is opened", failed.includes("boom"));
    check("failure: a throwing create published nothing", !harness.services.has("broken"));
    await harness.close();
  }
  {
    let captured = "";
    const eager: ExtensionDefinition = {
      id: "eager",
      async create(host) { await host.createSession().catch((error) => { captured = String(error); }); return {}; },
      setup() {},
    };
    const harness = createHarness({ model, permission: { mode: "yolo" }, extensions: [eager] });
    await harness.createSession();
    check("failure: opening a session from inside create() is refused, not deadlocked", captured.includes("inside create()"));
    await harness.close();
  }

  faux.unregister();
}

await main();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
