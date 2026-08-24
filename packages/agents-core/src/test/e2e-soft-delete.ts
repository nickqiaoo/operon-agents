/**
 * Soft delete — deletion has to be reversible and auditable, so `delete()` marks and only
 * `delete(id, { purge: true })` destroys.
 *
 * Three rules, asserted here for every implementation that needs no external service:
 *
 *   list()  HIDES   — enumeration must not surface a deleted session
 *   get()   RETURNS — a point lookup asked for this exact id; `deletedAt` tells the caller
 *   open()  REFUSES — opening is what makes a session runnable, and deleted must not run
 *
 * The load-bearing assertion is `audit`: after a delete, the log is still readable through
 * `open(id, { includeDeleted: true })`. That is the entire reason the mark exists rather than
 * a DELETE statement — if it ever stops holding, deletion has silently become destruction.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiskSessionRepository,
  MemorySessionRepository,
  type AgentRecord,
  type SessionRepository,
} from "../store/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function msg(text: string): AgentRecord {
  return { time: Date.now(), address: "main", type: "context.append_message", message: { role: "user", content: [{ type: "text", text }] } };
}

async function texts(repo: SessionRepository, id: string): Promise<string[]> {
  const handle = await repo.open(id, { includeDeleted: true });
  if (handle === undefined) return [];
  const out: string[] = [];
  for await (const record of handle.store.readRecords({ address: "main" })) {
    if (record.type !== "context.append_message") continue;
    for (const part of record.message.content) if (part.type === "text") out.push(part.text);
  }
  return out;
}

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((r) => r.id);

async function suite(name: string, repo: SessionRepository, workDir: string): Promise<void> {
  const kept = await repo.create({ workDir, ownerKey: "alice", title: "kept" });
  const doomed = await repo.create({ workDir, ownerKey: "alice", title: "doomed" });
  await doomed.store.appendRecord(msg("evidence"));

  await repo.delete(doomed.id);

  check(`${name}: list() hides the deleted session`, ids(await repo.list()).join() === kept.id);
  check(`${name}: list({includeDeleted}) surfaces it again`, ids(await repo.list({ includeDeleted: true })).includes(doomed.id));
  check(`${name}: an owner-filtered list also hides it`, !ids(await repo.list({ ownerKey: "alice" })).includes(doomed.id));

  const summary = await repo.get(doomed.id);
  check(`${name}: get() still returns the deleted session`, summary?.id === doomed.id);
  check(`${name}: get() reports deletedAt`, typeof summary?.deletedAt === "number");
  check(`${name}: get() on a live session has no deletedAt`, (await repo.get(kept.id))?.deletedAt === undefined);

  check(`${name}: open() refuses the deleted session`, (await repo.open(doomed.id)) === undefined);
  check(`${name}: open({includeDeleted}) resolves it`, (await repo.open(doomed.id, { includeDeleted: true })) !== undefined);

  // THE point of soft delete.
  check(`${name}: audit — the log survives the delete`, (await texts(repo, doomed.id)).join() === "evidence");

  let forkRefused = false;
  try {
    await repo.fork(doomed.id);
  } catch {
    forkRefused = true;
  }
  check(`${name}: fork() refuses a deleted source`, forkRefused);

  // Deleting twice must not move the timestamp — the first delete is the audit fact.
  const firstMark = (await repo.get(doomed.id))?.deletedAt;
  await repo.delete(doomed.id);
  check(`${name}: a second delete does not move deletedAt`, (await repo.get(doomed.id))?.deletedAt === firstMark);

  await repo.restore(doomed.id);
  check(`${name}: restore() clears the mark`, (await repo.get(doomed.id))?.deletedAt === undefined);
  check(`${name}: restore() makes it openable again`, (await repo.open(doomed.id)) !== undefined);
  check(`${name}: restore() puts it back in list()`, ids(await repo.list()).includes(doomed.id));
  check(`${name}: restore() kept the log intact`, (await texts(repo, doomed.id)).join() === "evidence");

  // Purge is the only thing that actually destroys.
  await repo.delete(doomed.id, { purge: true });
  check(`${name}: purge removes the session entirely`, (await repo.get(doomed.id)) === undefined);
  check(`${name}: purge is invisible to includeDeleted too`, !ids(await repo.list({ includeDeleted: true })).includes(doomed.id));
  check(`${name}: purge left the other session alone`, (await repo.get(kept.id))?.id === kept.id);

  check(`${name}: restore() on an absent session is a no-op`, await repo.restore("nope").then(() => true, () => false));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-soft-delete-"));
  try {
    await suite("memory", new MemorySessionRepository(), join(root, "wd"));

    const home = join(root, "disk-home");
    await suite("disk", new DiskSessionRepository(home), join(root, "wd"));

    // A delete has to survive a restart: the catalog journal AND the session's own `meta` both
    // carry the mark, because reconcile treats the directory as authoritative and would
    // otherwise resurrect a deleted session as live.
    const persist = new DiskSessionRepository(home);
    const marked = await persist.create({ workDir: join(root, "wd"), title: "marked" });
    await persist.delete(marked.id);
    const reopened = new DiskSessionRepository(home);
    check("disk: the delete survives a repository restart", (await reopened.open(marked.id)) === undefined);
    check("disk: reconcile does not resurrect it into list()", !ids(await reopened.list()).includes(marked.id));
    check("disk: it is still auditable after the restart", (await reopened.get(marked.id))?.deletedAt !== undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — soft delete");
}

await main();
