import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createModels,
  type AuthContext,
  type CredentialStore,
  type ModelsStore,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export interface ModelRuntime {
  readonly models: MutableModels;
  readonly credentials: CredentialStore;
}

export interface CreateModelRuntimeOptions {
  readonly credentials?: CredentialStore;
  readonly modelsStore?: ModelsStore;
  readonly authContext?: AuthContext;
  /** Register pi's full built-in provider catalog. Defaults to true. */
  readonly builtins?: boolean;
}

/** Create one provider/auth/catalog runtime to be shared by related ChatModels. */
export function createModelRuntime(
  options: CreateModelRuntimeOptions = {},
): ModelRuntime {
  const credentials = options.credentials ?? new InMemoryCredentialStore();
  const modelOptions = {
    credentials,
    modelsStore: options.modelsStore ?? new InMemoryModelsStore(),
    ...(options.authContext !== undefined ? { authContext: options.authContext } : {}),
  };
  const models = options.builtins === false
    ? createModels(modelOptions)
    : builtinModels(modelOptions);
  return { models, credentials };
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
  runtime: ModelRuntime,
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
