import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

import { startCallbackServer, type CallbackServer } from "./callback-server.ts";
import { McpOAuthClientProvider } from "./provider.ts";
import { JsonFileStore, type McpCredentialStore, mcpCredentialsDir, mcpOAuthStoreKey } from "./store.ts";

export interface McpOAuthServiceOptions {
  /** Where credentials live. Defaults to a `JsonFileStore` (local disk); inject a
   *  `MemoryMcpCredentialStore` (or other backend) for deployments without local disk. */
  readonly store?: McpCredentialStore;
  readonly homeDir?: string;
  readonly clientLabel?: string;
}

export interface BeginAuthorizationOptions {
  readonly clientLabel?: string;
}

export interface BeginAuthorizationResult {
  readonly authorizationUrl: URL;
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  cancel(): Promise<void>;
}

export class McpOAuthService {
  private readonly store: McpCredentialStore;
  private readonly clientLabel: string | undefined;
  private readonly providers = new Map<string, McpOAuthClientProvider>();

  constructor(options: McpOAuthServiceOptions = {}) {
    this.store =
      options.store ??
      new JsonFileStore(options.homeDir === undefined ? undefined : mcpCredentialsDir(options.homeDir));
    this.clientLabel = options.clientLabel;
  }

  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = new McpOAuthClientProvider({
        serverName,
        serverUrl,
        store: this.store,
        ...(this.clientLabel !== undefined ? { clientLabel: this.clientLabel } : {}),
      });
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  hasTokens(serverName: string, serverUrl: string | URL): boolean {
    return this.getProvider(serverName, serverUrl).tokens() !== undefined;
  }

  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    const provider =
      options.clientLabel === undefined
        ? this.getProvider(serverName, serverUrl)
        : new McpOAuthClientProvider({
            serverName,
            serverUrl,
            store: this.store,
            clientLabel: options.clientLabel,
          });
    if (options.clientLabel !== undefined) {
      this.providers.set(provider.storeKey, provider);
    }

    provider.resetFlow();

    let callbackServer: CallbackServer;
    try {
      callbackServer = await startCallbackServer();
    } catch (error) {
      throw wrapAuthError("failed to start OAuth callback listener", error);
    }

    provider.setRedirectUrl(new URL(callbackServer.redirectUri));

    let authorizationUrl: URL | undefined;
    try {
      const result = await auth(provider as OAuthClientProvider, { serverUrl });
      if (result !== "REDIRECT") {
        // Tokens already valid (e.g. unexpired refresh). Nothing to do.
        await callbackServer.close();
        throw new AlreadyAuthorizedError(serverName);
      }
      authorizationUrl = provider.takeAuthorizationUrl();
      if (authorizationUrl === undefined) {
        throw new Error("OAuth provider did not capture an authorization URL");
      }
    } catch (error) {
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
      if (error instanceof AlreadyAuthorizedError) throw error;
      throw wrapAuthError(`failed to start OAuth flow for "${serverName}"`, error);
    }

    let settled = false;
    const cancel = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    const complete: BeginAuthorizationResult["complete"] = async (opts = {}) => {
      if (settled) {
        throw new Error("OAuth flow already completed or cancelled");
      }
      try {
        const { code, state } = await callbackServer.waitForCode({
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
        const expectedState = provider.expectedState();
        if (expectedState !== undefined && state !== expectedState) {
          throw new Error("OAuth state mismatch — possible CSRF; refusing token exchange");
        }
        const finalResult = await auth(provider as OAuthClientProvider, {
          serverUrl,
          authorizationCode: code,
        });
        if (finalResult !== "AUTHORIZED") {
          throw new Error(`OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`);
        }
      } catch (error) {
        await cancel();
        throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
      }
      settled = true;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    return { authorizationUrl, complete, cancel };
  }

  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: "all" | "client" | "tokens" | "discovery" = "all",
  ): void {
    this.getProvider(serverName, serverUrl).invalidateCredentials(scope);
  }
}

export class AlreadyAuthorizedError extends Error {
  constructor(serverName: string) {
    super(`"${serverName}" is already authorized; no browser flow needed`);
    this.name = "AlreadyAuthorizedError";
  }
}

function wrapAuthError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    const wrapped = new Error(`${prefix}: ${error.message}`);
    wrapped.cause = error;
    return wrapped;
  }
  return new Error(`${prefix}: ${String(error)}`);
}
