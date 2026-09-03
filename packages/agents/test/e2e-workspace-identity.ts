/**
 * `workspaceKey` is durable session identity (docs/architecture.md §5.7): an explicit key given
 * at create is persisted and read back on resume, inherited by a fork, and overridable on a
 * later open (a generation change). Without it a tenant's session would fall back to the
 * directory key on reopen and land in another workspace's MCP / skills / extension instances.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { createHarness, LocalMachine, MemorySessionRepository, T } from "../src/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "workspace-identity-"));
  try {
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const composed: string[] = [];
    const harness = createHarness({
      model: faux.getChatModel()!,
      workDir: work,
      permission: { mode: "yolo" },
      harness: (scope) => scope.register(T.SessionRepository, new MemorySessionRepository(), { owned: false }),
      workspace: (_scope, ctx) => {
        composed.push(ctx.key);
      },
    });
    const keyOf = (session: { core: { scope: { parent?: { kind: string } } } }) => session.core.scope.parent;

    // ── Explicit key: persisted, read back on resume ──
    const tenant = await harness.createSession({ workspaceKey: "tenant@gen7" });
    check("create: an explicit key composes that workspace", composed.join(",") === "tenant@gen7");
    const id = tenant.id;
    await tenant.close();
    const resumed = await harness.resumeSession(id);
    check("resume: the session reopens under the key it was created with, not the directory's", composed.join(",") === "tenant@gen7,tenant@gen7" && !composed.some((k) => k.startsWith("dir::")));
    check("resume: the session scope hangs under that workspace", keyOf(resumed)?.kind === "workspace");

    // ── Fork inherits the stored key ──
    const forked = await harness.forkSession(id, { title: "fork" });
    check("fork: a fork lands in the source session's workspace (no recomposition: it is still open)", composed.length === 2 && harness.openWorkspaces().map((w) => w.key).join(",") === "tenant@gen7");

    // ── An explicit key on a later open overrides: the generation change ──
    await forked.close();
    const bumped = await harness.resumeSession(forked.id, { workspaceKey: "tenant@gen8" });
    check("generation: resuming with a new key composes the new generation", composed.at(-1) === "tenant@gen8");
    check("generation: the old generation stays alive while a session still holds it", harness.openWorkspaces().map((w) => w.key).sort().join(",") === "tenant@gen7,tenant@gen8");
    await bumped.close();
    const bumpedAgain = await harness.resumeSession(forked.id);
    check("generation: the new key is now the stored one", composed.at(-1) === "tenant@gen8" && composed.filter((k) => k === "tenant@gen8").length === 2);
    await bumpedAgain.close();
    await resumed.close();

    // ── No explicit key: derived from the open, as before ──
    const plain = await harness.createSession();
    check("default: a session without a key gets the directory's workspace", composed.at(-1) === `dir::${work}`);
    await plain.close();
    const own = await harness.createSession({ machine: new LocalMachine(work) });
    check("default: a session bringing its own machine instance gets a private workspace", composed.at(-1) === `private::${own.id}`);
    await own.close();
    const ownAgain = await harness.resumeSession(own.id, { machine: new LocalMachine(work) });
    check("default: derived keys are not persisted — the same open derives the same private key", composed.at(-1) === `private::${own.id}`);
    await ownAgain.close();

    await harness.close();
    faux.unregister();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
