import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
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
import { McpServerConfigSchema } from "../config/index.ts";
import { mcpOAuthSettings } from "../mcp/index.ts";

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

  // ── Pre-registered clients (Codex `.mcp.json` `oauth` block) ──────────────
  const codexCfg = McpServerConfigSchema.parse({
    type: "http",
    url: "https://api.githubcopilot.com/mcp/",
    oauth: { client_id: "cid", client_secret: "sec", callback_port: 12799, callback_url: "http://127.0.0.1:12799/callback/x" },
    scopes: ["repo", "read:org"],
    bearer_token_env_var: "GH_PAT",
  });
  check(
    "schema: Codex snake_case oauth/scopes/bearer keys survive parsing",
    codexCfg.oauth?.clientId === "cid" && codexCfg.oauth.clientSecret === "sec" && codexCfg.oauth.callbackPort === 12799 &&
      codexCfg.oauth.callbackUrl === "http://127.0.0.1:12799/callback/x" && codexCfg.scopes?.join(" ") === "repo read:org" &&
      codexCfg.bearerTokenEnvVar === "GH_PAT" && codexCfg.transport === "http",
  );
  check(
    "schema: camelCase wins over its snake_case twin",
    McpServerConfigSchema.parse({ url: "https://x", bearerTokenEnvVar: "A", bearer_token_env_var: "B" }).bearerTokenEnvVar === "A",
  );
  check("schema: a server without oauth parses unchanged", McpServerConfigSchema.parse({ command: "x" }).oauth === undefined);

  const staticProvider = new McpOAuthClientProvider({
    serverName: "gh",
    serverUrl: "https://mcp.example.com/mcp",
    store,
    ...mcpOAuthSettings(codexCfg),
  });
  const staticInfo = staticProvider.clientInformation();
  check(
    "provider: static client is returned as client information (no DCR) and never persisted",
    staticInfo?.client_id === "cid" && staticInfo.client_secret === "sec" &&
      (staticProvider.saveClientInformation({ client_id: "dcr" }), staticProvider.clientInformation()?.client_id === "cid") &&
      store.read(`${staticProvider.storeKey}-client.json`) === undefined,
  );
  check("provider: static callback URL is the redirect URI", staticProvider.redirectUrl === "http://127.0.0.1:12799/callback/x");
  check("provider: configured scopes land in client metadata", staticProvider.clientMetadata.scope === "repo read:org");
  staticProvider.configure({});
  check("provider: configure({}) drops the static client", staticProvider.clientInformation() === undefined);

  const freePort = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  const fixedCb = await startCallbackServer({ redirectUri: `http://127.0.0.1:${freePort}/callback/abc` });
  const fixedWait = fixedCb.waitForCode({ timeoutMs: 5_000 });
  const wrongPath = await fetch(`http://127.0.0.1:${freePort}/callback?code=nope`);
  await fetch(`http://127.0.0.1:${freePort}/callback/abc?code=fixed`);
  check(
    "callback: listens on the registered port + path only",
    fixedCb.redirectUri === `http://127.0.0.1:${freePort}/callback/abc` && wrongPath.status === 404 && (await fixedWait).code === "fixed",
  );
  await fixedCb.close();
  let badUrlRejected = false;
  try {
    await startCallbackServer({ redirectUri: "https://example.com/callback" });
  } catch {
    badUrlRejected = true;
  }
  check("callback: a non-loopback redirect URI is refused", badUrlRejected);

  // Full flow against a fake authorization server: static client → no registration, the authorize
  // URL carries the fixed redirect + configured scope, and the token exchange sends the secret.
  const seen = { register: 0, tokenBody: "" };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => resolve(body));
    });
  const as = createServer((req, res) => {
    void (async () => {
      const base = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
      const json = (v: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
      const path = new URL(req.url ?? "/", base).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["prm-scope"] });
      }
      if (path.startsWith("/.well-known/oauth-authorization-server")) {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        });
      }
      if (path === "/register") {
        seen.register += 1;
        await readBody(req);
        return json({ client_id: "dcr-client", redirect_uris: ["http://127.0.0.1/callback"] });
      }
      if (path === "/token") {
        seen.tokenBody = await readBody(req);
        return json({ access_token: "at", token_type: "Bearer", refresh_token: "rt" });
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => as.listen(0, "127.0.0.1", resolve));
  const asBase = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
  const flowSvc = new McpOAuthService({ homeDir: mkdtempSync(join(tmpdir(), "af-oauth-flow-")) });
  const redirect = `http://127.0.0.1:${freePort}/callback/flow`;
  const flow = await flowSvc.beginAuthorization("gh", `${asBase}/mcp`, {
    client: { clientId: "static-id", clientSecret: "static-secret", callbackUrl: redirect },
    scopes: ["repo"],
  });
  const authUrl = flow.authorizationUrl;
  const done = flow.complete({ timeoutMs: 5_000 });
  await fetch(`${redirect}?code=the-code&state=${authUrl.searchParams.get("state") ?? ""}`);
  await done;
  const tokenParams = new URLSearchParams(seen.tokenBody);
  check(
    "flow: static client skips registration and uses the fixed redirect + configured scope",
    seen.register === 0 && authUrl.searchParams.get("client_id") === "static-id" &&
      authUrl.searchParams.get("redirect_uri") === redirect && authUrl.searchParams.get("scope") === "repo",
  );
  check(
    "flow: token exchange authenticates with the static secret and stores tokens",
    tokenParams.get("client_id") === "static-id" && tokenParams.get("client_secret") === "static-secret" &&
      tokenParams.get("redirect_uri") === redirect && flowSvc.hasTokens("gh", `${asBase}/mcp`),
  );
  await new Promise<void>((resolve) => as.close(() => resolve()));

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
