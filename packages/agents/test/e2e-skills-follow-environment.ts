/**
 * Skills follow the EXECUTION environment, not the host's disk. The catalog the model sees is the
 * one whose scripts its Bash can reach: the harness scans through the environment its preset
 * named (`HarnessParts.environment`), and a session that brings its own environment scans through
 * THAT instead of reading the process-wide registry.
 * "Remote" here is simply a LocalEnvironment rooted in a different directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "./faux.ts";
import { createLocalHarness, LocalEnvironment, type HarnessSession } from "../src/index.ts";

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
  return (session.core.service("skills")?.listSkills() ?? []).map((skill) => skill.name).filter((name) => name.endsWith("-skill")).sort();
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
      check("baseline: a session on the harness's environment sees the harness's skills", names(plain).join(",") === "local-skill");

      const own = await harness.createSession({ environment: new LocalEnvironment(remote) });
      check("own environment (instance): the catalog comes from THAT environment, not the host's disk", names(own).join(",") === "remote-skill");

      const viaFactory = await harness.createSession({ environment: () => new LocalEnvironment(remote) });
      check("own environment (factory): same — scanned through the session's environment", names(viaFactory).join(",") === "remote-skill");
      check("own environment: the shared registry the harness scanned is untouched", names(plain).join(",") === "local-skill");

      const second = await harness.createSession();
      check("two plain sessions share the one scan the harness did", names(second).join(",") === names(plain).join(","));

      // A session in another workDir, no environment given: it runs THERE (not at the harness's
      // default workDir) and its catalog is scanned there, not borrowed from the shared scan.
      const elsewhere = await harness.createSession({ workDir: remote });
      check("other workDir: the session's environment is rooted at its own workDir", elsewhere.environment.getcwd() === remote);
      check("other workDir: the catalog comes from its own workDir", names(elsewhere).join(",") === "remote-skill");
      check("default workDir: a plain session still runs at the harness's workDir", plain.environment.getcwd() === local);
      await harness.close();
    }

    // ── A "remote" harness: the preset says what environment everything executes on ──
    {
      const harness = await createLocalHarness({ ...base, harness: () => ({ environment: new LocalEnvironment(remote) }) });
      const session = await harness.createSession();
      check("harness environment (instance): the scan ran through it, not the host's disk", names(session).join(",") === "remote-skill");
      await harness.close();
    }
    {
      // An environment FACTORY has no single filesystem to scan once, so each session scans
      // through the environment the factory gave it.
      const harness = await createLocalHarness({ ...base, harness: () => ({ environment: () => new LocalEnvironment(remote) }) });
      const session = await harness.createSession();
      check("harness environment (factory): each session scans through the environment it was given", names(session).join(",") === "remote-skill");
      await harness.close();
    }
    {
      // A session's own environment still wins over the harness's.
      const third = join(root, "third");
      skillDir(third, "third-skill");
      const harness = await createLocalHarness({ ...base, harness: () => ({ environment: new LocalEnvironment(remote) }) });
      const session = await harness.createSession({ environment: new LocalEnvironment(third) });
      check("precedence: the session's own environment wins over the harness's", names(session).join(",") === "third-skill");
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
