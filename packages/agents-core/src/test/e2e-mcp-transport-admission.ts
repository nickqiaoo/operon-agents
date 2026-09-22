/**
 * A host says which MCP transports it will run, and core refuses the rest by name.
 *
 * The rule exists for one case: `stdio` on a server host. An stdio server is spawned as a child
 * of the process holding the MCP client, so it stays on the harness's environment even when every
 * tool the session runs has been pushed into a sandbox — and `transport` DEFAULTS to `"stdio"`,
 * so a config that merely omits the field asks a server to spawn a process. The checks below
 * pin both halves: the refusal, and the places it must not fire.
 */
import {
  createMcpServers,
  mcpServersCapability,
  McpTransportNotPermittedError,
  type McpTransportKind,
} from "../mcp/index.ts";
import { McpServerConfigSchema } from "../config/index.ts";
import type { McpServerConfig } from "../config/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** Parse rather than hand-write, so the schema's own `transport` default is what is under test. */
function config(raw: Record<string, unknown>): McpServerConfig {
  return McpServerConfigSchema.parse(raw);
}

const STDIO = config({ transport: "stdio", command: "npx", args: ["-y", "some-server"] });
const HTTP = config({ transport: "http", url: "https://mcp.example.com/sse" });
const HTTP_ONLY: readonly McpTransportKind[] = ["http"];

/** Run `fn`, returning the error it threw (or undefined). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function main(): void {
  // ── The refusal ───────────────────────────────────────────────────────────
  const refused = thrownBy(() => createMcpServers({ local: STDIO }, { allowedTransports: HTTP_ONLY }));
  check("stdio is refused when the host allows http only", refused instanceof McpTransportNotPermittedError);
  if (refused instanceof McpTransportNotPermittedError) {
    check("the error names the offending server", refused.serverName === "local");
    check("the error carries the transport asked for", refused.transport === "stdio");
    check("the error carries what the host does allow", refused.allowed.join(",") === "http");
    check("the message names the server", refused.message.includes('"local"'));
    // The deployer's next move has to be in the message: this is a startup failure they see
    // once, with no stack of context around it.
    check("the message explains that stdio is a child process", refused.message.includes("child of this process"));
    check("the message warns that stdio is also the default", refused.message.includes("defaults to"));
  }

  // The case that actually bites: nobody wrote `transport`, the schema defaulted it to stdio,
  // and without this rule the server would have spawned a process for it.
  const implicit = config({ command: "npx" });
  check("a config with no `transport` field defaults to stdio", implicit.transport === "stdio");
  const refusedImplicit = thrownBy(() => createMcpServers({ implicit }, { allowedTransports: HTTP_ONLY }));
  check(
    "an omitted `transport` is refused too, not silently spawned",
    refusedImplicit instanceof McpTransportNotPermittedError,
  );

  // A mixed set fails on the offender even though a permitted server sits beside it: the check
  // is admission, not a filter — nothing is silently dropped.
  const mixed = thrownBy(() => createMcpServers({ remote: HTTP, local: STDIO }, { allowedTransports: HTTP_ONLY }));
  check(
    "one bad server rejects the whole set rather than being filtered out",
    mixed instanceof McpTransportNotPermittedError && mixed.serverName === "local",
  );

  // ── Where it must NOT fire ────────────────────────────────────────────────
  check(
    "http passes on an http-only host",
    thrownBy(() => createMcpServers({ remote: HTTP }, { allowedTransports: HTTP_ONLY })) === undefined,
  );
  // Every existing caller passes no `allowedTransports` at all; nothing may change for them.
  check(
    "omitting allowedTransports keeps stdio working (the local default)",
    thrownBy(() => createMcpServers({ local: STDIO })) === undefined,
  );
  check(
    "an explicitly permissive host keeps stdio working",
    thrownBy(() => createMcpServers({ local: STDIO }, { allowedTransports: ["http", "stdio"] })) === undefined,
  );
  // `enabled: false` is how one config file serves both a laptop and a server. A disabled
  // server spawns nothing, so refusing it would cost that without buying anything.
  const disabled = config({ transport: "stdio", command: "npx", enabled: false });
  check(
    "a disabled stdio server is not this rule's business",
    thrownBy(() => createMcpServers({ local: disabled }, { allowedTransports: HTTP_ONLY })) === undefined,
  );

  // ── The capability entry point, not just the bare handle ─────────────────
  // One function now covers both topologies, so a session's own servers are admitted by the
  // same rule whether they stand alone or overlay a workspace's.
  check(
    "mcpServersCapability refuses a session's own stdio servers at build time",
    thrownBy(() => mcpServersCapability({ local: STDIO }, { allowedTransports: HTTP_ONLY })) instanceof
      McpTransportNotPermittedError,
  );
  // A session that brings no servers of its own only views the workspace's; there is nothing
  // to admit, and building it must stay free of the rule.
  check(
    "mcpServersCapability with no overlay is unaffected",
    thrownBy(() => mcpServersCapability({}, { allowedTransports: HTTP_ONLY })) === undefined,
  );

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP TRANSPORT ADMISSION E2E PASS — host-declared transports, refused at build time");
  } else {
    console.log("❌ MCP TRANSPORT ADMISSION E2E FAIL");
    process.exit(1);
  }
}

main();
