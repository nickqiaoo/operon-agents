/**
 * `ownerKey` — the second partition dimension alongside `workDir`.
 *
 * The same suite runs against every repository implementation that needs no external service
 * (Memory, Disk); Pg and Redis implement the identical contract and are covered by the same
 * `suite()` once a live server is available. Substitutability is the point: a host must not
 * gain or lose partitioning by swapping which backend it injects.
 *
 * The load-bearing case is `partition is not permission`: a filtered `list()` must not reach
 * across owners, while `get`/`open` must STILL resolve any id regardless of key. Enforcing who
 * may address a session belongs to the host (the managed server's `authorize` hook), not here —
 * if this ever flips, hosts that layered their own checks on top would silently double-enforce.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiskSessionRepository,
  MemorySessionRepository,
  type SessionRepository,
} from "../store/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((r) => r.id).sort();
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

async function suite(name: string, make: () => SessionRepository, workDirA: string, workDirB: string): Promise<void> {
  const repo = make();

  const alice1 = await repo.create({ workDir: workDirA, ownerKey: "alice", title: "a1" });
  const alice2 = await repo.create({ workDir: workDirB, ownerKey: "alice", title: "a2" });
  const bob1 = await repo.create({ workDir: workDirA, ownerKey: "bob", title: "b1" });
  const legacy = await repo.create({ workDir: workDirA, title: "no owner" });

  // Stamped and read back.
  check(`${name}: get() returns the ownerKey it was created with`, (await repo.get(alice1.id))?.ownerKey === "alice");
  check(`${name}: a session created without one has no ownerKey`, (await repo.get(legacy.id))?.ownerKey === undefined);

  // Filtered listing.
  const alices = await repo.list({ ownerKey: "alice" });
  check(`${name}: list({ownerKey}) returns only that owner's sessions`, same(ids(alices), [alice1.id, alice2.id]));
  check(`${name}: list({ownerKey}) excludes unowned sessions`, !ids(alices).includes(legacy.id));
  check(`${name}: list({ownerKey}) carries the key through`, alices.every((s) => s.ownerKey === "alice"));

  // Unfiltered listing is unchanged — partitioning is opt-in at read time.
  const all = await repo.list();
  check(`${name}: list() with no filter still returns every session`, same(ids(all), [alice1.id, alice2.id, bob1.id, legacy.id]));

  // Both dimensions intersect rather than override.
  const aliceInA = await repo.list({ ownerKey: "alice", workDir: workDirA });
  check(`${name}: list({ownerKey, workDir}) intersects both`, same(ids(aliceInA), [alice1.id]));
  const anyoneInA = await repo.list({ workDir: workDirA });
  check(`${name}: list({workDir}) alone is unaffected by ownerKey`, same(ids(anyoneInA), [alice1.id, bob1.id, legacy.id]));

  // A key nobody holds returns nothing rather than everything.
  check(`${name}: list() for an unknown owner is empty`, (await repo.list({ ownerKey: "nobody" })).length === 0);

  // Forks stay in their owner's partition.
  const inherited = await repo.fork(alice1.id);
  check(`${name}: fork inherits the source's ownerKey`, (await repo.get(inherited.id))?.ownerKey === "alice");
  const reassigned = await repo.fork(alice1.id, { ownerKey: "bob" });
  check(`${name}: fork can be reassigned to another owner`, (await repo.get(reassigned.id))?.ownerKey === "bob");
  check(
    `${name}: an inherited fork shows up under the owner's listing`,
    ids(await repo.list({ ownerKey: "alice" })).includes(inherited.id),
  );

  // Partition, NOT permission — see the file header.
  check(`${name}: get() resolves another owner's session`, (await repo.get(bob1.id))?.id === bob1.id);
  check(`${name}: open() resolves another owner's session`, (await repo.open(bob1.id)) !== undefined);

  // Deleting drops it from the owner's listing (Redis/Disk keep side indexes that must follow).
  await repo.delete(alice2.id);
  check(`${name}: delete removes the session from its owner's listing`, !ids(await repo.list({ ownerKey: "alice" })).includes(alice2.id));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-owner-key-e2e-"));
  try {
    await suite("memory", () => new MemorySessionRepository(), join(root, "wd-a"), join(root, "wd-b"));

    const home = join(root, "disk-home");
    await suite("disk", () => new DiskSessionRepository(home), join(root, "wd-a"), join(root, "wd-b"));

    // Disk keeps the key in the catalog journal, not only in the live map: a fresh repository
    // over the same home must still partition. This is what a restarted server does.
    const reopened = new DiskSessionRepository(home);
    const owned = await reopened.list({ ownerKey: "alice" });
    const others = await reopened.list({ ownerKey: "bob" });
    check("disk: ownerKey survives a repository restart", owned.length > 0 && owned.every((s) => s.ownerKey === "alice"));
    check(
      "disk: a restarted repository still separates owners",
      others.length > 0 && !ids(owned).some((id) => ids(others).includes(id)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — ownerKey partitioning");
}

await main();
