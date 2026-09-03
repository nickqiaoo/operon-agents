import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "./faux.ts";
import { defineModel, LocalMachine, PluginManager } from "operon-agents-core";
import { createHarness, defaultCapabilities } from "../src/index.ts";

// Verifies the framework "self-drives" from a PluginManager: pass it to defaultCapabilities and a
// harness session gets the plugin's skills + MCP — and that a capability FACTORY is invoked fresh
// per session (so per-session state is isolated, mirroring a fresh-Session-per-create model).

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function writePlugin(root: string): void {
  mkdirSync(join(root, "skills", "greet"), { recursive: true });
  writeFileSync(
    join(root, "agents.plugin.json"),
    JSON.stringify({
      name: "demo-plugin",
      version: "1.0.0",
      skills: ["./skills"],
      skillInstructions: "Prefer the demo skills.",
      sessionStart: { skill: "greet" },
      mcpServers: { weather: { transport: "stdio", command: "weather-mcp" } },
    }),
  );
  writeFileSync(join(root, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: greet skill\n---\nGreet warmly.\n");
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "af-hp-home-"));
  const work = mkdtempSync(join(tmpdir(), "af-hp-work-"));
  const pluginRoot = join(work, "demo-plugin");
  writePlugin(pluginRoot);

  const pm = new PluginManager({ machine: new LocalMachine(home), homeDir: home });
  await pm.install(pluginRoot);

  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;

  let factoryCalls = 0;
  const harness = createHarness({
    model,
    homeDir: home,
    workDir: work,
    permission: { mode: "yolo" },
    // Fresh capabilities per session, self-driven from the plugin manager.
    session: () => {
      factoryCalls += 1;
      return defaultCapabilities({ pluginManager: pm });
    },
  });

  try {
    const s1 = await harness.createSession();
    const skills = await s1.listSkills();
    check("self-drive: plugin skill loads via defaultCapabilities({pluginManager})", skills.some((s) => s.name === "greet"));

    const mcp = await s1.listMcpServers();
    check("self-drive: plugin MCP server present (namespaced)", mcp.some((m) => m.name === "plugin-demo-plugin:weather"));

    const s2 = await harness.createSession();
    void s2;
    check("isolation: capability factory invoked fresh per session", factoryCalls === 2);

    // Disabling the plugin and opening a NEW session drops its skill — no harness eviction needed,
    // because the factory re-reads the manager each session.
    await pm.setEnabled("demo-plugin", false);
    const s3 = await harness.createSession();
    const skills3 = await s3.listSkills();
    check("self-drive: disabling a plugin removes its skill from the next session", !skills3.some((s) => s.name === "greet"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    faux.unregister();
  }

  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? "\n✅ HARNESS-PLUGINS E2E PASS — self-driven skills + MCP from a PluginManager, fresh per session" : "\n❌ HARNESS-PLUGINS E2E FAIL");
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("❌ ERROR:", error);
  process.exit(1);
});
