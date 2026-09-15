/**
 * Building a model provider, for hosts that configure endpoints the built-in catalog does not
 * know — a self-hosted server, a gateway, a proxy in front of a vendor.
 *
 * The kernel owns the pi boundary, so these are re-exported here rather than imported from pi
 * directly by an outer ring. A provider is a URL, an auth rule, a set of model descriptors (static,
 * fetched, or both) and the wire dialect it speaks; `MutableModels.setProvider` registers it on a
 * runtime, and everything downstream — `defineModel`, `Models.getAvailable`, the harness's
 * `registerProvider` — treats it exactly like a built-in one.
 */

export { createProvider, createModels } from "@earendil-works/pi-ai";
export { envApiKeyAuth } from "@earendil-works/pi-ai";
export { lazyApi, lazyStream } from "@earendil-works/pi-ai";

export type {
  CreateProviderOptions,
  Models,
  MutableModels,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  RefreshModelsContext,
  ModelsPublication,
  ModelsStore,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";
export type { ProviderStreams, ModelCost } from "@earendil-works/pi-ai";
export type { ApiKeyAuth, ProviderAuth, Credential, AuthCheck, AuthResult } from "@earendil-works/pi-ai";
