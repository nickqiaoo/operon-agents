/**
 * A harness session on several environments: `bindings.additionalEnvironments`.
 *
 *  - the tools reach every named environment through `target`; no target means the root
 *  - a session that has only `environment` is the single-environment session it always was
 *  - names are checked when the session is created, before anything is opened
 *  - the session keeps the declaration: a reopen that hands in fewer instances still has every
 *    environment (the missing ones unavailable); an undeclared name is refused
 *  - updateEnvironments changes the declaration; subagent access is part of it
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { createHarness, HarnessConfigError, LocalEnvironment } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function rejectsWith(promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (error) {
    return error instanceof type;
  }
}

async function main(): Promise<void> {
  const local = realpathSync(mkdtempSync(join(tmpdir(), "harness-env-local-")));
  const build = realpathSync(mkdtempSync(join(tmpdir(), "harness-env-build-")));
  const faux = registerFauxProvider();
  try {
    const harness = createHarness({
      ...faux.harnessModel(),
      config: { workDir: local, defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } },
    });
    const localEnv = new LocalEnvironment(local);
    const buildEnv = new LocalEnvironment(build);

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("Write", { path: "where.txt", content: "build", target: "build" }),
          fauxToolCall("Write", { path: "where.txt", content: "local" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const session = await harness.createSession({
      workDir: local,
      bindings: {
        environment: localEnv,
        environmentName: "local",
        additionalEnvironments: { build: { environment: buildEnv, description: "the build machine", subagentAccess: "home-only" } },
      },
    });
    check("the session knows both environments", session.core.environments.names.join(",") === "local,build");
    check("additional environments are not a reopen requirement", !session.requires.includes("additionalEnvironments"));
    check("subagent access is part of the declaration", session.core.environments.subagentAccessFor("build") === "home-only");
    const result = await session.prompt("write it on both");
    check("the run completes", result.status === "completed");
    check("the targeted write landed on build", readFileSync(join(build, "where.txt"), "utf8") === "build");
    check("the untargeted write landed on the root", readFileSync(join(local, "where.txt"), "utf8") === "local");
    await session.close();

    const bare = await harness.resumeSession(session.id, { bindings: { environment: localEnv } });
    check("reopening without them keeps the declaration", bare.core.environments.names.join(",") === "local,build");
    check("the missing one is unavailable, not gone", bare.core.environments.get("build")?.available === false);
    check("the declaration keeps its description and access", bare.core.environments.get("build")?.description === "the build machine" && bare.core.environments.subagentAccessFor("build") === "home-only");
    await bare.close();
    check(
      "reopening with an undeclared name is refused",
      await rejectsWith(harness.resumeSession(session.id, { bindings: { environment: localEnv, additionalEnvironments: { test: buildEnv } } }), HarnessConfigError),
    );
    check(
      "reopening under another root name is refused",
      await rejectsWith(harness.resumeSession(session.id, { bindings: { environment: localEnv, environmentName: "main" } }), HarnessConfigError),
    );
    const again = await harness.resumeSession(session.id, { bindings: { environment: localEnv, additionalEnvironments: { build: buildEnv } } });
    check("reopening with it connects it again", again.core.environments.get("build")?.available === true);
    await again.updateEnvironments({ add: { test: { environment: new LocalEnvironment(local), description: "tests" } }, update: { build: { subagentAccess: null } } });
    check("updateEnvironments adds to the declaration", again.core.environments.names.join(",") === "local,build,test");
    check("updateEnvironments clears a field with null", again.core.environments.subagentAccessFor("build") === "inherit");
    check("updateEnvironments refuses removing the root", await rejectsWith(again.updateEnvironments({ remove: ["local"] }), HarnessConfigError));
    await again.close();
    const later = await harness.resumeSession(session.id, { bindings: { environment: localEnv } });
    check("the update is what the next open declares", later.core.environments.names.join(",") === "local,build,test");
    await later.close();

    const plain = await harness.createSession({ workDir: local, bindings: { environment: localEnv } });
    check("a plain session has one environment", plain.core.environments.size === 1);
    check("a plain session does not require additional environments", !plain.requires.includes("additionalEnvironments"));
    await plain.close();

    check(
      "a bad environment name is a configuration error",
      await rejectsWith(harness.createSession({ workDir: local, bindings: { environment: localEnv, additionalEnvironments: { "Build Box": buildEnv } } }), HarnessConfigError),
    );
    check(
      "reusing the root's name is a configuration error",
      await rejectsWith(harness.createSession({ workDir: local, bindings: { environment: localEnv, additionalEnvironments: { main: buildEnv } } }), HarnessConfigError),
    );
    await harness.close();
  } finally {
    faux.unregister();
    rmSync(local, { recursive: true, force: true });
    rmSync(build, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
  console.log("✅ HARNESS ENVIRONMENTS E2E PASS — one session, several environments");
}

await main();
