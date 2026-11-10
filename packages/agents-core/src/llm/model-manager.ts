import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createModels,
  createProvider,
  type Api,
  type AuthContext,
  type CredentialStore,
  type Model,
  type ModelsStore,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DecisionModel } from "./decision-model.ts";
import { defineModel, type ChatModel, type ModelConnection, type ModelSpec } from "./define-model.ts";

/** Settings for one resolved model, on top of what its provider registration says. */
export type ModelResolveOptions = Pick<ModelSpec, "apiKey" | "connection">;

/** The wire dialects a custom endpoint can speak. Almost everything speaks the first. */
export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

/** pi's API implementations load on first use, so an unused dialect is never imported. */
export function dialectStreams(api: ProviderApi) {
  switch (api) {
    case "anthropic-messages":
      return anthropicMessagesApi();
    case "openai-responses":
      return openAIResponsesApi();
    case "openai-completions":
      return openAICompletionsApi();
  }
}

/**
 * A provider a host adds to its {@link ModelManager}. With `api` it is a custom endpoint; without
 * it, it reuses a catalog provider (`extends`, or the one named `id`) under the host's key and
 * address. The limit fields describe models the provider does not list.
 *
 * This is configuration, for what a host learns from its user: an address, a key, any model id. To
 * state each model's facts yourself, build a pi provider with `createProvider` and add it through
 * `manager.models.setProvider`; string ids resolve against it the same way.
 */
export interface ModelProviderRegistration
  extends Readonly<Partial<Pick<Model<Api>, "contextWindow" | "maxTokens" | "input" | "reasoning">>> {
  /** The name before the `/` in a model id. Registering it again replaces the previous entry. */
  readonly id: string;
  readonly name?: string;
  /** The catalog provider whose models and dialects this one uses. Defaults to `id`. */
  readonly extends?: string;
  /** Marks a custom endpoint and names its dialect. Requires `baseUrl`. */
  readonly api?: ProviderApi;
  /** Used exactly as given. Without it, the catalog says where each model lives. */
  readonly baseUrl?: string;
  /** Wins over a credential in the manager's store, which is used when this is unset. A key passed to `resolve` beats both. */
  readonly apiKey?: string;
  /** How every chat model of this provider reaches it. A field passed to `resolve` replaces the same field here. */
  readonly connection?: ModelConnection;
  /** The models a custom endpoint serves. */
  readonly models?: readonly string[];
  /** Accept model ids the provider does not list. Off by default, so a misspelled id is an error. */
  readonly allowUnlisted?: boolean;
}

/** A `provider/model` id's two halves. A model id may itself contain slashes. */
function splitModelId(id: string): { readonly providerId: string; readonly modelId: string } | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

function sameAddress(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Zero cost: an unlisted or self-hosted model has no known price, and a wrong number is worse. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** What a keyless endpoint sends as its bearer token; the OpenAI dialect refuses to send none. */
export const NO_KEY_PLACEHOLDER = "unused";

/** The facts about a model no catalog describes. Anything left out takes a conservative default. */
export interface EndpointModelFields
  extends Pick<Model<Api>, "id" | "provider" | "api" | "baseUrl">,
    Partial<Pick<Model<Api>, "name" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "headers">> {}

/** A complete pi model descriptor from what is known about a model on a custom endpoint. */
export function endpointModel(fields: Readonly<EndpointModelFields>): Model<Api> {
  const { id, name, provider, api, baseUrl, reasoning, input, contextWindow, maxTokens, headers } = fields;
  return {
    id,
    name: name ?? id,
    api,
    provider,
    baseUrl,
    reasoning: reasoning ?? false,
    input: [...(input ?? ["text"])],
    cost: NO_COST,
    contextWindow: contextWindow ?? 128_000,
    maxTokens: maxTokens ?? 8_192,
    ...(headers !== undefined ? { headers } : {}),
  };
}

function limitsOf({ reasoning, input, contextWindow, maxTokens }: ModelProviderRegistration) {
  return { reasoning, input, contextWindow, maxTokens };
}

function customModel(registration: ModelProviderRegistration, api: ProviderApi, modelId: string): Model<Api> {
  return endpointModel({
    ...limitsOf(registration),
    id: modelId,
    provider: registration.id,
    api: api as Api,
    baseUrl: registration.baseUrl ?? "",
  });
}

function withRegisteredConnection(
  registration: ModelProviderRegistration | undefined,
  options: ModelResolveOptions,
): ModelResolveOptions {
  if (registration?.connection === undefined) return options;
  return { ...options, connection: { ...registration.connection, ...options.connection } };
}

/** An id newer than a catalog provider's list runs on the API of that provider's default endpoint. */
function unlistedCatalogModel(provider: Provider, registration: ModelProviderRegistration, modelId: string): Model<Api> {
  const models = provider.getModels();
  const template = models.find((model) => model.baseUrl === provider.baseUrl) ?? models[0];
  if (template === undefined) throw new Error(`Provider "${provider.id}" lists no models to run "${modelId}" like.`);
  return endpointModel({
    ...limitsOf(registration),
    id: modelId,
    provider: provider.id,
    api: template.api,
    baseUrl: template.baseUrl,
  });
}

/**
 * The models one harness can run: provider catalog, credentials, request dispatch, and what a
 * `provider/model` id resolves to. Customize it in place with {@link register}.
 *
 * pi keeps one credential per provider, so a registered key is per provider too. A host that needs
 * a different key per user passes it to {@link resolve} and hands the session that `ChatModel`.
 */
export class ModelManager {
  readonly models: MutableModels;
  readonly credentials: CredentialStore;
  private readonly registrations = new Map<string, ModelProviderRegistration>();

  constructor(options: CreateModelManagerOptions = {}) {
    this.credentials = options.credentials ?? new InMemoryCredentialStore();
    const modelOptions = {
      credentials: this.credentials,
      modelsStore: options.modelsStore ?? new InMemoryModelsStore(),
      ...(options.authContext !== undefined ? { authContext: options.authContext } : {}),
    };
    this.models = options.builtins === false
      ? createModels(modelOptions)
      : builtinModels(modelOptions);
  }

  /** Add or replace a provider. Sessions running on string ids pick it up on their next turn. */
  register(registration: ModelProviderRegistration): void {
    if (registration.api !== undefined) {
      this.registerEndpoint(registration, registration.api);
    } else if (this.models.getProvider(registration.extends ?? registration.id) === undefined) {
      throw new Error(
        `Provider "${registration.extends ?? registration.id}" is not in the catalog. Set \`api\` and \`baseUrl\` for a custom endpoint.`,
      );
    }
    this.registrations.set(registration.id, registration);
  }

  /** Remove a registration. A catalog provider it overrode goes back to its defaults. */
  unregister(id: string): void {
    const registration = this.registrations.get(id);
    if (registration === undefined) return;
    if (registration.api !== undefined) this.models.deleteProvider(id);
    this.registrations.delete(id);
  }

  /**
   * The `ChatModel` a `provider/model` id names. Throws when the id names nothing. `options` apply
   * to this one model, which is how a host gives each of its users their own key.
   */
  resolve(id: string, options: ModelResolveOptions = {}): ChatModel {
    const parts = splitModelId(id);
    if (parts === undefined) throw new Error(`Model id "${id}" must be "provider/model".`);
    const { providerId, modelId } = parts;
    const registration = this.registrations.get(providerId);

    if (registration?.api !== undefined) {
      const listed = this.models.getModel(providerId, modelId);
      if (listed === undefined && registration.allowUnlisted !== true) throw new Error(`unknown model: ${id}`);
      return defineModel({ ...withRegisteredConnection(registration, options), manager: this, descriptor: listed ?? customModel(registration, registration.api, modelId) });
    }

    // Stays under the catalog provider's own id: pi's dialects adjust requests by provider.
    const catalogId = registration?.extends ?? providerId;
    const provider = this.models.getProvider(catalogId);
    if (provider === undefined) throw new Error(`unknown model: ${id}`);
    const listed = this.models.getModel(catalogId, modelId);
    if (listed === undefined && registration?.allowUnlisted !== true) throw new Error(`unknown model: ${id}`);
    const descriptor = listed ?? unlistedCatalogModel(provider, registration!, modelId);
    return defineModel({
      ...(registration?.apiKey !== undefined ? { apiKey: registration.apiKey } : {}),
      ...withRegisteredConnection(registration, options),
      manager: this,
      descriptor: registration?.baseUrl === undefined ? descriptor : { ...descriptor, baseUrl: registration.baseUrl },
    });
  }

  /**
   * The decision model a `provider/model` id names, or undefined when it names anything else. An
   * id catalogued as both a decision model and an LLM counts as an LLM. Decision models exist only
   * at the catalog's endpoints, so a provider registered at another address has none: its key must
   * not be sent there.
   */
  resolveDecision(id: string, options: Pick<ModelResolveOptions, "apiKey"> = {}): DecisionModel | undefined {
    const parts = splitModelId(id);
    if (parts === undefined) return undefined;
    const registration = this.registrations.get(parts.providerId);
    if (registration?.api !== undefined) return undefined;
    const catalogId = registration?.extends ?? parts.providerId;
    if (this.models.getModel(catalogId, parts.modelId) !== undefined) return undefined;
    const descriptor = this.models.getModelOfType("classifier", catalogId, parts.modelId);
    if (descriptor === undefined) return undefined;
    if (registration?.baseUrl !== undefined && !sameAddress(registration.baseUrl, descriptor.baseUrl)) return undefined;
    const apiKey = options.apiKey ?? registration?.apiKey;
    return new DecisionModel({ manager: this, descriptor, ...(apiKey !== undefined ? { apiKey } : {}) });
  }

  private registerEndpoint(registration: ModelProviderRegistration, api: ProviderApi): void {
    const { id, baseUrl, apiKey } = registration;
    if (baseUrl === undefined) throw new Error(`Custom provider "${id}" needs a \`baseUrl\`.`);
    const name = registration.name ?? id;
    this.models.setProvider(createProvider({
      id,
      name,
      baseUrl,
      auth: {
        apiKey: {
          name: `${name} API key`,
          resolve: async ({ credential, signal }) => {
            signal.throwIfAborted();
            if (apiKey !== undefined) return { auth: { apiKey }, source: "registered" };
            if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
            return { auth: { apiKey: NO_KEY_PLACEHOLDER }, source: baseUrl };
          },
        },
      },
      models: (registration.models ?? []).map((modelId) => customModel(registration, api, modelId)),
      api: dialectStreams(api),
    }));
  }
}

export interface CreateModelManagerOptions {
  readonly credentials?: CredentialStore;
  readonly modelsStore?: ModelsStore;
  readonly authContext?: AuthContext;
  /** Register pi's full built-in provider catalog. Defaults to true. */
  readonly builtins?: boolean;
}

/** Create one provider/auth/catalog manager to be shared by related ChatModels. */
export function createModelManager(
  options: CreateModelManagerOptions = {},
): ModelManager {
  return new ModelManager(options);
}

/**
 * Force one OAuth refresh after a clean 401 for a non-expired but revoked
 * token. pi automatically refreshes expired credentials; this preserves
 * Operon's additional revoked-token recovery policy.
 *
 * `signal` should be the in-flight request's: this runs inside the credential store's
 * per-provider lock, so a refresh that hangs blocks every other request for that provider
 * until it settles. Omitting it leaves the refresh unbounded.
 */
export async function forceRefreshOAuth(
  runtime: ModelManager,
  providerId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const oauth = runtime.models.getProvider(providerId)?.auth.oauth;
  if (oauth === undefined) return false;

  let refreshed = false;
  await runtime.credentials.modify(providerId, async (current) => {
    if (current?.type !== "oauth") return undefined;
    refreshed = true;
    return oauth.refresh(current, signal ?? new AbortController().signal);
  });
  return refreshed;
}
