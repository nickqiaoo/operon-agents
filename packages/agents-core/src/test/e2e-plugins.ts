import { testRunner, openTestSession } from "./faux.ts";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { LocalMachine, Session, SkillRegistry, discoverSkills, skillsCapability } from "../index.ts";
import { mcpServersCapability } from "../mcp/index.ts";
import {
  PluginManager,
  PluginSessionStartInjector,
  pluginsCapability,
  resolveInstallSource,
  parseManifest,
  parseHooksDocument,
  extractZip,
  type SessionStartSkillResolver,
} from "../plugins/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const MACHINE = new LocalMachine(process.cwd());

async function writePlugin(root: string, manifest: object, skill?: { dir: string; name: string; body: string }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "agents.plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (skill) {
    const skillDir = path.join(root, skill.dir, skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.name} skill\n---\n${skill.body}\n`, "utf8");
  }
}

function testSourceParsing(): void {
  check("source: absolute path → local-path", resolveInstallSource("/abs/plugin").kind === "local-path");
  check("source: https .zip → zip-url", resolveInstallSource("https://example.com/p.zip").kind === "zip-url");

  const gh = resolveInstallSource("https://github.com/acme/widget");
  check("source: github repo → github (no ref)", gh.kind === "github" && gh.owner === "acme" && gh.repo === "widget" && gh.ref === undefined);

  const ghTree = resolveInstallSource("https://github.com/acme/widget/tree/main");
  check("source: github /tree/main → branch ref", ghTree.kind === "github" && ghTree.ref?.kind === "branch" && ghTree.ref.value === "main");

  const ghTag = resolveInstallSource("https://github.com/acme/widget/releases/tag/v1.2.3");
  check("source: github /releases/tag → tag ref", ghTag.kind === "github" && ghTag.ref?.kind === "tag" && ghTag.ref.value === "v1.2.3");

  let threw = false;
  try {
    resolveInstallSource("relative/path");
  } catch {
    threw = true;
  }
  check("source: relative path rejected", threw);

  const legitSub = resolveInstallSource("https://github.com/acme/widget#path=plugins/foo");
  check("source: legit monorepo subdir preserved", legitSub.kind === "github" && legitSub.subdir === "plugins/foo");
  const escapeSub = resolveInstallSource("https://github.com/acme/widget#path=../../../etc");
  check("source: `..` in subdir is neutralized (cannot escape repo root)", escapeSub.kind === "github" && escapeSub.subdir === "etc");
}

function testHooksParsing(): void {
  const flat = parseHooksDocument([
    { event: "PreToolUse", matcher: "Write", command: "echo block" },
    { event: "UnknownEvent", command: "echo no" },
  ]);
  check("hooks flat: keeps known PreToolUse", flat.hooks.length === 1 && flat.hooks[0]!.event === "PreToolUse" && flat.hooks[0]!.matcher === "Write");
  check("hooks flat: unknown event is skipped with diagnostic", flat.diagnostics.some((d) => d.message.includes("UnknownEvent")));

  const nested = parseHooksDocument({
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: "python3 ${PLUGIN_ROOT}/hooks/start.py", timeout: 5 }],
        },
      ],
      PreToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [{ type: "command", command: "echo deny" }],
        },
      ],
    },
  });
  check(
    "hooks nested: SessionStart + PreToolUse with matcher",
    nested.hooks.length === 2 &&
      nested.hooks.some((h) => h.event === "SessionStart" && h.command.includes("${PLUGIN_ROOT}")) &&
      nested.hooks.some((h) => h.event === "PreToolUse" && h.matcher === "Write|Edit"),
  );
  check("hooks nested: timeout seconds → ms", nested.hooks.find((h) => h.event === "SessionStart")?.timeout === 5000);
}

async function testZipSlipExtraction(): Promise<void> {
  let zipSync: ((files: Record<string, Uint8Array>) => Uint8Array) | undefined;
  try {
    ({ zipSync } = (await import("fflate")) as { zipSync: (f: Record<string, Uint8Array>) => Uint8Array });
  } catch {
    check("zip-slip: skipped (fflate not installed)", true);
    return;
  }
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const exists = (p: string): Promise<boolean> => readFile(p, "utf8").then(() => true).catch(() => false);
  const base = path.join(os.tmpdir(), `agents-zipslip-e2e-${process.pid}`);
  const dest = path.join(base, "extract");
  try {
    await mkdir(dest, { recursive: true });

    // A legit archive extracts and everything lands inside destDir.
    await extractZip(Buffer.from(zipSync({ "plugin.json": enc("{}"), "skills/a.md": enc("hi") })), dest);
    check("zip-slip: a legit archive extracts normally", await exists(path.join(dest, "skills/a.md")));

    // `../` traversal entry is refused and nothing is written outside destDir.
    let refusedDotDot = false;
    try {
      await extractZip(Buffer.from(zipSync({ "../../escaped.txt": enc("pwned") })), dest);
    } catch (error) {
      refusedDotDot = error instanceof Error && /zip-slip/i.test(error.message);
    }
    check(
      "zip-slip: `..` traversal entry is refused, no file escapes destDir",
      refusedDotDot && !(await exists(path.join(base, "..", "escaped.txt"))) && !(await exists(path.join(path.dirname(base), "escaped.txt"))),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testSourceParsing();
  testHooksParsing();
  await testZipSlipExtraction();

  const tmp = path.join(os.tmpdir(), `agents-plugins-e2e-${process.pid}`);
  const home = path.join(tmp, "home");
  const goodRoot = path.join(tmp, "demo-plugin");
  const badRoot = path.join(tmp, "broken-plugin");

  try {
    await writePlugin(
      goodRoot,
      {
        name: "demo-plugin",
        version: "1.0.0",
        skills: ["./skills"],
        skillInstructions: "Prefer the demo skills.",
        sessionStart: { skill: "greet" },
        mcpServers: { weather: { transport: "stdio", command: "weather-mcp" } },
        interface: { displayName: "Demo" },
      },
      { dir: "skills", name: "greet", body: "Greet the user warmly." },
    );
    // Default Codex path hooks/hooks.json (no manifest.hooks field required).
    await mkdir(path.join(goodRoot, "hooks"), { recursive: true });
    await writeFile(
      path.join(goodRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: `echo block-from-\${PLUGIN_ROOT}` }],
            },
          ],
        },
      }),
      "utf8",
    );
    await writePlugin(badRoot, { description: "no name field" }); // missing required name → error

    // 2. manifest parsing.
    const parsed = await parseManifest(MACHINE, goodRoot);
    check("manifest: parsed with no error diagnostics", parsed.manifest !== undefined && !parsed.diagnostics.some((d) => d.severity === "error"));
    check("manifest: name + skills + sessionStart + mcpServers", parsed.manifest?.name === "demo-plugin" && (parsed.manifest?.skills?.length ?? 0) === 1 && parsed.manifest?.sessionStart?.skill === "greet" && parsed.manifest?.mcpServers?.["weather"] !== undefined);
    check(
      "manifest: default hooks/hooks.json loaded + PLUGIN_ROOT expanded",
      (parsed.manifest?.hooks?.length ?? 0) === 1 &&
        parsed.manifest?.hooks?.[0]?.event === "PreToolUse" &&
        parsed.manifest?.hooks?.[0]?.matcher === "Write" &&
        (parsed.manifest?.hooks?.[0]?.command.includes(goodRoot) ?? false) &&
        !(parsed.manifest?.hooks?.[0]?.command.includes("${PLUGIN_ROOT}") ?? true),
    );

    // 3. manager install + contributions.
    const mgr = new PluginManager({ machine: MACHINE, homeDir: home, now: () => 1_700_000_000_000 });
    const rec = await mgr.install(goodRoot);
    check("manager: install(local-path) → state ok", rec.state === "ok" && rec.id === "demo-plugin");
    check("manager: skillRoots() exposes the plugin skills dir + instructions", mgr.skillRoots().length === 1 && mgr.skillRoots()[0]!.plugin?.id === "demo-plugin" && mgr.skillRoots()[0]!.plugin?.instructions === "Prefer the demo skills.");
    check("manager: mcpServerConfigs() keyed plugin-<id>:<server>", mgr.mcpServerConfigs()["plugin-demo-plugin:weather"]?.command === "weather-mcp");
    check("manager: sessionStarts() lists the session-start skill", mgr.sessionStarts().length === 1 && mgr.sessionStarts()[0]!.skillName === "greet");
    check("manager: hookDefs() exposes plugin shell hooks", mgr.hookDefs().length === 1 && mgr.hookDefs()[0]!.event === "PreToolUse");
    check("manager: summaries include enabled MCP server count", mgr.summaries()[0]?.enabledMcpServerCount === 1);
    check("manager: info() exposes MCP server runtime details", mgr.info("demo-plugin")?.mcpServers[0]?.runtimeName === "plugin-demo-plugin:weather");

    // 4. enable/disable toggles contributions.
    await mgr.setEnabled("demo-plugin", false);
    check("disable: contributions drop to empty", mgr.skillRoots().length === 0 && mgr.sessionStarts().length === 0 && mgr.hookDefs().length === 0 && Object.keys(mgr.mcpServerConfigs()).length === 0);
    await mgr.setEnabled("demo-plugin", true);
    check("enable: contributions restored", mgr.skillRoots().length === 1 && mgr.hookDefs().length === 1);
    await mgr.setMcpServerEnabled("demo-plugin", "weather", false);
    check("mcp toggle: disabled plugin MCP server stops contributing", Object.keys(mgr.mcpServerConfigs()).length === 0 && mgr.info("demo-plugin")?.mcpServers[0]?.enabled === false);

    // 5. persist + reload (fresh manager rehydrates from installed.json).
    const mgr2 = new PluginManager({ machine: MACHINE, homeDir: home, now: () => 1_700_000_000_000 });
    await mgr2.load();
    check("persist+reload: fresh manager rehydrates the installed plugin", mgr2.get("demo-plugin")?.state === "ok" && mgr2.skillRoots().length === 1);
    check("persist+reload: per-server MCP enabled override round-trips", Object.keys(mgr2.mcpServerConfigs()).length === 0 && mgr2.info("demo-plugin")?.enabledMcpServerCount === 0);
    await mgr2.setMcpServerEnabled("demo-plugin", "weather", true);
    check("mcp toggle: re-enabled plugin MCP server contributes again", mgr2.mcpServerConfigs()["plugin-demo-plugin:weather"]?.command === "weather-mcp");

    // 6. isolation — a broken plugin installs as error but is rejected from install (no manifest);
    //    a directly-installed broken record alongside a good one stays isolated.
    let installThrew = false;
    try {
      await mgr2.install(badRoot);
    } catch {
      installThrew = true;
    }
    check("isolation: installing a manifest-less plugin throws (not silently ok)", installThrew);
    check("isolation: the good plugin is unaffected", mgr2.get("demo-plugin")?.state === "ok");

    // 7. session-start injector — renders the block once.
    const registry = new SkillRegistry();
    await registry.loadRoots(MACHINE, mgr.skillRoots());
    const resolveSkill: SessionStartSkillResolver = (_pid, name) => (registry.getSkill(name) ? `BODY:${name}` : undefined);
    const injector = new PluginSessionStartInjector(mgr, resolveSkill);
    const first = injector.inject({ history: [], sessionId: "s", address: "main", originOf: () => undefined });
    check("session-start: injects a <plugin_session_start> block with the skill body", first !== null && first.text.includes('<plugin_session_start plugin="demo-plugin" skill="greet">') && first.text.includes("BODY:greet"));
    const second = injector.inject({
      history: [{ role: "user", content: [{ type: "text", text: "x" }], timestamp: 0 }],
      sessionId: "s",
      address: "main",
      originOf: () => undefined,
    });
    check("session-start: injects only once per session", second === null);

    // 8. skills bridge — manager.skillRoots() feed discoverSkills; the plugin skill is found.
    const discovered = await discoverSkills(MACHINE, { roots: mgr.skillRoots() });
    const greet = discovered.find((s) => s.name === "greet");
    check("skills bridge: the plugin skill is discoverable with plugin context", greet !== undefined && greet.plugin?.id === "demo-plugin");

    // 8b. dynamicRoots bridge — skillsCapability merges plugin skill roots at session-open, so an
    //     enabled plugin's skill shows up in the session's skill list (how operon loads them).
    const skillSession = await openTestSession({
      machine: MACHINE,
      capabilities: [skillsCapability({ dynamicRoots: () => mgr.skillRoots() })],
    });
    try {
      const skills = await skillSession.listSkills();
      check("dynamicRoots bridge: enabled plugin skill loads into a session via skillsCapability", skills.some((s) => s.name === "greet"));
    } finally {
      await skillSession.close();
    }

    // 8c. mcp bridge — operon merges manager.mcpServerConfigs() into mcpServersCapability, so an
    //     enabled plugin's MCP server becomes a controller (inspected pre-connect, no spawn).
    //     Uses mgr2, where the weather server is enabled (mgr disabled it earlier in section 4).
    const mcpCap = mcpServersCapability(mgr2.mcpServerConfigs());
    check("mcp bridge: enabled plugin MCP server becomes a controller in mcpServersCapability", (mcpCap.toolProviders ?? []).some((p) => p.id === "mcp:plugin-demo-plugin:weather"));

    // 9. session facade — the plugin manager is reachable through Session.
    const session = await openTestSession({
      machine: MACHINE,
      capabilities: [pluginsCapability(mgr2, () => undefined)],
    });
    try {
      check("session facade: listPlugins reaches PluginManager service", (await session.listPlugins()).some((plugin) => plugin.id === "demo-plugin"));
      await session.setPluginEnabled("demo-plugin", false);
      check("session facade: setPluginEnabled persists through the manager", (await session.listPlugins())[0]?.enabled === false);
      const info = await session.getPluginInfo("demo-plugin");
      check("session facade: getPluginInfo returns diagnostics + MCP info", info?.mcpServers[0]?.runtimeName === "plugin-demo-plugin:weather");
    } finally {
      await session.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ PLUGINS E2E PASS — source + manifest + manager + enable/disable + persist/reload + isolation + sessionStart + skills bridge");
  } else {
    console.log("❌ PLUGINS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ PLUGINS E2E ERROR:", error);
  process.exit(1);
});
