/**
 * Skills follow the EXECUTION machine, not the host's disk. The catalog the model sees is the
 * one whose scripts its Bash can reach: a workspace scans through its `T.WorkspaceMachineFactory`
 * (a remote workspace registers it in the `workspace` hook), and a session that brings its own
 * machine scans through that machine instead of reading the workspace's shared registry.
 * "Remote" here is simply a LocalMachine rooted in a different directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "./faux.ts";
import { createLocalHarness, LocalMachine, T, type HarnessSession } from "../src/index.ts";

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
  return (session.core.get(T.Skills)?.listSkills() ?? []).map((skill) => skill.name).filter((name) => name.endsWith("-skill")).sort();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "skills-machine-"));
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

    // ── Plain local harness: the baseline, and sessions bringing their own machine ──
    {
      const harness = await createLocalHarness(base);
      const plain = await harness.createSession();
      check("baseline: a session on the workspace's machine sees the workspace's skills", names(plain).join(",") === "local-skill");

      const own = await harness.createSession({ machine: new LocalMachine(remote) });
      check("own machine (instance): the catalog comes from THAT machine, not the host's disk", names(own).join(",") === "remote-skill");

      const viaFactory = await harness.createSession({ machine: () => new LocalMachine(remote) });
      check("own machine (factory): same — scanned through the session's machine", names(viaFactory).join(",") === "remote-skill");
      check("own machine: the shared registry the workspace scanned is untouched", names(plain).join(",") === "local-skill");
      await harness.close();
    }

    // ── A "remote workspace": the host's `workspace` hook says what machine it executes on ──
    {
      const harness = await createLocalHarness({
        ...base,
        workspace: (scope) => {
          scope.register(T.WorkspaceMachineFactory, new LocalMachine(remote), { owned: false });
        },
      });
      const session = await harness.createSession();
      check("remote workspace (machine instance): the workspace scan ran through the registered machine", names(session).join(",") === "remote-skill");
      check("remote workspace: it IS the shared registry (one scan for the workspace)", session.core.scope.parent?.hasLocal(T.SkillRegistry) === true);
      await harness.close();
    }
    {
      const harness = await createLocalHarness({
        ...base,
        workspace: (scope) => {
          scope.register(T.WorkspaceMachineFactory, () => new LocalMachine(remote), { owned: false });
        },
      });
      const session = await harness.createSession();
      check("remote workspace (machine factory): no single filesystem to share — no shared registry", session.core.scope.parent?.hasLocal(T.SkillRegistry) === false);
      check("remote workspace (machine factory): each session scans through the machine the factory gave it", names(session).join(",") === "remote-skill");
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
