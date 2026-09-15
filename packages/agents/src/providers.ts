/**
 * Model providers configured by the host, as opposed to the ones the engine ships with.
 *
 * The built-in catalog knows every major provider, but each of those is a fixed list at a fixed
 * URL. A self-hosted endpoint — vLLM, Ollama, LiteLLM, a gateway, a proxy in front of a vendor —
 * is neither: its address is local knowledge, and which models it serves is a question only that
 * endpoint can answer. So a provider here is a URL plus how to authenticate, and its model list is
 * fetched from the endpoint (`GET {baseUrl}/models`, the OpenAI-compatible shape every one of them
 * speaks) rather than declared.
 *
 * The file is `<homeDir>/providers.toml`, so every local host — the TUI, the app server, a script
 * that builds its own harness — sees the same providers without each inventing a config format.
 * Nothing else in the framework reads it: this is the provider registry, not a general config.
 *
 * ```toml
 * # A self-hosted endpoint. Models come from GET http://localhost:8000/v1/models.
 * [providers.local]
 * base_url = "http://localhost:8000/v1"
 * api_key_env = "LOCAL_API_KEY"      # optional; omit for a keyless server
 * context_window = 128000            # the default applied to every model it reports
 *
 * # Per-model facts the endpoint does not report.
 * [providers.local.models."qwen3-coder"]
 * name = "Qwen3 Coder"
 * context_window = 256000
 * reasoning = true
 *
 * # A provider whose models are declared rather than fetched.
 * [providers.corp]
 * base_url = "https://llm.corp.internal/v1"
 * api_key_env = "CORP_API_KEY"
 * fetch_models = false
 * [providers.corp.models."gpt-4o-mini"]
 * context_window = 128000
 * ```
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  createModelRuntime,
  createProvider,
  lazyApi,
  type Api,
  type ApiKeyAuth,
  type Model,
  type ModelRuntime,
  type RefreshModelsContext,
} from "operon-agents-core";

/** The wire dialects a configured endpoint can speak. Almost everything speaks the first. */
export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

const ModelOverrideSchema = z.object({
  name: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  /** Whether the model accepts image input alongside text. */
  vision: z.boolean().optional(),
  api: z.enum(PROVIDER_APIS).optional(),
});

const ProviderEntrySchema = z.object({
  base_url: z.string().min(1),
  /** Display name for pickers; defaults to the provider id. */
  name: z.string().optional(),
  api: z.enum(PROVIDER_APIS).default("openai-completions"),
  /** Environment variable holding the key. Preferred over `api_key`, which lands in the file. */
  api_key_env: z.string().optional(),
  api_key: z.string().optional(),
  /** Ask the endpoint what it serves. Set false to use only the declared `models`. */
  fetch_models: z.boolean().default(true),
  /** Defaults applied to every model this provider reports. */
  context_window: z.number().int().positive().default(128_000),
  max_output_tokens: z.number().int().positive().default(8_192),
  reasoning: z.boolean().default(false),
  vision: z.boolean().default(false),
  headers: z.record(z.string(), z.string()).optional(),
  /** Per-model facts, keyed by the id the endpoint reports. */
  models: z.record(z.string(), ModelOverrideSchema).default({}),
});

export const ProvidersFileSchema = z.object({
  providers: z.record(z.string(), ProviderEntrySchema).default({}),
});

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

export interface LoadedProviders {
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  /** Problems that did not stop the load: a malformed entry, an unreadable file. */
  readonly warnings: readonly string[];
}

export function providersConfigPath(homeDir: string): string {
  return join(homeDir, "providers.toml");
}

/**
 * Read `<homeDir>/providers.toml`. A missing file is the normal case and yields no providers; a
 * malformed one yields none plus a warning, because refusing to start over a config file the host
 * may not even use would be worse than running with the built-in providers alone.
 */
export async function loadProviderConfigs(homeDir: string): Promise<LoadedProviders> {
  let text: string;
  try {
    text = await readFile(providersConfigPath(homeDir), "utf-8");
  } catch {
    return { providers: {}, warnings: [] };
  }
  try {
    const parsed = ProvidersFileSchema.parse(parseToml(text) as Record<string, unknown>);
    return { providers: parsed.providers, warnings: [] };
  } catch (error) {
    return {
      providers: {},
      warnings: [`Ignoring ${providersConfigPath(homeDir)}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * What a keyless endpoint sends as its bearer token. The engine's OpenAI dialect refuses to build a
 * client without one, and a local server that wants no key ignores whatever arrives; pi uses the
 * same literal for the same reason.
 */
const NO_KEY_PLACEHOLDER = "unused";

/** The key this provider authenticates with, or undefined when its env var is declared but unset. */
function configuredKey(entry: ProviderEntry): string | undefined {
  if (entry.api_key !== undefined) return entry.api_key;
  if (entry.api_key_env !== undefined) return process.env[entry.api_key_env];
  return NO_KEY_PLACEHOLDER;
}

/**
 * Auth for an endpoint described by a config file rather than by the engine.
 *
 * The built-in `envApiKeyAuth` resolves from environment variables only, which makes a keyless
 * local server permanently unconfigured — and an unconfigured provider is one the engine never
 * refreshes and never lists, so its models would not exist. Here the config is the credential: an
 * inline key, the named environment variable, or, for a server that wants none, the address alone.
 */
function configAuth(providerId: string, entry: ProviderEntry): ApiKeyAuth {
  return {
    name: `${entry.name ?? providerId} API key`,
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key !== undefined && credential.key.length > 0) {
        return { auth: { apiKey: credential.key }, source: "stored credential" };
      }
      if (entry.api_key !== undefined) {
        return { auth: { apiKey: entry.api_key }, source: "providers.toml" };
      }
      if (entry.api_key_env !== undefined) {
        const value = await ctx.env(entry.api_key_env);
        signal.throwIfAborted();
        // A declared variable that is not set means "configured, but not usable yet" — reporting it
        // as configured would only move the failure to the first request.
        return value ? { auth: { apiKey: value }, source: entry.api_key_env } : undefined;
      }
      return { auth: { apiKey: NO_KEY_PLACEHOLDER }, source: entry.base_url };
    },
  };
}

/** Zero cost: a self-hosted endpoint has no per-token price, and a wrong number is worse than none. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function modelFrom(providerId: string, entry: ProviderEntry, modelId: string): Model<Api> {
  const override = entry.models[modelId];
  return {
    id: modelId,
    name: override?.name ?? modelId,
    api: (override?.api ?? entry.api) as Api,
    provider: providerId,
    baseUrl: entry.base_url,
    reasoning: override?.reasoning ?? entry.reasoning,
    input: (override?.vision ?? entry.vision) ? ["text", "image"] : ["text"],
    cost: NO_COST,
    contextWindow: override?.context_window ?? entry.context_window,
    maxTokens: override?.max_output_tokens ?? entry.max_output_tokens,
    ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
  };
}

/** The model ids an OpenAI-compatible `/models` response lists, in the order the endpoint gave. */
export function parseModelsResponse(body: unknown): readonly string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

async function fetchEndpointModels(
  providerId: string,
  entry: ProviderEntry,
  context: RefreshModelsContext,
): Promise<readonly Model<Api>[]> {
  const declared = Object.keys(entry.models).map((id) => modelFrom(providerId, entry, id));
  if (!entry.fetch_models || !context.allowNetwork) return declared;

  const key = configuredKey(entry);
  const response = await fetch(modelsUrl(entry.base_url), {
    headers: {
      ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}),
      ...entry.headers,
    },
    signal: context.signal,
  });
  if (!response.ok) {
    throw new Error(`${modelsUrl(entry.base_url)} answered ${String(response.status)} ${response.statusText}`);
  }
  const ids = parseModelsResponse(await response.json());
  // The endpoint is authoritative on what it serves; a declared model it does not list stays,
  // because an endpoint that reports nothing (some proxies do) should not empty the picker.
  const fetched = ids.map((id) => modelFrom(providerId, entry, id));
  const seen = new Set(fetched.map((model) => model.id));
  return [...fetched, ...declared.filter((model) => !seen.has(model.id))];
}

/**
 * Turn one config entry into a provider the engine can stream through. Its model list starts at
 * whatever the config declared and is replaced by the endpoint's on the first refresh.
 */
export function providerFromConfig(providerId: string, entry: ProviderEntry) {
  return createProvider({
    id: providerId,
    name: entry.name ?? providerId,
    baseUrl: entry.base_url,
    ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
    auth: { apiKey: configAuth(providerId, entry) },
    models: Object.keys(entry.models).map((id) => modelFrom(providerId, entry, id)),
    fetchModels: (context) => fetchEndpointModels(providerId, entry, context),
    api: dialectStreams(entry.api),
  });
}

/** pi's API implementations load on first use, so an unused dialect is never imported. */
function dialectStreams(api: ProviderApi) {
  switch (api) {
    case "anthropic-messages":
      return lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages"));
    case "openai-responses":
      return lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses"));
    case "openai-completions":
      return lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"));
  }
}

export interface ModelRuntimeFromConfigOptions {
  readonly homeDir: string;
  /**
   * Ask each configured endpoint for its models. Default true. With it off the runtime carries
   * only what the config declared, which is what an offline start wants.
   */
  readonly refresh?: boolean;
  /** Per-endpoint budget for the model-list fetch. Default 5s: a dead endpoint must not hang startup. */
  readonly refreshTimeoutMs?: number;
  readonly onWarning?: (message: string) => void;
}

/**
 * One model runtime carrying the engine's built-in providers plus everything in
 * `<homeDir>/providers.toml`, with each configured endpoint asked what it serves.
 *
 * Hand the same runtime to `defineModel({ provider, model, runtime })` and to
 * `createLocalHarness({ modelRuntime })`, so the model a host resolves and the models its sessions
 * can switch to come from one registry.
 */
export async function createModelRuntimeFromConfig(
  options: ModelRuntimeFromConfigOptions,
): Promise<ModelRuntime> {
  const runtime = createModelRuntime();
  const { providers, warnings } = await loadProviderConfigs(options.homeDir);
  for (const warning of warnings) options.onWarning?.(warning);

  const ids: string[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    if (entry.api_key_env !== undefined && !process.env[entry.api_key_env]) {
      options.onWarning?.(
        `Provider "${id}" reads its key from ${entry.api_key_env}, which is not set; its models will not be listed.`,
      );
    }
    try {
      runtime.models.setProvider(providerFromConfig(id, entry));
      ids.push(id);
    } catch (error) {
      options.onWarning?.(`Provider "${id}" was not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (ids.length === 0 || options.refresh === false) return runtime;

  // An unreachable endpoint is reported, not fatal: the rest of the providers still work, and a
  // model named directly still resolves from whatever the config declared.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.refreshTimeoutMs ?? 5_000);
  try {
    const result = await runtime.models.refresh({ providers: ids, signal: controller.signal });
    for (const [providerId, error] of result.errors) {
      options.onWarning?.(`Could not read models from provider "${providerId}": ${error.message}`);
    }
    if (result.aborted) {
      options.onWarning?.(`Reading models from configured providers timed out after ${String(options.refreshTimeoutMs ?? 5_000)}ms.`);
    }
  } catch (error) {
    options.onWarning?.(`Could not refresh configured providers: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  return runtime;
}
