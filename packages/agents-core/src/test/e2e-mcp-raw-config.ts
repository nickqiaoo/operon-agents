/**
 * Hosts hand their own settings JSON to the MCP layer without running it through the schema.
 * Every entry point must read such an entry the way the schema would, and one bad entry must
 * fail by itself.
 */
import {
  assertMcpTransportsPermitted,
  createMcpServers,
  serverFromConfig,
  McpTransportNotPermittedError,
  type McpTransportKind,
} from "../mcp/index.ts";
import { MockMCPTransport } from "../mcp/mock-transport.ts";
import { McpServerConfigSchema } from "../config/index.ts";
import type { McpServerConfig } from "../config/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function raw(value: Record<string, unknown>): McpServerConfig {
  return value as unknown as McpServerConfig;
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

const COMMAND = { command: "npx", args: ["-y", "some-server"] };
const HTTP_ONLY: readonly McpTransportKind[] = ["http"];

async function main(): Promise<void> {
  check("schema: bare command is stdio", McpServerConfigSchema.parse(COMMAND).transport === "stdio");
  check("schema: bare url is http", McpServerConfigSchema.parse({ url: "https://x.test/mcp" }).transport === "http");
  check("schema: type sse maps to http", McpServerConfigSchema.parse({ type: "sse", url: "https://x.test/sse" }).transport === "http");
  check("schema: url with an explicit stdio type keeps stdio", McpServerConfigSchema.parse({ type: "stdio", url: "https://x.test", command: "a" }).transport === "stdio");

  check("serverFromConfig: { command, args } builds", thrownBy(() => serverFromConfig("a", raw(COMMAND))) === undefined);
  check("serverFromConfig: type stdio builds", thrownBy(() => serverFromConfig("a", raw({ type: "stdio", ...COMMAND }))) === undefined);
  check("serverFromConfig: type sse builds", thrownBy(() => serverFromConfig("a", raw({ type: "sse", url: "https://x.test/sse" }))) === undefined);
  const invalid = thrownBy(() => serverFromConfig("a", raw({ command: 42 })));
  check("serverFromConfig: an invalid entry names the server and field", invalid instanceof Error && invalid.message.includes('"a"') && invalid.message.includes("command"));

  const seen: Record<string, McpServerConfig> = {};
  const handle = createMcpServers(
    {
      local: raw(COMMAND),
      remote: raw({ type: "http", url: "https://x.test/mcp" }),
      broken: raw({ command: "npx", env: { TOKEN: 1 } }),
      off: raw({ command: 42, enabled: false }),
    },
    {
      transportFactory: (name, config) => {
        seen[name] = config;
        return new MockMCPTransport({ name, tools: [], call: () => ({ content: [] }) });
      },
    },
  );
  await handle.connect({ sessionId: "s" });
  const views = new Map(handle.list().map((view) => [view.name, view]));
  check("createMcpServers: raw stdio entry connects", views.get("local")?.status === "connected");
  check("createMcpServers: raw stdio entry reports stdio", views.get("local")?.transport === "stdio");
  check("createMcpServers: the factory gets the normalized config", seen["local"]?.transport === "stdio");
  check("createMcpServers: raw http entry connects", views.get("remote")?.status === "connected");
  check("createMcpServers: an invalid entry fails alone", views.get("broken")?.status === "failed");
  check("createMcpServers: the failure names the bad field", views.get("broken")?.error?.includes("env.TOKEN") === true);
  check("createMcpServers: an invalid entry never reaches the factory", seen["broken"] === undefined);
  check("createMcpServers: a disabled invalid entry stays disabled", views.get("off")?.status === "disabled");
  await handle.shutdown();

  const refused = thrownBy(() => assertMcpTransportsPermitted({ local: raw(COMMAND) }, HTTP_ONLY));
  check("admission: a raw stdio entry is refused as stdio", refused instanceof McpTransportNotPermittedError && refused.transport === "stdio");
  check("admission: a raw stdio entry is admitted when stdio is allowed", thrownBy(() => assertMcpTransportsPermitted({ local: raw(COMMAND) }, ["stdio"])) === undefined);
  check("admission: an invalid entry is not refused", thrownBy(() => assertMcpTransportsPermitted({ bad: raw({ command: 42 }) }, HTTP_ONLY)) === undefined);

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${checks.length} checks passed`);
}

await main();
