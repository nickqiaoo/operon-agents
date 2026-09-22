/**
 * Harness over Scopes: the `harness` hook's registrations beat the defaults, a session's own
 * overrides beat the harness-level ones, extension `harness` results die with the harness scope,
 * and every session scope hangs under the harness scope.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness, Tokens, LocalEnvironment, MemorySessionRepository, type ExtensionDefinition, type Logger } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "scope-harness-"));
  try {
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const model = faux.getChatModel()!;
    const harnessEnvironment = new LocalEnvironment(work);
    const sessionEnvironment = new LocalEnvironment(work);
    const repo = new MemorySessionRepository();
    const lines: string[] = [];
    const logger: Logger = { log: (level, message) => lines.push(`${level}:${message}`) };
    const closed: string[] = [];
    const shapes: ExtensionDefinition = {
      id: "shapes",
      harness: () => ({ render: () => "v1", close: () => closed.push("shapes") }),
      session: () => undefined,
    };

    const harness = createHarness({
      model,
      workDir: work,
      permission: { mode: "yolo" },
      harness: (scope) => {
        scope.register(Tokens.SessionRepository, repo, { owned: false });
        scope.register(Tokens.EnvironmentFactory, harnessEnvironment, { owned: false });
        scope.register(Tokens.Logger, logger, { owned: false });
      },
      extensions: [shapes],
    });
    check("harness: the hook's repository replaces the in-memory default", harness.scope.get(Tokens.SessionRepository) === repo);
    check("harness: the hook's logger replaces the env default", harness.scope.get(Tokens.Logger) === logger);
    check("harness: an extension harness() result is registered by id in the harness scope", harness.services.has("shapes") && harness.services.handle<{ render(): string }>("shapes").render() === "v1");

    const a = await harness.createSession();
    check("session: the harness-level environment applies when the session gives none", a.core.environment === harnessEnvironment);
    check("session: the session scope hangs under a workspace scope, which hangs under the harness scope", a.core.scope.kind === "session" && a.core.scope.parent?.kind === "workspace" && a.core.scope.parent.parent === harness.scope);
    check("session: a session reads harness-tier services through its own scope", a.core.get(Tokens.Logger) === logger && a.core.get(Tokens.SessionRepository) === repo);
    // The harness hands the store to `Session.open` as an argument, so only the PUBLISHING
    // wrapper is in the registry — that is what capabilities and the loop write through.
    check("session: the publishing store is registered, the raw backend is not", a.core.get(Tokens.Store) === a.core.store && a.core.get(Tokens.StoreBackend) === undefined);
    check("session: the permission options came through the scope", a.core.get(Tokens.PermissionOptions)?.mode === "yolo");

    const b = await harness.createSession({ environment: sessionEnvironment, permission: { mode: "manual" } });
    check("session: createSession({ environment }) overrides the harness-level environment", b.core.environment === sessionEnvironment);
    check("session: createSession({ permission }) overrides the harness-level policy", b.core.get(Tokens.PermissionOptions)?.mode === "manual");

    const result = await a.prompt("hi");
    check("run: a prompt completes over the composed scopes", result.status === "completed");

    await a.close();
    check("close: closing a session closes its scope, not the harness's", a.core.scope.closed && !harness.scope.closed);
    check("close: the other session is untouched", !b.core.scope.closed);
    await harness.close();
    check("close: harness.close() closes every session scope and then its own", b.core.scope.closed && harness.scope.closed);
    check("close: the extension harness() result was disposed with the harness scope", closed.join(",") === "shapes");
    faux.unregister();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ SCOPE-HARNESS E2E PASS — hook registrations + session overrides + scope tree + teardown");
  } else {
    console.log("❌ SCOPE-HARNESS E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
