/**
 * `harness.replaceExtension` — the by-value twin of a file extension's reload, which the old
 * `reshapeService` could not express: a definition whose `harness` half publishes a service
 * (registered NOT replaceable, the by-value default) is swapped whole — process half, service,
 * and session half — inside one barrier. Also covers what a swap must reach: sessions born
 * afterwards, and consumers holding a `uses` handle that were never gated.
 */
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

interface Shape {
  render(): string;
  close(): void;
}

const disposed: string[] = [];

/** The provider: its `harness` publishes "shapes"; its `session` exposes it as a tool. */
const shapes = (version: string): ExtensionDefinition<Shape> => ({
  id: "shapes",
  harness() {
    return { render: () => version, close: () => { disposed.push(version); } };
  },
  session(api, { shared }) {
    api.registerTool({
      name: "Shape",
      description: "Render via this extension's own shared service.",
      parameters: { type: "object", properties: {} },
      execute: () => `shape:${shared.render()}`,
    });
  },
});

/** A separate consumer — never replaced below, so its `uses` handle must survive the swap. */
const consumer = (label: string): ExtensionDefinition<unknown, unknown, { shapes: Shape }> => ({
  id: "consumer",
  uses: ["shapes"],
  session(api, { services }) {
    api.registerTool({
      name: "Consume",
      description: "Consume the provider's service through a uses handle.",
      parameters: { type: "object", properties: {} },
      execute: () => `${label}:${services.shapes.render()}`,
    });
  },
});

async function callTool(
  faux: ReturnType<typeof registerFauxProvider>,
  session: { prompt(input: string): Promise<{ messages: readonly Message[] }> },
  name: string,
): Promise<string> {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("done", { stopReason: "stop" }),
  ]);
  return toolResultText((await session.prompt("go")).messages);
}

async function main(): Promise<void> {
  const faux = registerFauxProvider();
  const harness = createHarness({
    model: faux.getChatModel()!,
    permission: { mode: "yolo" },
    extensions: [shapes("v1"), consumer("old")],
  });

  const a = await harness.createSession();
  check("before: the provider's own session half sees v1", (await callTool(faux, a, "Shape")).includes("shape:v1"));
  check("before: the uses consumer sees v1", (await callTool(faux, a, "Consume")).includes("old:v1"));

  // The whole point: "shapes" was published by a by-value `harness`, so it is NOT replaceable —
  // `services.replace` refuses it. Replacing the extension that owns it is a different act.
  let refused = "";
  await harness.services.replace("shapes", { render: () => "v2", close: () => {} }).catch((error: unknown) => {
    refused = error instanceof Error ? error.message : String(error);
  });
  check("guard: services.replace still refuses a by-value harness() service", refused.includes("not replaceable"));

  await harness.replaceExtension(shapes("v2"));
  check("replace: the session half was rebuilt — the tool renders v2", (await callTool(faux, a, "Shape")).includes("shape:v2"));
  check("replace: the old instance was disposed", disposed.includes("v1"));
  check(
    "replace: an untouched consumer's uses handle lands on the new instance (no gap, no detach)",
    (await callTool(faux, a, "Consume")).includes("old:v2"),
  );

  const born = await harness.createSession();
  check("replace: a session born AFTER the swap gets the new definition", (await callTool(faux, born, "Shape")).includes("shape:v2"));

  // Provider + consumer together: one barrier, one act — what a shape change needs.
  await harness.replaceExtension([shapes("v3"), consumer("new")]);
  check("replace: several definitions swap in one call — provider", (await callTool(faux, a, "Shape")).includes("shape:v3"));
  check("replace: several definitions swap in one call — consumer", (await callTool(faux, a, "Consume")).includes("new:v3"));
  check("replace: sessions born before the swap were swapped too", (await callTool(faux, born, "Consume")).includes("new:v3"));

  // Staging runs every new `harness` BEFORE the barrier, so a throwing one changes nothing.
  let threw = "";
  await harness
    .replaceExtension({ id: "shapes", harness() { throw new Error("boom"); }, session() {} } as ExtensionDefinition)
    .catch((error: unknown) => { threw = error instanceof Error ? error.message : String(error); });
  check("staging: a throwing harness() fails the replace", threw.includes("boom"));
  check("staging: and nothing changed — the live version is still v3", (await callTool(faux, a, "Shape")).includes("shape:v3"));
  check("staging: the consumer still resolves through its handle", (await callTool(faux, a, "Consume")).includes("new:v3"));

  let unknown = "";
  await harness.replaceExtension({ id: "nope", session() {} }).catch((error: unknown) => {
    unknown = error instanceof Error ? error.message : String(error);
  });
  check("replace: an id this harness never registered by value is refused, and says where to register it", unknown.includes('"nope"') && unknown.includes("createHarness"));

  await harness.close();
  check("close: the live instance is disposed with the harness", disposed.includes("v3"));
  faux.unregister();
}

await main();

const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
