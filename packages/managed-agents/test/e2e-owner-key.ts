/**
 * `SessionService.ownerKey` — the tenant seam for a server that serves many users.
 *
 * The shape under test is the one a multi-tenant deployment actually uses: ONE metadata store and
 * ONE work table underneath, one service per tenant on top. That is what makes the isolation worth
 * asserting — the sessions genuinely share storage, so a `list()` that stayed unfiltered would
 * hand every tenant the whole fleet.
 *
 * Also pins the deliberate non-guarantee: `retrieve()` still resolves another tenant's id. ownerKey
 * partitions enumeration; deciding who may address a session is `authorize`'s job. A future
 * change that makes `retrieve()` throw here would silently move a security boundary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiskManagedSessionMetadataStore,
  MemorySessionWork,
  SessionService,
} from "../src/server/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "managed-owner-key-"));
  try {
    // Deliberately ONE metadata store and ONE work table across both tenants: nothing but
    // ownerKey separates them, so a passing isolation check can only be ownerKey doing the work.
    // (A real deployment may also give each tenant its own store, which adds a second layer.)
    const metadataStore = new DiskManagedSessionMetadataStore(join(root, "managed"));
    const work = new MemorySessionWork();
    const hostFor = (ownerKey: string): SessionService => new SessionService({ work, ownerKey, metadataStore });

    const alice = hostFor("alice");
    const bob = hostFor("bob");

    const a1 = await alice.create({ agent: "default", environment_id: "workspace", title: "alice one" });
    const a2 = await alice.create({ agent: "default", environment_id: "workspace", title: "alice two" });
    const b1 = await bob.create({ agent: "default", environment_id: "workspace", title: "bob one" });

    const aliceIds = (await alice.list()).data.map((s) => s.id).sort();
    const bobIds = (await bob.list()).data.map((s) => s.id).sort();

    check("alice sees exactly her own sessions", aliceIds.join("|") === [a1.id, a2.id].sort().join("|"));
    check("bob sees exactly his own session", bobIds.join("|") === [b1.id].join("|"));
    check("neither listing leaks into the other", !aliceIds.includes(b1.id) && !bobIds.includes(a1.id));

    // The shared store really does hold all three — the filtering above is doing the work,
    // not a coincidence of separate storage.
    const stored = await metadataStore.list();
    check("the shared store holds every tenant's session", stored.length === 3);
    check("each record carries the owner the service stamped", stored.find((m) => m.sessionId === b1.id)?.ownerKey === "bob");

    // Partition, not permission — see the file header. With storage fully shared, a foreign id
    // still resolves; only `authorize` is allowed to turn that into a refusal.
    check("retrieve() still resolves another tenant's session", (await alice.retrieve(b1.id)).id === b1.id);

    await alice.delete(a2.id);
    check("delete drops the session from its tenant's listing", !(await alice.list()).data.some((s) => s.id === a2.id));
    check("delete leaves the other tenant untouched", (await bob.list()).data.length === 1);
  } finally {
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
