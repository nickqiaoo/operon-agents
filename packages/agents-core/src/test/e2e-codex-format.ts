import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMachine,
  loadMarketplace,
  loadMarketplaceEntryDetails,
  parseGithubMarketplaceSource,
  PluginManager,
} from "../index.ts";
import { resolveInstallSource } from "../plugins/index.ts";

// Verifies operon-agents consumes a Codex github plugin repo (github.com/openai/plugins style):
// the repo cached locally, index read from `.agents/plugins/marketplace.json`, `local` entries → an
// absolute path in the repo (install = local copy), `.codex-plugin/plugin.json` manifest (skills path,
// mcpServers → .mcp.json with `type` not `transport`), and logo/description read from the cached repo.

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "af-codex-repo-")); // a cached marketplace repo root
  const home = mkdtempSync(join(tmpdir(), "af-codex-home-"));

  // plugins/linear: a Codex plugin with manifest + skill + .mcp.json + a logo asset.
  const plug = join(repo, "plugins", "linear");
  mkdirSync(join(plug, ".codex-plugin"), { recursive: true });
  mkdirSync(join(plug, "skills", "greet"), { recursive: true });
  mkdirSync(join(plug, "assets"), { recursive: true });
  writeFileSync(
    join(plug, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "linear",
      version: "0.0.1",
      description: "Find and reference issues.",
      skills: "./skills/",
      apps: "./.app.json",
      mcpServers: "./.mcp.json",
      interface: { displayName: "Linear", shortDescription: "Find issues.", category: "Productivity", logo: "./assets/icon.png", brandColor: "#5E6AD2" },
    }),
  );
  writeFileSync(join(plug, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: greet\n---\nGreet.\n");
  writeFileSync(
    join(plug, ".mcp.json"),
    JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth_resource: "https://mcp.linear.app/mcp" } } }),
  );
  writeFileSync(join(plug, "assets", "icon.png"), "PNGDATA");

  // The marketplace index at the standard Codex path inside the repo.
  mkdirSync(join(repo, ".agents", "plugins"), { recursive: true });
  writeFileSync(
    join(repo, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "openai-curated",
      interface: { displayName: "Codex official" },
      plugins: [{ name: "linear", source: { source: "local", path: "./plugins/linear" }, policy: { installation: "AVAILABLE" }, category: "Productivity" }],
    }),
  );

  // 1. Cached repo: name→id, `local` object-source → absolute path inside the repo.
  const mk = await loadMarketplace({ source: "fake/repo", repoDir: repo });
  const entry = mk.plugins.find((p) => p.id === "linear");
  check("cached repo: name→id + local source → abs path in repo", entry !== undefined && entry.source === plug);

  // 2. Install the Codex plugin from the local path: manifest parsed, skill + MCP picked up.
  const pm = new PluginManager({ machine: new LocalMachine(home), homeDir: home });
  const rec = await pm.install(entry!.source);
  check("install: .codex-plugin/plugin.json parsed, state ok", rec.state === "ok" && rec.id === "linear");
  check("install: skill dir resolved from string `skills` path", pm.skillRoots().some((r) => r.plugin?.id === "linear"));
  const mcp = pm.mcpServerConfigs();
  check(
    "install: mcpServers read from .mcp.json (type→transport http)",
    mcp["plugin-linear:linear"]?.transport === "http" && mcp["plugin-linear:linear"]?.url === "https://mcp.linear.app/mcp",
  );

  // 3. Detail enrichment reads the manifest + logo from the CACHED repo (no network).
  const det = await loadMarketplaceEntryDetails(entry!.source);
  check("details: displayName + description from manifest", det?.displayName === "Linear" && det?.description === "Find issues.");
  check("details: logoPath → local asset under the repo (exists)", det?.logoPath === join(plug, "assets", "icon.png") && existsSync(det!.logoPath!));
  check("details: brandColor passthrough", det?.brandColor === "#5E6AD2");

  // 4. resolveInstallSource still understands github `/tree/<ref>#path=` (for git-subdir Codex entries).
  const r = resolveInstallSource("https://github.com/openai/plugins/tree/HEAD#path=plugins/linear");
  check(
    "source: github `/tree/HEAD#path=…` → {github, owner, repo, subdir}",
    r.kind === "github" && r.owner === "openai" && r.repo === "plugins" && r.subdir === "plugins/linear",
  );

  // 5. parseGithubMarketplaceSource: accepts owner/repo + github URL, rejects .json / non-repo.
  check(
    "parse: `openai/plugins` → owner/repo",
    JSON.stringify(parseGithubMarketplaceSource("openai/plugins")) === JSON.stringify({ owner: "openai", repo: "plugins" }),
  );
  check("parse: github URL `/tree/main` → ref", parseGithubMarketplaceSource("https://github.com/openai/plugins/tree/main")?.ref === "main");
  check("parse: rejects a direct .json URL", parseGithubMarketplaceSource("https://x.com/marketplace.json") === undefined);

  // 6. loadMarketplace rejects a non-github source (operon string-source format removed).
  let rejected = false;
  try {
    await loadMarketplace({ source: "https://x.com/marketplace.json", repoDir: repo });
  } catch {
    rejected = true;
  }
  check("loadMarketplace: rejects a non-github source", rejected);

  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });

  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? "\n✅ CODEX-FORMAT E2E PASS — cached repo + manifest + .mcp.json + logo + github-only" : "\n❌ CODEX-FORMAT E2E FAIL");
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("❌ ERROR:", error);
  process.exit(1);
});
