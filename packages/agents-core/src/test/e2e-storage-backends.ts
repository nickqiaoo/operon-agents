// Every storage backend is the same LINEAR session log over a tiny physical
// machine (append log + KV + blobs). This runs ONE shared suite against each: memory always
// (which covers the LogSessionStore base — append/read, blob offload, wire-version), pg/redis only
// when a real server is reachable (DATABASE_URL / REDIS_URL), since core ships no driver.
import { memoryStorage, pgStorage, redisStorage } from "../index.ts";
import type { AgentRecord, SessionStorage, SessionStore } from "../index.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) passed++;
  else failed++;
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const bigImage = "A".repeat(5000); // > blob threshold (4096); valid base64, round-trips exactly

function msg(text: string): AgentRecord {
  return { address: "main", type: "context.append_message", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } };
}

function imageMsg(): AgentRecord {
  return { address: "main", type: "context.append_message", message: { role: "user", content: [{ type: "image", data: bigImage, mimeType: "image/png" }], timestamp: 1 } };
}

async function records(store: SessionStore, address?: string): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const r of store.readRecords(address !== undefined ? { address } : undefined)) out.push(r);
  return out;
}

/** Non-empty texts of the message records (skips leading `metadata` + image records). */
function texts(recs: readonly AgentRecord[]): string {
  return recs
    .filter((r): r is Extract<AgentRecord, { type: "context.append_message" }> => r.type === "context.append_message")
    .map((r) => r.message.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
    .filter((t) => t.length > 0)
    .join(",");
}

function firstImageData(recs: readonly AgentRecord[]): string | undefined {
  for (const r of recs) {
    if (r.type !== "context.append_message") continue;
    const c = r.message.content;
    if (typeof c === "string") continue;
    for (const part of c) if (part.type === "image") return part.data;
  }
  return undefined;
}

async function runBackend(name: string, storage: SessionStorage, tracksActivity = false): Promise<void> {
  // create + linear log append (first record of a shard is a `metadata` record)
  const a = await storage.create({ workDir: "/proj", title: "first" });
  for (const id of ["a1", "a2", "a3"]) await a.store.appendRecord(msg(id));
  check(`${name}: append accumulates in order`, texts(await records(a.store)) === "a1,a2,a3");
  check(`${name}: log opens with a metadata record`, (await records(a.store))[0]?.type === "metadata");
  const firstPage = await a.store.readRecordPage({ limit: 2 });
  const secondPage = await a.store.readRecordPage({ limit: 2, after: firstPage.next });
  const pageEntries = [...firstPage.data, ...secondPage.data];
  check(`${name}: sequence cursor pages in append order`, texts(pageEntries.map((entry) => entry.record)) === "a1,a2,a3");
  check(
    `${name}: store sequences are strictly increasing`,
    pageEntries.every((entry, index) => index === 0 || BigInt(pageEntries[index - 1]!.sequence) < BigInt(entry.sequence)),
  );
  const sequencesBeforeRewrite = (await a.store.readRecordPage({ limit: 20 })).data.map((entry) => entry.sequence);
  await a.store.rewrite?.("main");
  const sequencesAfterRewrite = (await a.store.readRecordPage({ limit: 20 })).data.map((entry) => entry.sequence);
  check(`${name}: rewrite preserves stable sequences`, sequencesBeforeRewrite.join(",") === sequencesAfterRewrite.join(","));

  // KV state round-trip + wire version stamped on first write
  await a.store.putState("interrupt", { step: 7 });
  check(`${name}: state round-trips`, JSON.stringify(await a.store.getState("interrupt")) === JSON.stringify({ step: 7 }));
  check(`${name}: catalog reflects durable interruption`, (await storage.get(a.id))?.durableState === "interrupted");
  check(`${name}: wire version stamped`, (await a.store.getState("wire_version")) !== null);

  // blob offload + rehydrate (oversized image)
  await a.store.appendRecord(imageMsg());
  check(`${name}: oversized image offloaded + rehydrated`, firstImageData(await records(a.store)) === bigImage);

  // repository: open / list (by workDir) / fork / delete
  const reopened = await storage.open(a.id);
  check(`${name}: open finds the session`, reopened !== undefined && reopened.id === a.id);
  check(`${name}: reopened sees persisted log`, texts(await records(reopened!.store)) === "a1,a2,a3");
  const direct = await storage.get(a.id);
  check(`${name}: get returns one catalog summary`, direct?.id === a.id && direct.title === "first");

  await storage.create({ workDir: "/other", title: "second" });
  const here = await storage.list({ workDir: "/proj" });
  check(`${name}: list filters by workDir`, here.length === 1 && here[0]!.id === a.id && here[0]!.title === "first");
  check(`${name}: list (no filter) sees both`, (await storage.list()).length === 2);

  const forked = await storage.fork(a.id, { title: "forked" });
  check(`${name}: fork makes a new id`, forked.id !== a.id);
  check(`${name}: fork carried the log`, texts(await records(forked.store)) === "a1,a2,a3");
  check(`${name}: fork carried the KV`, JSON.stringify(await forked.store.getState("interrupt")) === JSON.stringify({ step: 7 }));
  check(`${name}: fork catalog carries durable interruption`, (await storage.get(forked.id))?.durableState === "interrupted");
  check(`${name}: fork shares the blob (rehydrates)`, firstImageData(await records(forked.store)) === bigImage);

  // updatedAt advances with activity (persistent backends only; memory pins it at createdAt).
  if (tracksActivity) {
    await new Promise((r) => setTimeout(r, 5));
    await a.store.appendRecord(msg("activity-bump"));
    const summary = (await storage.list({ workDir: "/proj" })).find((s) => s.id === a.id);
    check(`${name}: updatedAt advances with activity`, summary !== undefined && summary.updatedAt > summary.createdAt);
    check(`${name}: an active session sorts ahead of an idle one`, (await storage.list())[0]?.id === a.id);
  }

  await a.store.deleteState("interrupt");
  check(`${name}: catalog clears durable interruption`, (await storage.get(a.id))?.durableState === "idle");

  // scratch: an untracked one-shot store
  const scratch = await storage.scratch("/tmp");
  await scratch.appendRecord(msg("s1"));
  check(`${name}: scratch returns a usable store`, texts(await records(scratch)) === "s1");

  await storage.delete(a.id);
  check(`${name}: delete removes the session`, (await storage.open(a.id)) === undefined);
  check(`${name}: open unknown id → undefined`, (await storage.open("does-not-exist")) === undefined);
  check(`${name}: get unknown id → undefined`, (await storage.get("does-not-exist")) === undefined);

  await storage.close();
}

type Queryable = { query: (t: string, p?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; end?: () => Promise<void> };

async function runPg(): Promise<void> {
  // Real postgres when DATABASE_URL is set; otherwise pg-mem (in-memory) so the pg store logic —
  // tables/seq order/jsonb/bytea/fork — is validated on every run without needing a server. (The
  // shared suite never calls store.rewrite(), whose CTE pg-mem doesn't support; real pg covers it.)
  const url = process.env.DATABASE_URL;
  let pool: Queryable;
  let label: string;
  if (url) {
    const pg = (await import("pg")) as unknown as { default?: { Pool: new (c: unknown) => unknown }; Pool?: new (c: unknown) => unknown };
    const Pool = pg.Pool ?? pg.default!.Pool;
    pool = new Pool({ connectionString: url }) as Queryable;
    await pool.query("drop table if exists session_log, session_state, session_blob, session_meta");
    label = "pg";
  } else {
    const { newDb } = (await import("pg-mem")) as unknown as { newDb: () => { adapters: { createPg: () => { Pool: new () => Queryable } } } };
    pool = new (newDb().adapters.createPg().Pool)();
    label = "pg(mem)";
  }
  try {
    await runBackend(label, pgStorage({ pool, ownsPool: true }), true);
  } finally {
    await pool.end?.();
  }
}

async function runRedis(): Promise<void> {
  // Real redis when REDIS_URL is set; otherwise ioredis-mock (in-memory) so the redis store logic
  // — keys/lists/sets/hashes/blobs — is validated on every run without needing a server.
  const url = process.env.REDIS_URL;
  type ClientType = Parameters<typeof redisStorage>[0]["client"] & { quit?: () => Promise<unknown> };
  let client: ClientType;
  let label: string;
  if (url) {
    const Redis = ((await import("ioredis")) as unknown as { default: new (u: string) => unknown }).default;
    client = new Redis(url) as unknown as ClientType;
    label = "redis";
  } else {
    const RedisMock = ((await import("ioredis-mock")) as unknown as { default: new () => unknown }).default;
    client = new RedisMock() as unknown as ClientType;
    label = "redis(mock)";
  }
  try {
    await runBackend(label, redisStorage({ client, keyPrefix: "agents-test", ownsClient: true }), true);
  } finally {
    await client.quit?.();
  }
}

async function main(): Promise<void> {
  await runBackend("memory", memoryStorage());
  await runPg();
  await runRedis();

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ STORAGE-BACKENDS E2E FAIL");
    process.exit(1);
  }
  console.log("✅ STORAGE-BACKENDS E2E PASS — one linear suite over memory + pg(mem) + redis(mock); real pg/redis when DATABASE_URL/REDIS_URL set");
}

main().catch((error) => {
  console.error("❌ STORAGE-BACKENDS E2E ERROR:", error);
  process.exit(1);
});
