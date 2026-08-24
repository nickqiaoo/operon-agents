import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

type Env = Readonly<Record<string, string | undefined>>;

// Loopback hosts always bypass the proxy: routing `http://localhost:PORT` (e.g. a local MCP
// server) through a corporate proxy is a confusing failure only proxy users would hit.
// `[::1]` is bracketed because undici's matcher only bypasses IPv6 loopback when bracketed.
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

function firstNonBlank(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** True when an HTTP(S)/ALL proxy is configured in the environment. */
export function hasProxyConfig(env: Env = process.env): boolean {
  return (
    firstNonBlank(env, ["http_proxy", "HTTP_PROXY"]) !== undefined ||
    firstNonBlank(env, ["https_proxy", "HTTPS_PROXY"]) !== undefined ||
    firstNonBlank(env, ["all_proxy", "ALL_PROXY"]) !== undefined
  );
}

export interface ProxyDispatcherOptions {
  readonly env?: Env;
  /** Append loopback hosts to NO_PROXY so local traffic bypasses the proxy. Default true. */
  readonly bypassLoopback?: boolean;
}

/**
 * Route the process's outbound `fetch` (LLM calls, web tools, MCP http) through the proxy
 * named by `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. No-op (returns false) when no proxy is
 * configured, so it is safe to call unconditionally at startup.
 */
export function installGlobalProxyDispatcher(options: ProxyDispatcherOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (!hasProxyConfig(env)) return false;

  const existingNoProxy = firstNonBlank(env, ["no_proxy", "NO_PROXY"]);
  const noProxy =
    options.bypassLoopback === false
      ? existingNoProxy
      : [...(existingNoProxy ? existingNoProxy.split(",").map((s) => s.trim()).filter(Boolean) : []), ...LOOPBACK_NO_PROXY].join(",");

  const httpProxy = firstNonBlank(env, ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]);
  const httpsProxy = firstNonBlank(env, ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]);

  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...(httpProxy !== undefined ? { httpProxy } : {}),
      ...(httpsProxy !== undefined ? { httpsProxy } : {}),
      ...(noProxy !== undefined ? { noProxy } : {}),
    }),
  );
  return true;
}
