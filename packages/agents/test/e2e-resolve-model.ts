/**
 * `ModelManager.register` / `resolveDecision`: what a host's picked model actually sends. The HTTP
 * layer is stubbed; the URLs, auth headers and dialects are the real ones pi produces.
 */
import { DecisionModel, type ModelProviderRegistration } from "../src/advanced.ts";
import { createModelManager, type ChatModel } from "../src/index.ts";

type ChatModelConfig = Omit<ModelProviderRegistration, "id" | "models" | "allowUnlisted"> & { readonly provider: string; readonly model: string };

/** Register the provider on a fresh manager and resolve the one model it names. */
function resolved({ provider, model, ...registration }: ChatModelConfig): ChatModel {
  const manager = createModelManager();
  manager.register({ id: provider, ...registration, ...(registration.api !== undefined ? { models: [model] } : { allowUnlisted: true }) });
  return manager.resolve(`${provider}/${model}`);
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** The first request a model sends, against a stub that rejects it. */
async function firstRequest(model: ChatModel, thinking?: "high"): Promise<{ url: string; auth: string | null; body: string }> {
  const seen: Request[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response('{"error":{"message":"stub"}}', { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    await model.complete({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
      ...(thinking !== undefined ? { params: { reasoning: thinking } } : {}),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const request = seen[0];
  if (request === undefined) throw new Error("the model sent no request");
  // Anthropic Messages authenticates with x-api-key, the other dialects with a bearer token.
  const auth = request.headers.get("x-api-key") ?? request.headers.get("authorization");
  return { url: request.url, auth, body: await request.text() };
}

const config = (fields: Omit<ChatModelConfig, "apiKey">): ChatModelConfig => ({ apiKey: "k", ...fields });

async function testCatalogProviders(): Promise<void> {
  const claude = resolved(config({ provider: "openrouter", model: "anthropic/claude-opus-5.5" }));
  const sent = await firstRequest(claude);
  check("catalog: Claude on OpenRouter uses pi's Messages endpoint", claude.api === "anthropic-messages" && /^https:\/\/openrouter\.ai\/api\/v1\/messages(\?|$)/.test(sent.url));
  check("catalog: the configured key authenticates it", sent.auth === "k");
  check("catalog: Claude gets native deferred tools", claude.supportsDeferredTools);
  check("catalog: Haiku gets them on a gateway too", resolved(config({ provider: "openrouter", model: "anthropic/claude-haiku-5.5" })).supportsDeferredTools);
  check("catalog: a model pi's direct catalog doesn't flag does not", !resolved(config({ provider: "openrouter", model: "anthropic/claude-sonnet-5" })).supportsDeferredTools);

  const glm = resolved(config({ provider: "openrouter", model: "z-ai/glm-4.6" }));
  check("catalog: other OpenRouter models use Chat Completions", glm.api === "openai-completions" && (await firstRequest(glm)).url === "https://openrouter.ai/api/v1/chat/completions");

  const batch = resolved(config({ provider: "openrouter", model: "anthropic/claude-opus-5.5:batch" }));
  check("catalog: a variant pi catalogs on another API stays there", batch.api === "openai-completions");

  const vercel = resolved(config({ provider: "vercel-ai-gateway", model: "zai/glm-5", contextWindow: 1 }));
  check("catalog: Vercel runs every model the way pi catalogs it", vercel.api === "anthropic-messages" && /^https:\/\/ai-gateway\.vercel\.sh\/v1\/messages(\?|$)/.test((await firstRequest(vercel)).url));
  check("catalog: a catalogued model keeps its own limits", vercel.contextWindow === 202_800);

  const moved = resolved(config({ provider: "moonshotai", model: "kimi-k3", baseUrl: "https://api.moonshot.cn/v1" }));
  check("catalog: a baseUrl is used as given", (await firstRequest(moved)).url === "https://api.moonshot.cn/v1/chat/completions");
}

async function testModelsNewerThanCatalog(): Promise<void> {
  const openrouter = resolved(config({ provider: "openrouter", model: "anthropic/claude-opus-9", contextWindow: 123_000, maxTokens: 9_000 }));
  check("new id: runs on the API of the provider's default endpoint", openrouter.api === "openai-completions" && (await firstRequest(openrouter)).url === "https://openrouter.ai/api/v1/chat/completions");
  check("new id: the config limits describe it", openrouter.contextWindow === 123_000 && openrouter.maxOutputTokens === 9_000);

  const vercel = resolved(config({ provider: "vercel-ai-gateway", model: "acme/model-1" }));
  check("new id: Vercel's default endpoint is Messages", vercel.api === "anthropic-messages");

  let threw = false;
  try {
    resolved(config({ provider: "no-such-provider", model: "m" }));
  } catch {
    threw = true;
  }
  check("catalog: an unknown provider without api is a clear error", threw);
}

async function testMistral(): Promise<void> {
  const mistralUrl = "https://api.mistral.ai/v1/chat/completions";
  const known = resolved(config({ provider: "mistral", model: "mistral-large-4" }));
  const sent = await firstRequest(known);
  check("mistral: runs on pi's own dialect", known.api === "mistral-conversations" && sent.url === mistralUrl);
  check("mistral: the configured key authenticates it", sent.auth === "Bearer k");
  check("mistral: no effort is sent unless chosen", (JSON.parse(sent.body) as { reasoning_effort?: string }).reasoning_effort === undefined);
  check("mistral: a chosen effort is sent", (JSON.parse((await firstRequest(known, "high")).body) as { reasoning_effort?: string }).reasoning_effort === "high");
  const unknown = resolved(config({ provider: "mistral", model: "mistral-not-in-the-catalog" }));
  check("mistral: an id newer than the catalog uses the dialect", unknown.api === "mistral-conversations" && (await firstRequest(unknown)).url === mistralUrl);
}

async function testCustomEndpoints(): Promise<void> {
  const chat = resolved(config({ provider: "my-llm", model: "qwen", api: "openai-completions", baseUrl: "https://llm.example.com/v1", contextWindow: 32_000, input: ["text", "image"] }));
  const sent = await firstRequest(chat);
  check("custom: api and baseUrl decide the request", sent.url === "https://llm.example.com/v1/chat/completions" && sent.auth === "Bearer k");
  check("custom: limits come from the config", chat.contextWindow === 32_000);

  const messages = resolved(config({ provider: "proxy", model: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "http://localhost:1235" }));
  check("custom: a Claude on Messages gets native tool changes by id", messages.supportsDeferredTools);

  const keyless = resolved({ provider: "local", model: "m", api: "openai-completions", baseUrl: "http://localhost:1234/v1" });
  check("custom: a server with no key still gets a bearer value", (await firstRequest(keyless)).auth === "Bearer unused");

  let threw = false;
  try {
    resolved(config({ provider: "my-llm", model: "m", api: "openai-completions" }));
  } catch {
    threw = true;
  }
  check("custom: a custom endpoint without baseUrl is a clear error", threw);
}

async function testDecisionModels(): Promise<void> {
  const manager = createModelManager();
  const judge = manager.resolveDecision("vercel-ai-gateway/typesafe-ai/jev", { apiKey: "user-a" });
  check("decision: Jev is recognised", judge instanceof DecisionModel);
  check("decision: an LLM is not", manager.resolveDecision("vercel-ai-gateway/nvidia/nemotron-3.5-lightning-free") === undefined);
  check("decision: an id catalogued as both counts as an LLM", manager.resolveDecision("openai/gpt-6-luna") === undefined);
  check("decision: an unknown id counts as an LLM", manager.resolveDecision("vercel-ai-gateway/no/such-model") === undefined);
  check("decision: a malformed id is simply not one", manager.resolveDecision("no-slash") === undefined);

  let sentKey: unknown;
  const classify = manager.models.classify.bind(manager.models);
  manager.models.classify = (async (_model: unknown, _context: unknown, options?: { apiKey?: string }) => {
    sentKey = options?.apiKey;
    return { stopReason: "stop", answers: {} };
  }) as typeof classify;
  await judge!.classify({ state: {}, questions: {} });
  check("decision: its key goes with the request", sentKey === "user-a");
  check("decision: the key is not written to the shared store", (await manager.credentials.read("vercel-ai-gateway")) === undefined);

  const registered = createModelManager();
  registered.register({ id: "vercel-ai-gateway", apiKey: "shared" });
  check("decision: a registered provider supplies its key", registered.resolveDecision("vercel-ai-gateway/typesafe-ai/jev") instanceof DecisionModel);
  const catalogAddress = registered.models.getModelOfType("classifier", "vercel-ai-gateway", "typesafe-ai/jev")!.baseUrl;
  registered.register({ id: "vercel-ai-gateway", baseUrl: `${catalogAddress}/` });
  check("decision: naming the catalog's own address changes nothing", registered.resolveDecision("vercel-ai-gateway/typesafe-ai/jev") instanceof DecisionModel);
  registered.register({ id: "vercel-ai-gateway", baseUrl: "https://proxy.example.com" });
  check("decision: a provider at its own address has none", registered.resolveDecision("vercel-ai-gateway/typesafe-ai/jev") === undefined);
}

async function main(): Promise<void> {
  await testCatalogProviders();
  await testModelsNewerThanCatalog();
  await testMistral();
  await testCustomEndpoints();
  await testDecisionModels();

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed === checks.length) {
    console.log("✅ RESOLVE-MODEL E2E PASS — catalog providers + new ids + Mistral + custom endpoints + decision models");
  } else {
    console.log("❌ RESOLVE-MODEL E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ RESOLVE-MODEL E2E ERROR:", error);
  process.exit(1);
});
