/**
 * Soft delete at the managed layer — where the audit copy and the client's view diverge.
 *
 * The repository deliberately still answers `get()` for a deleted session; that is the audit
 * read. The managed API is the other side of that line: to a client, deleted is gone (404 on
 * every route), and `{ purge: true }` is NOT reachable over HTTP, so a client can never force
 * the destructive path — retention stays a schedule the host runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, createModelRuntime, defineModel, DiskSessionRepository } from "operon-agents";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  DiskManagedSessionMetadataStore,
  MemorySessionWork,
  SessionService,
  ManagedSessionNotFoundError,
  StaticEnvironmentRegistry,
} from "../src/server/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function notFound(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof ManagedSessionNotFoundError;
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "managed-soft-delete-"));
  const provider = fauxProvider();
  const runtime = createModelRuntime({ builtins: false });
  runtime.models.setProvider(provider.provider);
  const descriptor = provider.getModel();
  if (descriptor === undefined) throw new Error("faux model unavailable");
  const model = defineModel({ runtime, descriptor });

  try {
    const repository = new DiskSessionRepository(join(root, "home"));
    const harness = createHarness({ model, repository, permission: { mode: "yolo" } });
    const host = new SessionService({
      repository,
      work: new MemorySessionWork({ repository }),
      metadataStore: new DiskManagedSessionMetadataStore(join(root, "managed")),
      environments: new StaticEnvironmentRegistry({ workspace: { workDir: join(root, "work") } }),
    });

    const kept = await host.create({ agent: "default", environment: "workspace", title: "kept" });
    const gone = await host.create({ agent: "default", environment: "workspace", title: "gone" });

    await host.delete(gone.id);

    check("client view: get() is 404 after delete", await notFound(() => host.get(gone.id)));
    check("client view: listEvents() is 404 after delete", await notFound(() => host.listEvents(gone.id, { limit: 10 })));
    check("client view: deliver() is 404 after delete", await notFound(() => host.appendEvent(gone.id, { input: "hi" })));
    check("client view: list() no longer contains it", !(await host.list()).some((s) => s.id === gone.id));
    check("client view: the other session is untouched", (await host.list()).some((s) => s.id === kept.id));

    // Audit copy: the durable record and its managed metadata are both still there.
    check("audit: the repository still resolves it", (await repository.get(gone.id))?.deletedAt !== undefined);
    check("audit: the log is still readable", (await repository.open(gone.id, { includeDeleted: true })) !== undefined);

    await host.restore(gone.id);
    check("restore: the client can see it again", (await host.get(gone.id)).id === gone.id);
    check("restore: it is back in list()", (await host.list()).some((s) => s.id === gone.id));

    // Purge is the host's own call — it is what finally reclaims the storage.
    await host.delete(gone.id, { purge: true });
    check("purge: the repository no longer resolves it", (await repository.get(gone.id)) === undefined);
    check("purge: restore() can no longer find it", await notFound(() => host.restore(gone.id)));

    await harness.close();
  } finally {
    runtime.models.deleteProvider(provider.provider.id);
    rmSync(root, { recursive: true, force: true });
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — managed soft delete");
}

await main();
