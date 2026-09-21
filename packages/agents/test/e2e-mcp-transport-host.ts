/**
 * The host half of MCP transport admission: `defaultCapabilities` passes the host's statement
 * down to every MCP capability it builds.
 *
 * Core owns the refusal (`e2e-mcp-transport-admission.ts` in agents-core pins it). What is
 * verified here is only that a server host CAN state the rule once, at the place it assembles
 * capabilities, and have it reach both the workspace servers and a session's own overlay.
 */
import { defaultCapabilities, McpTransportNotPermittedError } from "../src/index.ts";
import { McpServerConfigSchema } from "operon-agents-core";
import type { McpServerConfig } from "operon-agents-core";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const STDIO: McpServerConfig = McpServerConfigSchema.parse({ command: "npx", args: ["-y", "some-server"] });
const HTTP: McpServerConfig = McpServerConfigSchema.parse({ transport: "http", url: "https://mcp.example.com/sse" });

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function main(): void {
  const workspace = thrownBy(() =>
    defaultCapabilities({ mcpServers: { local: STDIO }, allowedMcpTransports: ["http"] }),
  );
  check(
    "a server host's workspace stdio server is refused while capabilities are assembled",
    workspace instanceof McpTransportNotPermittedError,
  );

  // The overlay is the path a caller reaches through the API (`createSession({ mcpServers })`),
  // so it is the one that would carry a config the deployer never reviewed.
  const overlay = thrownBy(() =>
    defaultCapabilities({ sessionMcpServers: { local: STDIO }, allowedMcpTransports: ["http"] }),
  );
  check(
    "a session's own stdio overlay is refused too",
    overlay instanceof McpTransportNotPermittedError,
  );

  check(
    "http servers assemble normally on an http-only host",
    thrownBy(() => defaultCapabilities({ mcpServers: { remote: HTTP }, allowedMcpTransports: ["http"] })) === undefined,
  );
  // A local host states nothing and keeps every transport — this must not become opt-out.
  check(
    "a host that states nothing still runs stdio",
    thrownBy(() => defaultCapabilities({ mcpServers: { local: STDIO } })) === undefined,
  );
  // And the capability is still actually built, not quietly skipped.
  const local = defaultCapabilities({ mcpServers: { local: STDIO } });
  check("the mcp capability is present on a permissive host", local.some((c) => c.name === "mcp"));

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP TRANSPORT HOST E2E PASS — defaultCapabilities carries the host's transport statement");
  } else {
    console.log("❌ MCP TRANSPORT HOST E2E FAIL");
    process.exit(1);
  }
}

main();
