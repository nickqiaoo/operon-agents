import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonFileStore,
  McpOAuthService,
  McpOAuthClientProvider,
  startCallbackServer,
  mcpOAuthStoreKey,
  defaultMcpCredentialsDir,
} from "../mcp/oauth/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "af-oauth-"));
  const store = new JsonFileStore(dir);

  check("store: missing → undefined", store.read("x-tokens.json") === undefined);
  store.write("x-tokens.json", { access_token: "abc" });
  check("store: write→read round-trip", store.read<{ access_token: string }>("x-tokens.json")?.access_token === "abc");
  store.remove("x-tokens.json");
  check("store: remove", store.read("x-tokens.json") === undefined);
  check("store: default dir under ~/.operon", defaultMcpCredentialsDir().includes(".operon"));

  const k1 = mcpOAuthStoreKey("github", "https://mcp.example.com/sse#frag");
  const k2 = mcpOAuthStoreKey("github", "https://mcp.example.com/sse");
  check("store key: stable, hash-suffixed, fragment-stripped", k1 === k2 && /^github-[0-9a-f]{24}$/.test(k1));

  const provider = new McpOAuthClientProvider({ serverName: "github", serverUrl: "https://mcp.example.com/sse", store });
  check("provider: tokens() undefined initially", provider.tokens() === undefined);
  check(
    "provider: clientMetadata is a public DCR client",
    provider.clientMetadata.token_endpoint_auth_method === "none" &&
      provider.clientMetadata.grant_types?.includes("refresh_token") === true &&
      provider.clientMetadata.client_name?.includes("agent-framework") === true,
  );
  provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
  check("provider: saveTokens→tokens round-trip", provider.tokens()?.access_token === "tok");
  provider.invalidateCredentials("all");
  check("provider: invalidate clears tokens", provider.tokens() === undefined);

  const svc = new McpOAuthService({ homeDir: dir });
  check("service: hasTokens false before login", svc.hasTokens("github", "https://mcp.example.com/sse") === false);
  check("service: getProvider is cached per identity", svc.getProvider("a", "https://x") === svc.getProvider("a", "https://x"));

  const cb = await startCallbackServer();
  check("callback: loopback redirect uri on a random port", /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(cb.redirectUri));
  await cb.close();

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP OAUTH E2E PASS — store + provider + service + callback");
  } else {
    console.log("❌ MCP OAUTH E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MCP OAUTH E2E ERROR:", error);
  process.exit(1);
});
