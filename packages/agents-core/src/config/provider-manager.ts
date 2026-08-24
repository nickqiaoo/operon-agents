import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  createProvider,
  defaultProviderAuthContext,
  type ApiKeyAuth,
  type AuthContext,
  type AuthResult,
  type CredentialStore,
  type Model,
  type ModelsStore,
  type Provider,
  type ProviderAuth,
  type ProviderHeaders,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  ChatModel,
  FileCredentialStore,
  UNKNOWN_CAPABILITY,
  applyDeclaredCapability,
  capabilityFromPiModel,
  createModelRuntime,
  type ModelCapability,
  type ModelRuntime,
} from "../llm/index.ts";
import type { Api, KnownApi } from "../protocol/index.ts";
import type {
  ModelCredentialsConfig,
  ProviderConfig,
  ProviderType,
} from "./schema.ts";

export interface ResolvedModel {
  readonly model: ChatModel;
  readonly capability: ModelCapability;
  readonly maxOutputSize?: number;
  readonly providerName: string;
}

export type ApiKeyResolver = (
  providerName: string,
  providerConfig: ProviderConfig,
) => string | undefined | Promise<string | undefined>;

export interface ProviderManagerConfig {
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: Readonly<Record<string, ResolvableAlias>>;
  readonly defaultModel?: string;
  readonly modelCredentials?: ModelCredentialsConfig;
}

export interface ResolvableAlias {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize?: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

export interface ProviderManagerOptions {
  readonly config: ProviderManagerConfig | (() => ProviderManagerConfig);
  /** Reuse a caller-owned pi provider/auth/catalog collection. */
  readonly runtime?: ModelRuntime;
  readonly credentials?: CredentialStore;
  readonly modelsStore?: ModelsStore;
  readonly authContext?: AuthContext;
  /** Legacy convenience overlay; `authContext` is the canonical injection. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional product secret resolver. It is compiled into provider-owned
   * ApiKeyAuth (not called while resolving an alias).
   */
  readonly resolveApiKey?: ApiKeyResolver;
}

export class ProviderManager {
  private readonly options: ProviderManagerOptions;
  readonly runtime: ModelRuntime;
  private readonly baseProviders = new Map<string, Provider>();
  private readonly overlayFingerprints = new Map<string, string>();

  constructor(options: ProviderManagerOptions) {
    this.options = options;
    const initialConfig = this.config;
    const authContext = overlayOptionalAuthContext(
      options.authContext ?? defaultProviderAuthContext(),
      options.env,
    );
    const credentials =
      options.credentials ??
      credentialStoreFromConfig(initialConfig.modelCredentials);
    this.runtime = options.runtime ?? createModelRuntime({
      ...(credentials !== undefined ? { credentials } : {}),
      ...(options.modelsStore !== undefined ? { modelsStore: options.modelsStore } : {}),
      authContext,
    });
    for (const provider of this.runtime.models.getProviders()) {
      this.baseProviders.set(provider.id, provider);
    }
    this.syncConfiguredProviders(initialConfig);
  }

  private get config(): ProviderManagerConfig {
    const c = this.options.config;
    return typeof c === "function" ? c() : c;
  }

  get defaultModel(): string | undefined {
    return this.config.defaultModel;
  }

  async resolveModel(modelRef?: string): Promise<ResolvedModel> {
    const config = this.config;
    this.syncConfiguredProviders(config);

    const ref = modelRef ?? config.defaultModel;
    if (ref === undefined || ref.length === 0) {
      throw new Error("provider manager: no model specified and config has no defaultModel");
    }

    const alias = this.resolveAlias(ref, config);
    const piModel = this.runtime.models.getModel(alias.provider, alias.model);
    if (piModel === undefined) {
      const providerConfig = config.providers[alias.provider];
      if (providerConfig?.baseUrl === undefined || providerConfig.baseUrl.length === 0) {
        throw new Error(
          `provider manager: model "${alias.provider}/${alias.model}" is unknown to pi and ` +
            `provider "${alias.provider}" has no baseUrl to build a custom endpoint`,
        );
      }
      throw new Error(
        `provider manager: configured provider "${alias.provider}" did not expose model "${alias.model}"`,
      );
    }

    return {
      model: new ChatModel({
        runtime: this.runtime,
        descriptor: piModel,
      }),
      capability: applyDeclaredCapability(
        capabilityFromPiModel(piModel),
        alias.capabilities,
        alias.maxContextSize,
      ),
      maxOutputSize: alias.maxOutputSize,
      providerName: alias.provider,
    };
  }

  modelResolver(): (modelId: string) => Promise<ChatModel> {
    return async (id) => (await this.resolveModel(id)).model;
  }

  private resolveAlias(
    ref: string,
    config: ProviderManagerConfig,
  ): ResolvableAlias {
    const declared = config.models[ref];
    if (declared !== undefined) return declared;
    const slash = ref.indexOf("/");
    if (slash > 0 && slash < ref.length - 1) {
      return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
    }
    throw new Error(
      `provider manager: model "${ref}" is not in config.models and is not a "provider/model" ref`,
    );
  }

  private syncConfiguredProviders(config: ProviderManagerConfig): void {
    const configured = new Set(Object.keys(config.providers));
    for (const providerId of this.overlayFingerprints.keys()) {
      if (configured.has(providerId)) continue;
      this.restoreBaseProvider(providerId);
      this.overlayFingerprints.delete(providerId);
    }

    for (const [providerId, providerConfig] of Object.entries(config.providers)) {
      const aliases = Object.values(config.models).filter(
        (alias) => alias.provider === providerId,
      );
      const fingerprint = JSON.stringify({ providerConfig, aliases });
      if (this.overlayFingerprints.get(providerId) === fingerprint) continue;
      const provider = this.buildConfiguredProvider(
        providerId,
        providerConfig,
        aliases,
      );
      this.runtime.models.setProvider(provider);
      this.overlayFingerprints.set(providerId, fingerprint);
    }
  }

  private restoreBaseProvider(providerId: string): void {
    const base = this.baseProviders.get(providerId);
    if (base !== undefined) this.runtime.models.setProvider(base);
    else this.runtime.models.deleteProvider(providerId);
  }

  private buildConfiguredProvider(
    providerId: string,
    config: ProviderConfig,
    aliases: readonly ResolvableAlias[],
  ): Provider {
    const base = this.baseProviderFor(providerId, config.type);
    const models = configuredModels(providerId, config, aliases, base);
    return createProvider({
      id: providerId,
      name: base?.name ?? providerId,
      baseUrl: config.baseUrl ?? base?.baseUrl,
      headers: mergeHeaders(base?.headers, config.customHeaders),
      auth: configuredAuth(
        providerId,
        config,
        base?.auth,
        this.options.resolveApiKey,
      ),
      models,
      api: API_IMPLEMENTATIONS,
    });
  }

  private baseProviderFor(
    providerId: string,
    type: ProviderType,
  ): Provider | undefined {
    return (
      this.baseProviders.get(providerId) ??
      this.baseProviders.get(builtinProviderIdForType(type))
    );
  }
}

function credentialStoreFromConfig(
  config: ModelCredentialsConfig | undefined,
): CredentialStore | undefined {
  return config === undefined
    ? undefined
    : new FileCredentialStore(resolveCredentialPath(config.path));
}

/**
 * `~` is the user's home. Relative paths are workspace/process-cwd relative;
 * layered TOML has no single source file whose directory could own them.
 */
function resolveCredentialPath(configuredPath: string): string {
  const expanded =
    configuredPath === "~"
      ? homedir()
      : configuredPath.startsWith("~/")
        ? join(homedir(), configuredPath.slice(2))
        : configuredPath;
  return resolvePath(expanded);
}

function configuredModels(
  providerId: string,
  config: ProviderConfig,
  aliases: readonly ResolvableAlias[],
  base: Provider | undefined,
): Model<Api>[] {
  const byId = new Map<string, Model<Api>>();
  for (const model of base?.getModels() ?? []) {
    byId.set(model.id, configureKnownModel(model, providerId, config));
  }
  for (const alias of aliases) {
    if (byId.has(alias.model)) continue;
    // Unknown catalog entries need an explicit endpoint. Without one, leave
    // them absent so resolveModel reports the same actionable error as before.
    if (config.baseUrl === undefined || config.baseUrl.length === 0) continue;
    byId.set(alias.model, buildCustomPiModel(alias, providerId, config));
  }
  return [...byId.values()];
}

function configureKnownModel(
  model: Model<Api>,
  providerId: string,
  config: ProviderConfig,
): Model<Api> {
  return {
    ...model,
    provider: providerId,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.customHeaders !== undefined
      ? { headers: { ...(model.headers ?? {}), ...config.customHeaders } }
      : {}),
    ...(config.type === "kimi"
      ? { compat: { ...model.compat, deferredToolsMode: "kimi" as const } }
      : config.type === "anthropic"
        ? {
            compat: {
              ...model.compat,
              supportsToolReferences: defaultAnthropicToolReferences(model.id),
            },
          }
      : {}),
  };
}

function buildCustomPiModel(
  alias: ResolvableAlias,
  providerId: string,
  providerConfig: ProviderConfig,
): Model<Api> {
  const tags = new Set((alias.capabilities ?? []).map((c) => c.trim().toLowerCase()));
  const input: ("text" | "image")[] =
    tags.has("image") || tags.has("image_in") || tags.has("vision")
      ? ["text", "image"]
      : ["text"];
  const api = apiForProviderType(providerConfig.type);
  const compat =
    providerConfig.type === "kimi"
      ? { deferredToolsMode: "kimi" as const }
      : providerConfig.type === "anthropic"
        ? { supportsToolReferences: defaultAnthropicToolReferences(alias.model) }
        : undefined;
  return {
    id: alias.model,
    name: alias.displayName ?? alias.model,
    api,
    provider: providerId,
    baseUrl: providerConfig.baseUrl as string,
    reasoning:
      tags.has("thinking") ||
      tags.has("reasoning") ||
      tags.has("always_thinking"),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: alias.maxContextSize ?? 0,
    maxTokens: alias.maxOutputSize ?? 4096,
    ...(providerConfig.customHeaders !== undefined
      ? { headers: providerConfig.customHeaders }
      : {}),
    ...(compat !== undefined ? { compat } : {}),
  };
}

function configuredAuth(
  providerId: string,
  config: ProviderConfig,
  base: ProviderAuth | undefined,
  resolveApiKey: ApiKeyResolver | undefined,
): ProviderAuth {
  return {
    apiKey: configuredApiKeyAuth(
      providerId,
      config,
      base?.apiKey,
      resolveApiKey,
    ),
    ...(base?.oauth !== undefined ? { oauth: base.oauth } : {}),
  };
}

function configuredApiKeyAuth(
  providerId: string,
  config: ProviderConfig,
  fallback: ApiKeyAuth | undefined,
  resolveApiKey: ApiKeyResolver | undefined,
): ApiKeyAuth {
  return {
    name: fallback?.name ?? `${providerId} API key`,
    ...(fallback?.login !== undefined ? { login: fallback.login } : {}),
    async resolve({ ctx, credential, signal }): Promise<AuthResult | undefined> {
      const scopedContext = overlayAuthContext(ctx, config.env);
      if (credential !== undefined && fallback !== undefined) {
        const stored = await fallback.resolve({
          ctx: scopedContext,
          credential,
          signal,
        });
        if (stored !== undefined) return mergeAuthEnv(stored, config.env);
      }

      const external = config.oauth === undefined
        ? undefined
        : await resolveApiKey?.(providerId, config);
      if (external !== undefined && external.length > 0) {
        return {
          auth: { apiKey: external },
          env: config.env,
          source: "Resolver",
        };
      }
      if (config.apiKey !== undefined && config.apiKey.length > 0) {
        return {
          auth: { apiKey: config.apiKey },
          env: config.env,
          source: "Config",
        };
      }
      const providerEnvName =
        `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
      const providerKey = await scopedContext.env(providerEnvName);
      if (providerKey !== undefined && providerKey.trim().length > 0) {
        return {
          auth: { apiKey: providerKey },
          env: config.env,
          source: providerEnvName,
        };
      }
      if (fallback !== undefined) {
        const ambient = await fallback.resolve({
          ctx: scopedContext,
          credential: undefined,
          signal,
        });
        if (ambient !== undefined) return mergeAuthEnv(ambient, config.env);
      }
      // Explicit custom endpoints may be keyless (e.g. local OpenAI-compatible servers).
      if (config.baseUrl !== undefined && config.baseUrl.length > 0) {
        return { auth: {}, env: config.env, source: "Keyless endpoint" };
      }
      return undefined;
    },
  };
}

function mergeAuthEnv(
  result: AuthResult,
  env: Readonly<Record<string, string>> | undefined,
): AuthResult {
  if (env === undefined) return result;
  return { ...result, env: { ...(result.env ?? {}), ...env } };
}

function overlayAuthContext(
  base: AuthContext,
  env: Readonly<Record<string, string>> | undefined,
): AuthContext {
  if (env === undefined) return base;
  return {
    env: async (name) => env[name] ?? (await base.env(name)),
    fileExists: (path) => base.fileExists(path),
  };
}

function overlayOptionalAuthContext(
  base: AuthContext,
  env: Readonly<Record<string, string | undefined>> | undefined,
): AuthContext {
  if (env === undefined) return base;
  return {
    env: async (name) => env[name] ?? (await base.env(name)),
    fileExists: (path) => base.fileExists(path),
  };
}

const API_IMPLEMENTATIONS: Partial<Record<Api, ProviderStreams>> = {
  "anthropic-messages": anthropicMessagesApi(),
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "google-generative-ai": googleGenerativeAIApi(),
  "google-vertex": googleVertexApi(),
};

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: Readonly<Record<string, string>> | undefined,
): ProviderHeaders | undefined {
  if (base === undefined && override === undefined) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function builtinProviderIdForType(type: ProviderType): string {
  switch (type) {
    case "anthropic":
      return "anthropic";
    case "openai":
    case "openai_responses":
      return "openai";
    case "kimi":
      return "moonshotai";
    case "google-genai":
      return "google";
    case "vertexai":
      return "google-vertex";
  }
}

function apiForProviderType(type: ProviderType): KnownApi {
  switch (type) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
    case "kimi":
      return "openai-completions";
    case "openai_responses":
      return "openai-responses";
    case "google-genai":
      return "google-generative-ai";
    case "vertexai":
      return "google-vertex";
  }
}

function defaultAnthropicToolReferences(modelId: string): boolean {
  if (modelId.includes("haiku")) return false;
  const version = modelId.match(
    /^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/,
  );
  if (version === null) return false;
  const major = Number(version[1]);
  const minor =
    version[2] !== undefined && version[2].length < 8
      ? Number(version[2])
      : 0;
  return major > 4 || (major === 4 && minor >= 5);
}

export { UNKNOWN_CAPABILITY };
