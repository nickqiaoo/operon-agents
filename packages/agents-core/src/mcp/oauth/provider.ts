import { randomBytes } from "node:crypto";

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { McpOAuthClientConfig } from "../../config/schema.ts";
import { type McpCredentialStore, canonicalMcpOAuthResource, mcpOAuthStoreKey } from "./store.ts";

const TOKENS_SUFFIX = "-tokens.json";
const CLIENT_SUFFIX = "-client.json";
const DISCOVERY_SUFFIX = "-discovery.json";
// Used only when the SDK probes auth during normal transport startup and no callback
// listener is active. Interactive login overrides it with a real URL.
const PASSIVE_REDIRECT_URI = "http://127.0.0.1:3118/callback";

export interface McpOAuthProviderOptions {
  readonly serverName: string;
  readonly serverUrl: string | URL;
  readonly store: McpCredentialStore;
  readonly clientLabel?: string;
  /** A pre-registered client (skips dynamic client registration). */
  readonly client?: McpOAuthClientConfig;
  /** Scopes to request; also the DCR metadata scope. */
  readonly scopes?: readonly string[];
}

/** Server-config-derived OAuth settings a provider can be (re)configured with. */
export interface McpOAuthClientSettings {
  readonly client?: McpOAuthClientConfig;
  readonly scopes?: readonly string[];
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  readonly storeKey: string;
  readonly serverUrl: string;
  private readonly store: McpCredentialStore;
  private readonly clientLabel: string;
  private _redirectUrl: URL | undefined;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _lastAuthorizationUrl: URL | undefined;
  private _client: McpOAuthClientConfig | undefined;
  private _scopes: readonly string[] | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.store = options.store;
    this.clientLabel = options.clientLabel ?? `Operon (${options.serverName})`;
    this.configure(options);
  }

  /** Apply the server's configured client/scopes. Called on every lookup, so config edits land. */
  configure(settings: McpOAuthClientSettings): void {
    this._client = settings.client;
    this._scopes = settings.scopes !== undefined && settings.scopes.length > 0 ? settings.scopes : undefined;
  }

  /** The pre-registered client, when the server config names one. */
  get staticClient(): McpOAuthClientConfig | undefined {
    return this._client;
  }

  /** Configured scopes as an OAuth `scope` string, when any. */
  get scope(): string | undefined {
    return this._scopes?.join(" ");
  }

  setRedirectUrl(url: URL): void {
    this._redirectUrl = url;
  }

  takeAuthorizationUrl(): URL | undefined {
    const url = this._lastAuthorizationUrl;
    this._lastAuthorizationUrl = undefined;
    return url;
  }

  expectedState(): string | undefined {
    return this._state;
  }

  resetFlow(): void {
    this._redirectUrl = undefined;
    this._codeVerifier = undefined;
    this._state = undefined;
    this._lastAuthorizationUrl = undefined;
  }

  get redirectUrl(): string | URL {
    return this.effectiveRedirectUri();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.effectiveRedirectUri()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.clientLabel,
      ...(this.scope !== undefined ? { scope: this.scope } : {}),
    };
  }

  state(): string {
    this._state ??= randomBytes(16).toString("hex");
    return this._state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this._client !== undefined) {
      return {
        client_id: this._client.clientId,
        ...(this._client.clientSecret !== undefined ? { client_secret: this._client.clientSecret } : {}),
      };
    }
    return this.store.read<OAuthClientInformationFull>(`${this.storeKey}${CLIENT_SUFFIX}`);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    // A pre-registered client is never persisted — the server config stays the source of truth.
    if (this._client !== undefined) return;
    this.store.write(`${this.storeKey}${CLIENT_SUFFIX}`, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read<OAuthTokens>(`${this.storeKey}${TOKENS_SUFFIX}`);
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.write(`${this.storeKey}${TOKENS_SUFFIX}`, tokens);
  }

  redirectToAuthorization(url: URL): void {
    // Capture the URL for the orchestrator instead of opening a browser. The synthetic
    // authenticate tool surfaces it to the model so the user completes the flow themselves.
    this._lastAuthorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new Error("McpOAuthClientProvider: PKCE code verifier not initialized");
    }
    return this._codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.write(`${this.storeKey}${DISCOVERY_SUFFIX}`, state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.read<OAuthDiscoveryState>(`${this.storeKey}${DISCOVERY_SUFFIX}`);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier") {
      this._codeVerifier = undefined;
      return;
    }
    if (scope === "tokens" || scope === "all") {
      this.store.remove(`${this.storeKey}${TOKENS_SUFFIX}`);
    }
    if (scope === "client" || scope === "all") {
      this.store.remove(`${this.storeKey}${CLIENT_SUFFIX}`);
    }
    if (scope === "discovery" || scope === "all") {
      this.store.remove(`${this.storeKey}${DISCOVERY_SUFFIX}`);
    }
    if (scope === "all") {
      this._codeVerifier = undefined;
    }
  }

  private effectiveRedirectUri(): string {
    if (this._redirectUrl !== undefined) {
      return this._redirectUrl.toString();
    }
    if (this._client?.callbackUrl !== undefined) return this._client.callbackUrl;
    if (this._client?.callbackPort !== undefined) return `http://127.0.0.1:${this._client.callbackPort}/callback`;
    const registered = registeredRedirectUri(this.clientInformation());
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !("redirect_uris" in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}
