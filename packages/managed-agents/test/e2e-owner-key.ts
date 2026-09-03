import { T } from "operon-agents";
/**
 * `SessionService.ownerKey` — the tenant seam for a server that serves many users.
 *
 * The shape under test is the one a multi-tenant deployment actually uses: ONE Harness and ONE
 * repository underneath, one host per tenant on top. That is what makes the isolation worth
 * asserting — the sessions genuinely share storage, so a `list()` that stayed unfiltered would
 * hand every tenant the whole fleet.
 *
 * Also pins the deliberate non-guarantee: `get()` still resolves another tenant's id. ownerKey
 * partitions enumeration; deciding who may address a session is `authorize`'s job. A future
 * change that makes `get()` throw here would silently move a security boundary.
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
  StaticEnvironmentRegistry,
} from "../src/server/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "managed-owner-key-"));
  const provider = fauxProvider();
  const runtime = createModelRuntime({ builtins: false });
  runtime.models.setProvider(provider.provider);
  const descriptor = provider.getModel();
  if (descriptor === undefined) throw new Error("faux model unavailable");
  const model = defineModel({ runtime, descriptor });

  try {
    // One Harness, one repository — shared by every tenant, exactly as a runtime node would.
    const repository = new DiskSessionRepository(join(root, "home"));
    const harness = createHarness({
      harness: (s) => {
        s.register(T.SessionRepository, repository, { owned: false });
      },
      model,
      permission: { mode: "yolo" },
    });
    const environments = new StaticEnvironmentRegistry({ workspace: { workDir: join(root, "work") } });
    // Deliberately ONE metadata store across both tenants: nothing but ownerKey separates them,
    // so a passing isolation check can only be ownerKey doing the work. (A real deployment may
    // also give each tenant its own store, which adds a second, independent layer.)
    const metadataStore = new DiskManagedSessionMetadataStore(join(root, "managed"));

    const work = new MemorySessionWork({ repository });
    const hostFor = (ownerKey: string): SessionService =>
      new SessionService({ repository, work, ownerKey, metadataStore, environments });

    const alice = hostFor("alice");
    const bob = hostFor("bob");

    const a1 = await alice.create({ agent: "default", environment: "workspace", title: "alice one" });
    const a2 = await alice.create({ agent: "default", environment: "workspace", title: "alice two" });
    const b1 = await bob.create({ agent: "default", environment: "workspace", title: "bob one" });

    const aliceIds = (await alice.list()).map((s) => s.id).sort();
    const bobIds = (await bob.list()).map((s) => s.id).sort();

    check("alice sees exactly her own sessions", aliceIds.join("|") === [a1.id, a2.id].sort().join("|"));
    check("bob sees exactly his own session", bobIds.join("|") === [b1.id].join("|"));
    check("neither listing leaks into the other", !aliceIds.includes(b1.id) && !bobIds.includes(a1.id));

    // The shared repository really does hold all three — the filtering above is doing the work,
    // not a coincidence of separate storage.
    check("the shared repository holds every tenant's session", (await harness.listSessions()).length === 3);

    // Partition, not permission — see the file header. With storage fully shared, a foreign id
    // still resolves; only `authorize` is allowed to turn that into a refusal.
    check("get() still resolves another tenant's session", (await alice.get(b1.id)).id === b1.id);

    await alice.delete(a2.id);
    check("delete drops the session from its tenant's listing", !(await alice.list()).some((s) => s.id === a2.id));
    check("delete leaves the other tenant untouched", (await bob.list()).length === 1);

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
  console.log("✅ E2E PASS — managed host ownerKey partitioning");
}

await main();
