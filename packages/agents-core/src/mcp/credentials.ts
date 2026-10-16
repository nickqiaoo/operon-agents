/**
 * Where an http MCP server's credentials come from when the host — not a config file — decides.
 *
 * A config can carry its own (`headers`, `bearerTokenEnvVar`) and a local host has the OAuth
 * service, whose sign-in is a browser redirect to 127.0.0.1. Neither fits a server: a config is
 * the same for every tenant, the process environment has no tenant boundary, and there is no
 * browser. A provider is the host asking, per session and per connect, "what do I send to this
 * server?" — which is all a vault is from the engine's side. Storing, refreshing and choosing
 * the credential stay with the host; the engine never persists or logs what it is given, and
 * because the MCP client runs in the host process, a credential never enters the sandbox.
 *
 * Precedence for one http server: the config's own `headers` / `bearerTokenEnvVar`, then the
 * provider, then the OAuth service. A provider that returns nothing passes the server on.
 */
export interface McpCredentialRequest {
  readonly serverName: string;
  readonly url: string;
  /** The session the connection belongs to; empty for a set connected outside any session. */
  readonly sessionId: string;
}

export interface McpCredential {
  /** Sent on every request of this connection, over anything the transport sets itself. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface McpCredentialProvider {
  /** Asked on every connect and reconnect, so a refreshed token is picked up by the next one. */
  credentialsFor(request: McpCredentialRequest): McpCredential | undefined | Promise<McpCredential | undefined>;
  /**
   * The server refused, with a 401, the credential `credentialsFor` just gave. Refresh or rotate
   * it; the connect is retried once with whatever `credentialsFor` returns next. Without this,
   * a 401 fails the connect like any other error.
   */
  invalidate?(request: McpCredentialRequest): void | Promise<void>;
}
