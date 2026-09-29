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
      provider.clientMetadata.client_name?.includes("Operon") === true,
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

  const okCb = await startCallbackServer();
  const okWait = okCb.waitForCode({ timeoutMs: 5_000 });
  const okRes = await fetch(`${okCb.redirectUri}?code=abc&state=s1`);
  const okBody = await okRes.text();
  const okResult = await okWait;
  check(
    "callback: success page is Operon-branded and yields the code",
    okRes.status === 200 && okBody.includes("return to Operon") && !okBody.includes("agent-framework") &&
      okResult.code === "abc" && okResult.state === "s1",
  );

  const errCb = await startCallbackServer();
  const errWait = errCb.waitForCode({ timeoutMs: 5_000 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const errRes = await fetch(`${errCb.redirectUri}?error=access_denied&error_description=${encodeURIComponent("<b>denied</b>")}`);
  const errBody = await errRes.text();
  const errResult = await errWait;
  check(
    "callback: failure page shows the escaped reason and rejects",
    errRes.status === 400 && errBody.includes("access_denied: &lt;b&gt;denied&lt;/b&gt;") && !errBody.includes("<b>denied") &&
      errResult instanceof Error && errResult.message.includes("access_denied"),
  );

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
