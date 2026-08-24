import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRecord,
  DiskSessionStore,
  DiskSessionRepository,
  MemorySessionRepository,
  type SessionRepository,
} from "../index.ts";
import { encodeWorkdirKey, readSessionCatalog } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function msg(text: string, time: number, address: string): AgentRecord {
  return { time, address, type: "context.append_message", message: { role: "user", content: [{ type: "text", text }] } };
}

async function collect(it: AsyncIterable<AgentRecord>): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Texts of the message records (skips the leading `metadata` and any audit record). */
function texts(records: readonly AgentRecord[]): string {
  return records
    .filter((r) => r.type === "context.append_message")
    .map((r) => (r.type === "context.append_message" ? r.message.content.map((c) => (c.type === "text" ? c.text : "")).join("") : ""))
    .join(",");
}

async function testDiskStore(root: string): Promise<void> {
  const dir = join(root, "store-a");
  const store = new DiskSessionStore(dir);
  // Interleave two agents with deliberately misleading wall-clock stamps: the store-wide
  // sequence, not caller-provided time, is the authoritative append order.
  await store.appendRecord(msg("m1", 100, "main"));
  await store.appendRecord(msg("s1", 300, "main/sub-2"));
  await store.appendRecord(msg("m2", 200, "main"));

  // "main" is filesystem-safe so its shard is unhashed; "main/sub-2" is sanitized to a
  // distinct (hash-suffixed) shard dir — so two per-agent logs exist.
  check(
    "disk: per-address shard files exist",
    existsSync(join(dir, "agents", "main", "log.jsonl")) && readdirSync(join(dir, "agents")).length === 2,
  );

  const merged = await collect(store.readRecords());
  check("disk: merge read follows store sequence across shards", texts(merged) === "m1,s1,m2");

  const firstPage = await store.readRecordPage({ limit: 3 });
  const secondPage = await store.readRecordPage({ limit: 3, after: firstPage.next });
  const pageTexts = texts([...firstPage.data, ...secondPage.data].map((entry) => entry.record));
  check("disk: sequence cursor pages without overlap", pageTexts === "m1,s1,m2");
  check(
    "disk: sequence increases monotonically across shards",
    [...firstPage.data, ...secondPage.data].every((entry, index, all) => index === 0 || BigInt(all[index - 1]!.sequence) < BigInt(entry.sequence)),
  );

  const beforeRewrite = await store.readRecordPage({ limit: 20 });
  await store.rewrite("main");
  const afterRewrite = await store.readRecordPage({ limit: 20 });
  check(
    "disk: rewrite preserves every surviving record sequence",
    beforeRewrite.data.map((entry) => entry.sequence).join(",") === afterRewrite.data.map((entry) => entry.sequence).join(","),
  );

  const mainOnly = await collect(store.readRecords({ address: "main" }));
  check("disk: single-shard read isolates one agent", texts(mainOnly) === "m1,m2");

  const subOnly = await collect(store.readRecords({ address: "main/sub-2" }));
  check("disk: address with '/' round-trips to its shard", texts(subOnly) === "s1");

  // KV round-trip.
  await store.putState("interrupt", { v: 1, note: "hi" });
  await store.putState("goal", { objective: "x" });
  check("disk: getState reads back put value", JSON.stringify(await store.getState("interrupt")) === JSON.stringify({ v: 1, note: "hi" }));
  check("disk: state.json holds the whole KV map", JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")).goal.objective === "x");
  await store.deleteState("goal");
  check("disk: deleteState removes the key", (await store.getState("goal")) === null);
  check("disk: unknown key → null, not throw", (await store.getState("plan")) === null);
}

async function testCrashTolerance(root: string): Promise<void> {
  const dir = join(root, "store-crash");
  const store = new DiskSessionStore(dir);
  await store.appendRecord(msg("ok", 10, "main"));
  // Simulate a half-flushed final line (killed mid-write).
  const logPath = join(dir, "agents", "main", "log.jsonl");
  appendFileSync(logPath, '{"type":"context.append_message","tim');
  const read = await collect(store.readRecords());
  check("crash: truncated trailing line skipped, prior records intact", texts(read) === "ok");
}

async function repositoryContract(name: string, repo: SessionRepository, workDir: string, otherDir: string): Promise<void> {
  const created = await repo.create({ workDir, title: "first" });
  check(`${name}: create returns a handle with a store`, typeof created.id === "string" && typeof created.store.appendRecord === "function");

  await created.store.appendRecord(msg("hello", 1, "main"));
  await created.store.putState("interrupt", { step: 7 });
  check(`${name}: catalog reflects durable interruption`, (await repo.get(created.id))?.durableState === "interrupted");

  const reopened = await repo.open(created.id);
  check(`${name}: open finds the session`, reopened !== undefined && reopened.id === created.id);
  const direct = await repo.get(created.id);
  check(`${name}: get finds one summary`, direct?.id === created.id && direct.title === "first");
  const records = await collect(reopened!.store.readRecords());
  check(`${name}: reopened store sees persisted log`, texts(records) === "hello");
  check(`${name}: reopened store sees persisted KV`, JSON.stringify(await reopened!.store.getState("interrupt")) === JSON.stringify({ step: 7 }));

  // A second session in a different workdir; list filters by workdir.
  await repo.create({ workDir: otherDir, title: "other" });
  const here = await repo.list({ workDir });
  check(`${name}: list filters by workDir`, here.length === 1 && here[0]!.id === created.id && here[0]!.title === "first");
  check(`${name}: list (no filter) sees both`, (await repo.list()).length === 2);

  // Fork copies log + KV into a fresh id.
  const forked = await repo.fork(created.id, { title: "fork" });
  check(`${name}: fork makes a new id`, forked.id !== created.id);
  const forkRecords = await collect(forked.store.readRecords());
  check(`${name}: fork carried the log`, texts(forkRecords) === "hello");
  check(`${name}: fork carried the KV`, JSON.stringify(await forked.store.getState("interrupt")) === JSON.stringify({ step: 7 }));
  check(`${name}: fork carried durable state into catalog`, (await repo.get(forked.id))?.durableState === "interrupted");

  await created.store.deleteState("interrupt");
  check(`${name}: catalog clears durable interruption`, (await repo.get(created.id))?.durableState === "idle");

  await repo.delete(created.id);
  check(`${name}: delete removes the session`, (await repo.open(created.id)) === undefined);
  check(`${name}: open unknown id → undefined`, (await repo.open("does-not-exist")) === undefined);
  check(`${name}: get unknown id → undefined`, (await repo.get("does-not-exist")) === undefined);
}

async function testDiskRepository(root: string): Promise<void> {
  const home = join(root, "home-disk");
  const workA = join(root, "projA");
  const workB = join(root, "projB");
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  const repo = new DiskSessionRepository(home);
  await repositoryContract("disk-repo", repo, workA, workB);

  // updatedAt tracks activity (file mtimes), not just creation: a fresh write advances it
  // past createdAt and makes the session sort first — the old code left it pinned at create.
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const active = await repo.create({ workDir: workA, title: "will-be-active" });
  await sleep(10);
  await active.store.appendRecord(msg("activity", Date.now(), "main"));
  const activeSummary = (await repo.list({ workDir: workA })).find((s) => s.id === active.id)!;
  check("disk-repo: updatedAt advances past createdAt after a write", activeSummary.updatedAt > activeSummary.createdAt);
  check("disk-repo: the just-written session sorts first by updatedAt", (await repo.list({ workDir: workA }))[0]?.id === active.id);

  // Index + workdir grouping on disk.
  const sessionsDir = join(home, "sessions");
  const catalog = await readSessionCatalog(sessionsDir);
  check("disk-repo: session_catalog.jsonl records sessions", catalog.size >= 1);
  check("disk-repo: sessions grouped under workdir key dir", existsSync(join(sessionsDir, encodeWorkdirKey(workB))));

  // Simulate death after the authoritative state commit but before the derived catalog patch.
  const drifted = await repo.create({ workDir: workA, title: "drifted" });
  await new DiskSessionStore(drifted.store.storageDir!()).putState("interrupt", { crash: true });
  const restarted = new DiskSessionRepository(home);
  check(
    "disk-repo: first catalog read repairs a crash-window interruption",
    (await restarted.get(drifted.id))?.durableState === "interrupted",
  );

  const orphanId = "orphan-before-catalog";
  const orphanDir = join(sessionsDir, encodeWorkdirKey(workA), orphanId);
  const orphanStore = new DiskSessionStore(orphanDir);
  const orphanTime = Date.now();
  await orphanStore.putState("meta", {
    id: orphanId,
    workDir: workA,
    title: "orphan",
    createdAt: orphanTime,
    updatedAt: orphanTime,
  });
  const rediscovered = new DiskSessionRepository(home);
  check(
    "disk-repo: startup reconciliation discovers a session missing from catalog",
    (await rediscovered.get(orphanId))?.title === "orphan",
  );
}

async function testMemoryRepository(root: string): Promise<void> {
  await repositoryContract("mem-repo", new MemorySessionRepository(), join(root, "memA"), join(root, "memB"));
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-store-e2e-"));
  try {
    await testDiskStore(root);
    await testCrashTolerance(root);
    await testDiskRepository(root);
    await testMemoryRepository(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const passed = checks.filter(([, ok]) => ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (passed === total) {
    console.log("✅ STORE E2E PASS — disk linear log (shards/merge/crash/KV) + repository (create/open/list/fork/delete) + memory parity");
  } else {
    console.log("❌ STORE E2E FAIL");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ STORE E2E ERROR:", error);
  process.exit(1);
});
