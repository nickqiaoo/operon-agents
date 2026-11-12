/**
 * One model manager per harness: string ids resolve against it, and providers are registered in
 * place rather than supplied by a resolver from outside.
 */
import { createHarness, createModelManager, type ChatModel } from "../src/index.ts";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "  ok" : "  FAIL"} ${name}`);
  if (!ok) failed += 1;
}

const permission = { mode: "yolo" } as const;

function throws(run: () => unknown): string {
  try {
    run();
    return "";
  } catch (error) {
    return String(error);
  }
}

async function requestOf(model: ChatModel): Promise<{ url: string; auth: string | null; tenant: string | null }> {
  const seen: Request[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    await model.complete({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }] });
  } finally {
    globalThis.fetch = realFetch;
  }
  return { url: seen[0]!.url, auth: seen[0]!.headers.get("authorization"), tenant: seen[0]!.headers.get("x-tenant") };
}

async function stringIdRunsOnTheManager(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("from manager", { stopReason: "stop" })]);
  const id = `${faux.provider.id}/${faux.getModel().id}`;
  const harness = createHarness({
    modelManager: faux.runtime,
    config: { workDir: process.cwd(), defaults: { model: id, permission: permission } }
  });
  const session = await harness.createSession();
  const result = await session.prompt("hi");
  check("a string id runs on the harness manager", result.status === "completed" && result.output.includes("from manager"));
  check("the harness exposes the manager it was given", harness.modelManager === faux.runtime);
  await harness.close();
}

async function providersAreAddedInPlace(): Promise<void> {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("added later", { stopReason: "stop" })]);
  const harness = createHarness({
    config: { workDir: process.cwd(), defaults: { model: `${faux.provider.id}/${faux.getModel().id}`, permission: permission } }
  });
  check("a harness gets its own manager by default", harness.modelManager !== faux.runtime);
  harness.modelManager.models.setProvider(faux.provider);
  const session = await harness.createSession();
  session.setModel(`${faux.provider.id}/${faux.getModel().id}`);
  const result = await session.prompt("hi");
  check("a provider added in place is reachable by id", result.status === "completed" && result.output.includes("added later"));
  await harness.close();
}

async function registrationSemantics(): Promise<void> {
  const manager = createModelManager();
  const endpoint = { id: "my-llm", api: "openai-completions", baseUrl: "https://llm.example.com/v1", models: ["qwen"] } as const;

  manager.register({ ...endpoint, apiKey: "old" });
  check("custom: a listed model resolves", (await requestOf(manager.resolve("my-llm/qwen"))).auth === "Bearer old");
  check("custom: an unlisted model is refused by default", throws(() => manager.resolve("my-llm/typo")).includes("unknown model"));

  manager.register({ ...endpoint, apiKey: "new" });
  check("custom: registering again replaces the key", (await requestOf(manager.resolve("my-llm/qwen"))).auth === "Bearer new");

  manager.register({ ...endpoint, allowUnlisted: true });
  check("custom: allowUnlisted accepts any id", manager.resolve("my-llm/anything").id === "anything");

  manager.unregister("my-llm");
  check("custom: unregister removes the provider", throws(() => manager.resolve("my-llm/qwen")).includes("unknown model"));

  manager.register({ id: "kimi", extends: "moonshotai", baseUrl: "https://api.moonshot.cn/v1", apiKey: "k", allowUnlisted: true });
  const kimi = manager.resolve("kimi/kimi-k3");
  const sent = await requestOf(kimi);
  check("extends: uses the given address and key", sent.url === "https://api.moonshot.cn/v1/chat/completions" && sent.auth === "Bearer k");
  check("extends: keeps the catalog provider id", kimi.provider === "moonshotai");
  check("resolve: a per-call key beats the registered one", (await requestOf(manager.resolve("kimi/kimi-k3", { apiKey: "user-a" }))).auth === "Bearer user-a");

  check("catalog: an unknown provider without api is refused", throws(() => manager.register({ id: "nope" })).includes("not in the catalog"));
  check("custom: a missing baseUrl is refused", throws(() => manager.register({ id: "x", api: "openai-completions" })).includes("baseUrl"));
  check("catalog: an unknown model is refused without registration", throws(() => manager.resolve("anthropic/no-such-model")).includes("unknown model"));
}

async function customEndpointHeadersAndCredentials(): Promise<void> {
  const manager = createModelManager();
  const endpoint = { id: "corp", api: "openai-completions", baseUrl: "https://llm.corp.example/v1", models: ["qwen"], allowUnlisted: true } as const;

  manager.register({ ...endpoint, connection: { headers: { "x-tenant": "acme" }, maxRetries: 3 } });
  check("connection: headers reach a listed model", (await requestOf(manager.resolve("corp/qwen"))).tenant === "acme");
  check("connection: headers reach an unlisted model", (await requestOf(manager.resolve("corp/other"))).tenant === "acme");
  check("connection: retries come from the registration", manager.resolve("corp/qwen").requestRetry.maxRetries === 3);
  const perCall = manager.resolve("corp/qwen", { connection: { maxRetries: 1 } });
  check("connection: a field passed to resolve replaces that field only", perCall.requestRetry.maxRetries === 1 && (await requestOf(perCall)).tenant === "acme");

  manager.register({ id: "kimi", extends: "moonshotai", baseUrl: "https://api.moonshot.cn/v1", apiKey: "k", allowUnlisted: true, connection: { headers: { "x-tenant": "catalog" } } });
  check("connection: applies to a catalog provider too", (await requestOf(manager.resolve("kimi/kimi-k3"))).tenant === "catalog");

  manager.register(endpoint);

  check("auth: a keyless endpoint sends the placeholder", (await requestOf(manager.resolve("corp/qwen"))).auth === "Bearer unused");
  await manager.credentials.modify("corp", async () => ({ type: "api_key", key: "stored" }));
  check("auth: a stored credential is used when no key is registered", (await requestOf(manager.resolve("corp/qwen"))).auth === "Bearer stored");

  manager.register({ ...endpoint, apiKey: "registered" });
  check("auth: a registered key beats a stored credential", (await requestOf(manager.resolve("corp/qwen"))).auth === "Bearer registered");
  check("auth: a per-call key beats a registered one", (await requestOf(manager.resolve("corp/qwen", { apiKey: "user-a" }))).auth === "Bearer user-a");
}

async function harnessModelSettingsReachTheRequest(): Promise<void> {
  const modelManager = createModelManager();
  modelManager.register({ id: "corp", api: "openai-completions", baseUrl: "https://llm.corp.example/v1", apiKey: "k", models: ["qwen"] });
  const bodies: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/chat/completions")) bodies.push(await request.json() as Record<string, unknown>);
    return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    const harness = createHarness({
    modelManager,
    config: { workDir: process.cwd(), defaults: { model: "corp/qwen", modelSettings: { temperature: 0.2, maxTokens: 123 }, permission: permission } }
  });
    const session = await harness.createSession();
    await session.prompt("hi").catch(() => undefined);
    await harness.close();
  } finally {
    globalThis.fetch = realFetch;
  }
  const body = bodies[0];
  check("modelSettings: temperature reaches the default agent's request", body?.temperature === 0.2);
  check("modelSettings: maxTokens reaches the default agent's request", body?.max_tokens === 123 || body?.max_completion_tokens === 123);
}

async function badIdsFailClearly(): Promise<void> {
  const harness = createHarness({
    config: { workDir: process.cwd(), defaults: { model: "no-slash", permission: permission } }
  });
  const session = await harness.createSession();
  const message = await session.prompt("hi").then(() => "", (error: unknown) => String(error));
  check("a malformed id reports the expected form", message.includes("provider/model"));
  await harness.close();
}

await stringIdRunsOnTheManager();
await providersAreAddedInPlace();
await registrationSemantics();
await customEndpointHeadersAndCredentials();
await harnessModelSettingsReachTheRequest();
await badIdsFailClearly();
if (failed > 0) process.exit(1);
console.log("all passed");
