import { randomBytes } from "node:crypto";

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

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

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.store = options.store;
    this.clientLabel = options.clientLabel ?? `agent-framework (${options.serverName})`;
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
    };
  }

  state(): string {
    this._state ??= randomBytes(16).toString("hex");
    return this._state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.read<OAuthClientInformationFull>(`${this.storeKey}${CLIENT_SUFFIX}`);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
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
    const registered = registeredRedirectUri(this.clientInformation());
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !("redirect_uris" in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}
