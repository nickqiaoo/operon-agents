import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LocalMachine } from "../index.ts";
import { loadMcpServers } from "../mcp/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// ── Three tiers merge by server name, low → high: user < project < local ──
async function testLayering(root: string): Promise<void> {
  const homeDir = join(root, "home");
  const cwd = join(root, "proj"); // no .git → project root = cwd
  mkdirSync(cwd, { recursive: true });

  writeJson(join(homeDir, "mcp.json"), {
    mcpServers: { shared: { type: "http", url: "https://user-only" }, common: { type: "http", url: "https://user-common" } },
  });
  writeJson(join(cwd, "mcp.json"), {
    mcpServers: { proj: { command: "node", args: ["s.js"], cwd: "./sub" }, common: { type: "http", url: "https://project-common" } },
  });
  writeJson(join(cwd, "mcp.local.json"), {
    mcpServers: { common: { type: "http", url: "https://local-common" } },
  });

  const machine = new LocalMachine(cwd);
  const { servers, layers } = await loadMcpServers(machine, { appName: "agents", homeDir, cwd });

  check("layer: user-only server present", servers["shared"]?.url === "https://user-only");
  check("layer: project server present", servers["proj"] !== undefined);
  check("layer: local wins over project over user (same name)", servers["common"]?.url === "https://local-common");
  check("layer: stdio cwd resolved against project root", servers["proj"]?.transport === "stdio" && isAbsolute(servers["proj"]!.cwd!) && servers["proj"]!.cwd === join(cwd, "sub"));
  check("layer: all three tiers reported loaded", layers.every((l) => l.loaded) && layers.map((l) => l.tier).join(",") === "user,project,local");
}

// ── Missing tiers are skipped; absent tiers reported not loaded ──
async function testSparse(root: string): Promise<void> {
  const homeDir = join(root, "home2");
  const cwd = join(root, "proj2");
  mkdirSync(cwd, { recursive: true });
  writeJson(join(cwd, "mcp.json"), { mcpServers: { only: { type: "http", url: "https://only" } } });

  const machine = new LocalMachine(cwd);
  const { servers, layers } = await loadMcpServers(machine, { appName: "agents", homeDir, cwd });
  check("sparse: resolves with only the project tier", servers["only"]?.url === "https://only" && Object.keys(servers).length === 1);
  check("sparse: absent tiers reported not loaded", layers.filter((l) => !l.loaded).map((l) => l.tier).sort().join(",") === "local,user");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-mcpcfg-e2e-"));
  try {
    await testLayering(root);
    await testSparse(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ MCP-CONFIG E2E PASS — user/project/local MCP config layering + precedence + stdio cwd normalization");
  } else {
    console.log("❌ MCP-CONFIG E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ MCP-CONFIG E2E ERROR:", error);
  process.exit(1);
});
