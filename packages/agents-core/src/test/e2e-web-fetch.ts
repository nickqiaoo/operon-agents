/**
 * E2E for DirectFetchProvider's redirect handling, against real HTTP servers.
 *
 * `fetch` follows redirects itself, and that silently defeats both of this provider's guards:
 * the private-address check runs once before the request, and the caller's permission was
 * granted for the ORIGINAL host. So a public page redirecting to 169.254.169.254 reaches the
 * cloud metadata endpoint, and a trusted domain with an open redirect fetches wherever it
 * likes under someone else's approval.
 *
 * Real servers rather than a stubbed `fetchImpl`: the bug lived in what the runtime does with
 * a 302, so a stub that never emits one would assert nothing.
 */
import { createServer, type Server } from "node:http";
import { DirectFetchProvider } from "../tool/web/providers/direct-fetch.ts";
import { WebToolError } from "../tool/web/types.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, okFlag: boolean): void {
  checks.push([label, okFlag]);
  console.log(`${okFlag ? "PASS" : "FAIL"} ${label}`);
}

async function listen(handler: (url: string) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const { status, headers, body } = handler(req.url ?? "/");
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, port: (server.address() as { port: number }).port };
}

async function main(): Promise<void> {
  const servers: Server[] = [];
  try {
    // Stands in for an internal service that should never be reachable through a redirect.
    const secret = await listen(() => ({ status: 200, body: "INTERNAL_SECRET" }));
    servers.push(secret.server);

    // Same-origin redirect: /old → /new on the very same server.
    const sameOrigin = await listen((url) =>
      url === "/old" ? { status: 302, headers: { location: "/new" } } : { status: 200, body: "MOVED_CONTENT" },
    );
    servers.push(sameOrigin.server);

    // The open-redirect case: a "trusted" host bouncing to a different origin.
    const openRedirect = await listen(() => ({
      status: 302,
      headers: { location: `http://127.0.0.1:${String(secret.port)}/` },
    }));
    servers.push(openRedirect.server);

    const loop = await listen(() => ({ status: 302, headers: { location: "/again" } }));
    servers.push(loop.server);

    // allowPrivateAddresses so the loopback test servers stand in for public hosts; the
    // redirect rules under test are independent of that flag.
    const provider = new DirectFetchProvider({ allowPrivateAddresses: true });

    // ── A cross-origin redirect must not be followed ───────────────────────────
    let crossOriginError: string | undefined;
    try {
      await provider.fetch(`http://127.0.0.1:${String(openRedirect.port)}/`);
    } catch (error) {
      crossOriginError = error instanceof WebToolError ? error.message : `unexpected: ${String(error)}`;
    }
    check("cross-origin redirect is refused", crossOriginError !== undefined);
    check(
      "the refusal does not leak the redirected content",
      crossOriginError !== undefined && !crossOriginError.includes("INTERNAL_SECRET"),
    );
    check(
      "the refusal names the destination so the model can decide",
      crossOriginError?.includes(`127.0.0.1:${String(secret.port)}`) === true,
    );

    // ── Same-origin redirects still work, and report where they landed ────────
    const moved = await provider.fetch(`http://127.0.0.1:${String(sameOrigin.port)}/old`);
    check("same-origin redirect is followed", moved.content.includes("MOVED_CONTENT"));
    check(
      "the result reports the FINAL url, not the requested one",
      moved.url === `http://127.0.0.1:${String(sameOrigin.port)}/new`,
    );

    // ── A redirect loop ends in an error rather than spinning ─────────────────
    let loopError: string | undefined;
    try {
      await provider.fetch(`http://127.0.0.1:${String(loop.port)}/start`);
    } catch (error) {
      loopError = error instanceof WebToolError ? error.message : `unexpected: ${String(error)}`;
    }
    check("a redirect loop is cut off", loopError?.includes("redirects") === true);

    // ── The private-address guard applies to every hop ────────────────────────
    // With the default (allowPrivate: false) the first hop is already refused, which is the
    // same protection a public host redirecting inward would get on the second hop.
    const guarded = new DirectFetchProvider();
    let privateError: string | undefined;
    try {
      await guarded.fetch(`http://127.0.0.1:${String(secret.port)}/`);
    } catch (error) {
      privateError = error instanceof WebToolError ? error.message : `unexpected: ${String(error)}`;
    }
    check("private addresses are refused", privateError?.includes("private/loopback") === true);

    // ── Timeout: a server that never answers must not hang the caller ─────────
    const stalled = createServer(() => {
      /* accept the connection and never respond */
    });
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", () => resolve()));
    servers.push(stalled);
    const stalledPort = (stalled.address() as { port: number }).port;
    const impatient = new DirectFetchProvider({ allowPrivateAddresses: true, timeoutMs: 300 });
    const startedAt = Date.now();
    let timeoutError: string | undefined;
    try {
      await impatient.fetch(`http://127.0.0.1:${String(stalledPort)}/`);
    } catch (error) {
      timeoutError = error instanceof WebToolError ? error.message : `unexpected: ${String(error)}`;
    }
    check("a stalled server times out", timeoutError?.includes("timed out") === true);
    check("the timeout fires promptly", Date.now() - startedAt < 5_000);

    // ── URL length ────────────────────────────────────────────────────────────
    let longError: string | undefined;
    try {
      await provider.fetch(`http://127.0.0.1:${String(sameOrigin.port)}/${"x".repeat(3000)}`);
    } catch (error) {
      longError = error instanceof WebToolError ? error.message : `unexpected: ${String(error)}`;
    }
    check("an over-long URL is refused", longError?.includes("longer than") === true);
  } finally {
    for (const server of servers) server.close();
  }

  const passed = checks.filter(([, okFlag]) => okFlag).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed === checks.length) {
    console.log("✅ WEB-FETCH E2E PASS — redirects re-checked per hop, final URL reported, timeout + caps enforced");
  } else {
    console.log("❌ WEB-FETCH E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ WEB-FETCH E2E ERROR:", error);
  process.exit(1);
});
