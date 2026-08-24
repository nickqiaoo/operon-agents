import {
  MemoryCredentialStore,
  ProviderManager,
  applyDeclaredCapability,
  capabilityFromPiModel,
  createModelRuntime,
  UNKNOWN_CAPABILITY,
  type Api,
  type Model,
  type ProviderManagerConfig,
} from "../index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

// A vision, non-reasoning model and a reasoning one — both in pi 0.81's registry.
// The old claude-3-5-haiku-20241022 fixture was removed from that catalog.
const VISION_PROVIDER = "openai";
const VISION_MODEL = "gpt-4o";
const THINKING_MODEL = "claude-haiku-4-5";

const builtins = createModelRuntime();

function getBuiltinModel(provider: string, model: string): Model<Api> {
  const descriptor = builtins.models.getModel(provider, model);
  if (descriptor === undefined) {
    throw new Error(`test fixture is missing from pi catalog: ${provider}/${model}`);
  }
  return descriptor;
}

function testCapabilityDetection(): void {
  const vision = capabilityFromPiModel(getBuiltinModel(VISION_PROVIDER, VISION_MODEL));
  check(
    "capability: detected image_in + context off pi model",
    vision.image_in === true && vision.thinking === false && vision.max_context_tokens === 128000 && vision.tool_use === true,
  );
  const thinking = capabilityFromPiModel(getBuiltinModel("anthropic", THINKING_MODEL));
  check("capability: detected thinking off pi model", thinking.thinking === true);

  // Tags only turn flags ON (union, never downgrade); maxContextSize overrides.
  const overlaid = applyDeclaredCapability(vision, ["video", "audio_in"], 50000);
  check(
    "capability: declared tags union onto detected",
    overlaid.image_in === true && overlaid.video_in === true && overlaid.audio_in === true && overlaid.max_context_tokens === 50000,
  );
  check(
    "capability: UNKNOWN default is tool_use-only",
    UNKNOWN_CAPABILITY.tool_use === true && UNKNOWN_CAPABILITY.image_in === false && UNKNOWN_CAPABILITY.max_context_tokens === undefined,
  );
}

async function testRegistryPath(): Promise<void> {
  const config: ProviderManagerConfig = {
    providers: { openai: { type: "openai", apiKey: "sk-test" } },
    models: { fast: { provider: VISION_PROVIDER, model: VISION_MODEL, maxContextSize: 123456, capabilities: ["thinking"] } },
    defaultModel: "fast",
  };
  const mgr = new ProviderManager({ config });
  const resolved = await mgr.resolveModel("fast");
  check("registry: resolves ChatModel with pi identity", resolved.model.id === VISION_MODEL && resolved.model.provider === VISION_PROVIDER);
  check("registry: api carried from pi descriptor", resolved.model.api === "openai-responses");
  check(
    "registry: capability = detected ∪ declared, config context wins",
    resolved.capability.image_in === true && resolved.capability.thinking === true && resolved.capability.max_context_tokens === 123456,
  );
  check("registry: default model resolves with no arg", (await mgr.resolveModel()).model.id === VISION_MODEL);
}

async function testCustomPath(): Promise<void> {
  const config: ProviderManagerConfig = {
    providers: { local: { type: "openai", baseUrl: "http://localhost:1234/v1", apiKey: "x" } },
    models: { dev: { provider: "local", model: "my-llama", maxContextSize: 32000, capabilities: ["vision"] } },
  };
  const mgr = new ProviderManager({ config });
  const resolved = await mgr.resolveModel("dev");
  check("custom: builds descriptor for unknown model", resolved.model.id === "my-llama" && resolved.model.provider === "local");
  check("custom: wire type → pi api mapping (openai → completions)", resolved.model.api === "openai-completions");
  check(
    "custom: capability from declared tags + maxContextSize",
    resolved.capability.image_in === true && resolved.capability.max_context_tokens === 32000,
  );

  const anthropicProxy = new ProviderManager({
    config: {
      providers: {
        proxy: {
          type: "anthropic",
          baseUrl: "http://localhost:1235",
          apiKey: "x",
        },
      },
      models: {
        sonnet: {
          provider: "proxy",
          model: "claude-sonnet-4-5",
        },
      },
    },
  });
  check(
    "custom: Anthropic alias keeps pi tool-reference compatibility",
    (await anthropicProxy.resolveModel("sonnet")).model.supportsDeferredTools,
  );

  const kimiProxy = new ProviderManager({
    config: {
      providers: {
        moon: {
          type: "kimi",
          baseUrl: "http://localhost:1236/v1",
          apiKey: "x",
        },
      },
      models: {
        kimi: {
          provider: "moon",
          model: "private-kimi",
        },
      },
    },
  });
  check(
    "custom: Kimi endpoint gets pi deferred-tools mode",
    (await kimiProxy.resolveModel("kimi")).model.supportsDeferredTools,
  );

  // Unknown model with no baseUrl to build from → clear error, not a silent bad model.
  const broken = new ProviderManager({
    config: { providers: { p: { type: "openai" } }, models: { m: { provider: "p", model: "nope" } } },
  });
  let threw = false;
  try {
    await broken.resolveModel("m");
  } catch {
    threw = true;
  }
  check("custom: unknown model + no baseUrl throws", threw);
}

async function testFallbackRef(): Promise<void> {
  // Zero `models` config: a bare provider/model ref still resolves via pi's registry.
  const mgr = new ProviderManager({ config: { providers: {}, models: {} } });
  const resolved = await mgr.resolveModel(`${VISION_PROVIDER}/${VISION_MODEL}`);
  check("fallback: provider/model ref resolves with empty config", resolved.model.id === VISION_MODEL);

  let threw = false;
  try {
    await mgr.resolveModel("bare-no-slash");
  } catch {
    threw = true;
  }
  check("fallback: non-ref unknown model throws", threw);
}

async function testProviderOwnedAuth(): Promise<void> {
  const noAmbientAuth = {
    env: async () => undefined,
    fileExists: async () => false,
  };

  let resolverCalls = 0;
  const resolverManager = new ProviderManager({
    config: {
      providers: {
        anthropic: {
          type: "anthropic",
          oauth: { storage: "file", key: "anthropic" },
        },
      },
      models: {
        m: {
          provider: "anthropic",
          model: THINKING_MODEL,
        },
      },
    },
    authContext: noAmbientAuth,
    resolveApiKey: async () => {
      resolverCalls += 1;
      return "oauth-token";
    },
  });
  const resolverModel = await resolverManager.resolveModel("m");
  check(
    "auth: alias resolution does not acquire a secret",
    resolverCalls === 0,
  );
  const resolvedSecret = await resolverManager.runtime.models.getAuth(
    getBuiltinModel(resolverModel.model.provider, resolverModel.model.id),
  );
  check(
    "auth: host resolver is provider-owned and request-scoped",
    resolverCalls === 1 && resolvedSecret?.auth.apiKey === "oauth-token",
  );

  const explicitManager = new ProviderManager({
    config: {
      providers: { openai: { type: "openai", apiKey: "sk-explicit" } },
      models: {},
    },
    authContext: noAmbientAuth,
  });
  await explicitManager.resolveModel(`${VISION_PROVIDER}/${VISION_MODEL}`);
  check(
    "auth: explicit config key is resolved by Models.getAuth",
    (await explicitManager.runtime.models.getAuth("openai"))?.auth.apiKey ===
      "sk-explicit",
  );

  let unusedResolverCalls = 0;
  const nonOAuthManager = new ProviderManager({
    config: {
      providers: { openai: { type: "openai", apiKey: "sk-config" } },
      models: {},
    },
    authContext: noAmbientAuth,
    resolveApiKey: async () => {
      unusedResolverCalls += 1;
      return "should-not-win";
    },
  });
  check(
    "auth: host OAuth resolver is skipped for non-OAuth config",
    (await nonOAuthManager.runtime.models.getAuth("openai"))?.auth.apiKey ===
      "sk-config" && unusedResolverCalls === 0,
  );

  const envManager = new ProviderManager({
    config: {
      providers: {
        openai: {
          type: "openai",
          env: { OPENAI_API_KEY: "sk-env" },
        },
      },
      models: {},
    },
    authContext: noAmbientAuth,
  });
  await envManager.resolveModel(`${VISION_PROVIDER}/${VISION_MODEL}`);
  check(
    "auth: provider env overlay feeds pi ambient auth",
    (await envManager.runtime.models.getAuth("openai"))?.auth.apiKey ===
      "sk-env",
  );

  const legacyEnvManager = new ProviderManager({
    config: {
      providers: {
        local: {
          type: "openai",
          baseUrl: "http://localhost:1234/v1",
        },
      },
      models: {
        local: {
          provider: "local",
          model: "my-local-model",
        },
      },
    },
    authContext: noAmbientAuth,
    env: { LOCAL_API_KEY: "sk-local" },
  });
  await legacyEnvManager.resolveModel("local");
  check(
    "auth: provider-id env overlay remains supported",
    (await legacyEnvManager.runtime.models.getAuth("local"))?.auth.apiKey ===
      "sk-local",
  );

  const credentials = new MemoryCredentialStore();
  await credentials.modify("openai", async () => ({
    type: "api_key",
    key: "sk-stored",
  }));
  const storedManager = new ProviderManager({
    config: {
      providers: { openai: { type: "openai", apiKey: "sk-config" } },
      models: {},
    },
    credentials,
    authContext: noAmbientAuth,
  });
  await storedManager.resolveModel(`${VISION_PROVIDER}/${VISION_MODEL}`);
  check(
    "auth: canonical stored credential wins over config fallback",
    (await storedManager.runtime.models.getAuth("openai"))?.auth.apiKey ===
      "sk-stored",
  );

  const emptyManager = new ProviderManager({
    config: {
      providers: { openai: { type: "openai" } },
      models: {},
    },
    authContext: noAmbientAuth,
  });
  await emptyManager.resolveModel(`${VISION_PROVIDER}/${VISION_MODEL}`);
  check(
    "auth: unconfigured provider resolves no auth",
    (await emptyManager.runtime.models.getAuth("openai")) === undefined,
  );
}

async function testModelResolverAdapter(): Promise<void> {
  const mgr = new ProviderManager({
    config: { providers: { openai: { type: "openai", apiKey: "x" } }, models: { m: { provider: VISION_PROVIDER, model: VISION_MODEL, maxContextSize: 128000 } } },
  });
  const resolve = mgr.modelResolver();
  const model = await resolve("m");
  check("adapter: modelResolver returns the ChatModel", model.id === VISION_MODEL && typeof model.stream === "function");
}

async function main(): Promise<void> {
  testCapabilityDetection();
  await testRegistryPath();
  await testCustomPath();
  await testFallbackRef();
  await testProviderOwnedAuth();
  await testModelResolverAdapter();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ PROVIDER E2E PASS — structured capability + ProviderManager (registry/custom/fallback/provider-owned auth)");
  } else {
    console.log("❌ PROVIDER E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ PROVIDER E2E ERROR:", error);
  process.exit(1);
});
