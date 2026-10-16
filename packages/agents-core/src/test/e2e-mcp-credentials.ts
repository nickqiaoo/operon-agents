// `McpCredentialProvider`: the host hands an http MCP server its credential per session and per
// connect — the seam a per-user vault is built on. Run against a real streamable-HTTP server that
// answers 401 to anything but the current token, since what matters is the header on the wire.
//
// Covers: the provider's header reaches the server; a 401 calls `invalidate` and retries once
// with whatever the provider hands out next; without `invalidate` a 401 fails the connect; a
// config that carries its own `headers` is never handed to the provider; the request names the
// session the connection belongs to.
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServers, type McpCredentialProvider, type McpCredentialRequest } from "../index.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** An MCP server that accepts exactly `Authorization: Bearer <accepted.token>`. */
async function startServer(accepted: { token: string }): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http: HttpServer = createServer((req, res) => {
    const authorization = req.headers.authorization ?? "";
    seen.push(authorization);
    if (authorization !== `Bearer ${accepted.token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    // One MCP session per client connection, as a real server keeps them.
    const id = req.headers["mcp-session-id"];
    let transport = typeof id === "string" ? transports.get(id) : undefined;
    void (async () => {
      if (transport === undefined) {
        const server = new Server({ name: "vaulted", version: "0.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }],
        }));
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => { transports.set(sessionId, created); },
        });
        await server.connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: async () => {
      for (const transport of transports.values()) await transport.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function main(): Promise<void> {
  const accepted = { token: "fresh" };
  const server = await startServer(accepted);
  try {
    // ── the provider's header is what the server sees ──
    {
      const requests: McpCredentialRequest[] = [];
      const provider: McpCredentialProvider = {
        credentialsFor: (request) => {
          requests.push(request);
          return { headers: { Authorization: "Bearer fresh" } };
        },
      };
      const servers = createMcpServers({ vaulted: { transport: "http", url: server.url } }, { credentials: provider });
      await servers.connect({ sessionId: "sess-1" });
      check("provider: the server connects with the provider's credential", servers.list()[0]?.status === "connected");
      check("provider: the request names the server, its url and the session", requests[0]?.serverName === "vaulted" && requests[0]?.url === server.url && requests[0]?.sessionId === "sess-1");
      check("provider: tools are reachable through the credentialed connection", (await servers.listTools("vaulted")).some((tool) => tool.name === "whoami"));
      await servers.shutdown();
    }

    // ── a refused credential is invalidated, then retried once with the next one ──
    {
      let current = "stale";
      let invalidations = 0;
      const provider: McpCredentialProvider = {
        credentialsFor: () => ({ headers: { Authorization: `Bearer ${current}` } }),
        invalidate: () => {
          invalidations += 1;
          current = "fresh";
        },
      };
      const servers = createMcpServers({ vaulted: { transport: "http", url: server.url } }, { credentials: provider });
      await servers.connect({ sessionId: "sess-2" });
      check("401: invalidate is called once", invalidations === 1);
      check("401: the retry with the refreshed credential connects", servers.list()[0]?.status === "connected");
      await servers.shutdown();
    }

    // ── a credential refused again after invalidate fails, without a third try ──
    {
      let calls = 0;
      let invalidations = 0;
      const provider: McpCredentialProvider = {
        credentialsFor: () => {
          calls += 1;
          return { headers: { Authorization: "Bearer revoked" } };
        },
        invalidate: () => { invalidations += 1; },
      };
      const servers = createMcpServers({ vaulted: { transport: "http", url: server.url } }, { credentials: provider });
      await servers.connect({ sessionId: "sess-3" });
      check("still refused: the server fails", servers.list()[0]?.status === "failed");
      check("still refused: asked twice, invalidated once — no loop", calls === 2 && invalidations === 1);
      await servers.shutdown();
    }

    // ── without invalidate, a 401 is an ordinary failure ──
    {
      const provider: McpCredentialProvider = { credentialsFor: () => ({ headers: { Authorization: "Bearer stale" } }) };
      const servers = createMcpServers({ vaulted: { transport: "http", url: server.url } }, { credentials: provider });
      await servers.connect({ sessionId: "sess-4" });
      check("no invalidate: a 401 fails the connect", servers.list()[0]?.status === "failed");
      await servers.shutdown();
    }

    // ── a config's own headers win; the provider is not asked ──
    {
      let asked = false;
      const provider: McpCredentialProvider = {
        credentialsFor: () => {
          asked = true;
          return { headers: { Authorization: "Bearer stale" } };
        },
      };
      const servers = createMcpServers(
        { vaulted: { transport: "http", url: server.url, headers: { Authorization: "Bearer fresh" } } },
        { credentials: provider },
      );
      await servers.connect({ sessionId: "sess-5" });
      check("own headers: the config's credential is used", servers.list()[0]?.status === "connected");
      check("own headers: the provider is never asked", !asked);
      await servers.shutdown();
    }

    // ── a provider that returns nothing leaves the server unauthenticated ──
    {
      const provider: McpCredentialProvider = { credentialsFor: () => undefined };
      const before = server.seen.length;
      const servers = createMcpServers({ vaulted: { transport: "http", url: server.url } }, { credentials: provider });
      await servers.connect({ sessionId: "sess-6" });
      // The previous case's session-close DELETE may land after `before`; this connect's own
      // request is the last one, and the server refused it.
      check("nothing given: the request carries no credential", server.seen.length > before && server.seen.at(-1) === "");
      check("nothing given: so the server refuses it", servers.list()[0]?.status === "failed");
      await servers.shutdown();
    }
  } finally {
    await server.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
  console.log("✅ MCP CREDENTIALS E2E PASS — the host's provider authenticates http MCP servers per connect");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
