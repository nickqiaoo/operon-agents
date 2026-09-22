/**
 * Skills follow the EXECUTION environment, not the host's disk. The catalog the model sees is the
 * one whose scripts its Bash can reach: a workspace scans through its `Tokens.WorkspaceEnvironmentFactory`
 * (a remote workspace registers it in the `workspace` hook), and a session that brings its own
 * environment scans through that environment instead of reading the workspace's shared registry.
 * "Remote" here is simply a LocalEnvironment rooted in a different directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "./faux.ts";
import { createLocalHarness, LocalEnvironment, Tokens, type HarnessSession } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function skillDir(root: string, name: string): void {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nUse ${name}.\n`);
}

function names(session: HarnessSession): string[] {
  return (session.core.get(Tokens.Skills)?.listSkills() ?? []).map((skill) => skill.name).filter((name) => name.endsWith("-skill")).sort();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "skills-environment-"));
  const home = join(root, "home");
  const local = join(root, "local");
  const remote = join(root, "remote");
  mkdirSync(home);
  skillDir(local, "local-skill");
  skillDir(remote, "remote-skill");
  try {
    const faux = registerFauxProvider();
    const model = faux.getChatModel()!;
    const base = { model, homeDir: home, workDir: local, permission: { mode: "yolo" as const }, loadDiskProfiles: false };

    // ── Plain local harness: the baseline, and sessions bringing their own environment ──
    {
      const harness = await createLocalHarness(base);
      const plain = await harness.createSession();
      check("baseline: a session on the workspace's environment sees the workspace's skills", names(plain).join(",") === "local-skill");

      const own = await harness.createSession({ environment: new LocalEnvironment(remote) });
      check("own environment (instance): the catalog comes from THAT environment, not the host's disk", names(own).join(",") === "remote-skill");

      const viaFactory = await harness.createSession({ environment: () => new LocalEnvironment(remote) });
      check("own environment (factory): same — scanned through the session's environment", names(viaFactory).join(",") === "remote-skill");
      check("own environment: the shared registry the workspace scanned is untouched", names(plain).join(",") === "local-skill");
      await harness.close();
    }

    // ── A "remote workspace": the host's `workspace` hook says what environment it executes on ──
    {
      const harness = await createLocalHarness({
        ...base,
        workspace: (scope) => {
          scope.register(Tokens.WorkspaceEnvironmentFactory, new LocalEnvironment(remote), { owned: false });
        },
      });
      const session = await harness.createSession();
      check("remote workspace (environment instance): the workspace scan ran through the registered environment", names(session).join(",") === "remote-skill");
      check("remote workspace: it IS the shared registry (one scan for the workspace)", session.core.scope.parent?.hasLocal(Tokens.SkillRegistry) === true);
      await harness.close();
    }
    {
      const harness = await createLocalHarness({
        ...base,
        workspace: (scope) => {
          scope.register(Tokens.WorkspaceEnvironmentFactory, () => new LocalEnvironment(remote), { owned: false });
        },
      });
      const session = await harness.createSession();
      check("remote workspace (environment factory): no single filesystem to share — no shared registry", session.core.scope.parent?.hasLocal(Tokens.SkillRegistry) === false);
      check("remote workspace (environment factory): each session scans through the environment the factory gave it", names(session).join(",") === "remote-skill");
      await harness.close();
    }

    // ── The HARNESS default environment (`Tokens.EnvironmentFactory`): the workspace scan must follow it too ──
    {
      const harness = await createLocalHarness({
        ...base,
        harness: (scope) => {
          scope.register(Tokens.EnvironmentFactory, new LocalEnvironment(remote), { owned: false });
        },
      });
      const session = await harness.createSession();
      check("harness default (environment instance): the workspace scan ran through the harness's environment, not the host's disk", names(session).join(",") === "remote-skill");
      check("harness default (environment instance): it IS the shared registry", session.core.scope.parent?.hasLocal(Tokens.SkillRegistry) === true);
      await harness.close();
    }
    {
      const harness = await createLocalHarness({
        ...base,
        harness: (scope) => {
          scope.register(Tokens.EnvironmentFactory, () => new LocalEnvironment(remote), { owned: false });
        },
      });
      const session = await harness.createSession();
      check("harness default (environment factory): no shared registry", session.core.scope.parent?.hasLocal(Tokens.SkillRegistry) === false);
      check("harness default (environment factory): each session scans through the environment the factory gave it", names(session).join(",") === "remote-skill");
      await harness.close();
    }
    {
      // Precedence: a workspace's own environment beats the harness default, same as in Session.open.
      const third = join(root, "third");
      skillDir(third, "third-skill");
      const harness = await createLocalHarness({
        ...base,
        harness: (scope) => {
          scope.register(Tokens.EnvironmentFactory, new LocalEnvironment(remote), { owned: false });
        },
        workspace: (scope) => {
          scope.register(Tokens.WorkspaceEnvironmentFactory, new LocalEnvironment(third), { owned: false });
        },
      });
      const session = await harness.createSession();
      check("precedence: the workspace's environment wins over the harness default", names(session).join(",") === "third-skill");
      await harness.close();
    }

    faux.unregister();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
