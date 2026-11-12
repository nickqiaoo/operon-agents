/**
 * The Postgres work table and metadata store against a REAL server — the statements, not a
 * model of them. Skipped unless `MANAGED_PG_URL` is set, e.g.
 *
 *   docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   MANAGED_PG_URL=postgres://postgres:test@127.0.0.1:55432/postgres node --experimental-strip-types test/e2e-pg-real.ts
 *
 * Covers the event log (append + wake in one statement, pending order, fenced acknowledge and
 * recordOutput, paging both ways, latest status, purge), the lease (claim, takeover, fencing,
 * clearWake), and one full run of service + worker over it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, LocalEnvironment } from "operon-agents";
import { DiskSessionRepository, type PgExecutor } from "operon-agents/advanced";
import { fauxAssistantMessage, registerFauxProvider } from "./faux.ts";
import { managedSessionMetadataTableDDL, PgManagedSessionMetadataStore } from "../src/server/metadata-pg.ts";
import { SessionService } from "../src/server/session-service.ts";
import { SessionWorker } from "../src/server/session-worker.ts";
import { PgSessionWork, sessionWorkTableDDL } from "../src/server/work-pg.ts";
import type { InboxEntry } from "../src/server/inbox.ts";

const url = process.env["MANAGED_PG_URL"];
if (url === undefined) {
  console.log("⏭  MANAGED_PG_URL not set — skipping the real Postgres test");
  process.exit(0);
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const pgModule = "pg";
const { default: pg } = await import(pgModule) as { default: { Pool: new (options: { connectionString: string }) => PgExecutor & { end(): Promise<void> } } };
const pool = new pg.Pool({ connectionString: url });
const table = `work_${String(Date.now())}`;
const metadataTable = `meta_${String(Date.now())}`;

const message = (text: string, at = Date.now()): InboxEntry => ({
  event: { type: "user.message", content: [{ type: "text", text }], id: `sevt_${crypto.randomUUID()}`, processed_at: null },
  acceptedAt: at,
});

async function workTable(): Promise<void> {
  const alpha = new PgSessionWork({ pool, ownerId: "alpha", table, ttlMs: 1_000 });
  const beta = new PgSessionWork({ pool, ownerId: "beta", table, ttlMs: 1_000 });
  check("claim: an empty table offers nothing", (await alpha.claim()) === undefined);

  const [one, two] = [message("one"), message("two")];
  await alpha.append("s1", [one!, two!]);
  const pending = await alpha.pending("s1");
  check("append: inputs are pending in the order sent", pending.map((e) => e.event.id).join() === [one!.event.id, two!.event.id].join());
  check("append: acceptedAt round-trips", Math.abs(pending[0]!.acceptedAt - one!.acceptedAt) < 2);
  check("append: content round-trips", pending[0]!.event.type === "user.message" && pending[0]!.event.content[0]!.text === "one");

  const lease = (await alpha.claim())!;
  check("claim: a woken session is offered", lease?.sessionId === "s1");
  check("claim: a held session is not offered again", (await beta.claim()) === undefined);

  let refused = false;
  try { await beta.acknowledge("s1", [one!.event.id], lease.fence); } catch { refused = true; }
  check("acknowledge: another owner at the same fence is refused", refused);
  await alpha.acknowledge("s1", [one!.event.id], lease.fence);
  check("acknowledge: the holder marks processed", (await alpha.pending("s1")).map((e) => e.event.id).join() === two!.event.id);

  await alpha.recordOutput("s1", [
    { type: "session.status_running", id: "out_1", processed_at: null },
    { type: "agent.message", id: "out_2", processed_at: null, content: [{ type: "text", text: "hi" }] },
  ], lease.fence);
  await alpha.recordOutput("s1", [{ type: "session.status_running", id: "out_1", processed_at: null }], lease.fence);
  const all = await alpha.listEvents("s1", { limit: 100 });
  check("history: inputs and outputs interleaved, a repeated id skipped", all.data.map((e) => e.id).join() === [one!.event.id, two!.event.id, "out_1", "out_2"].join());
  check("history: processed inputs carry processed_at", all.data[0]!.processed_at !== null && all.data[1]!.processed_at === null);
  check("history: outputs are stamped processed", all.data[2]!.processed_at !== null);
  check("latestStatus: the newest session.status_* event", (await alpha.latestStatus("s1"))?.id === "out_1");
  const page1 = await alpha.listEvents("s1", { limit: 3, order: "desc" });
  const page2 = await alpha.listEvents("s1", { limit: 3, order: "desc", page: page1.next! });
  check("history: pages descending", page1.data.map((e) => e.id).join() === ["out_2", "out_1", two!.event.id].join() && page2.data.map((e) => e.id).join() === one!.event.id && page2.next === undefined);

  // clearWake: an append after it re-wakes; release keeps the wake for the next claim.
  await lease.clearWake();
  await beta.append("s1", [message("three")]);
  await lease.release();
  const next = await beta.claim();
  check("clearWake/release: an event sent after the last look is claimed next", next?.sessionId === "s1");

  // Takeover after the TTL; the old holder's writes are fenced out.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const takeover = await alpha.claim();
  check("claim: a lapsed lease is taken over", takeover?.sessionId === "s1" && takeover.fence > next!.fence);
  check("renew: the superseded holder learns it lost", (await next!.renew()) === false && next!.signal.aborted);
  refused = false;
  try { await beta.recordOutput("s1", [{ type: "session.status_idle", id: "late", processed_at: null, stop_reason: { type: "end_turn" } }], next!.fence); } catch { refused = true; }
  check("recordOutput: the superseded holder is fenced out", refused);
  check("renew: the current holder renews", await takeover!.renew());
  await takeover!.release();

  await alpha.purge("s1");
  check("purge: history and row are gone", (await alpha.listEvents("s1", { limit: 10 })).data.length === 0 && !(await alpha.peek("s1")));
}

async function metadataStore(): Promise<void> {
  const store = new PgManagedSessionMetadataStore({ pool, table: metadataTable });
  const doc = { version: 1 as const, sessionId: "m1", agent: { id: "default" }, environment: { id: "env" }, createdAt: 1, updatedAt: 1 };
  check("metadata: create claims the id", (await store.create(doc)) === true);
  check("metadata: a second claim fails", (await store.create(doc)) === false);
  await store.update({ ...doc, title: "renamed", updatedAt: 2 });
  check("metadata: update round-trips", (await store.get("m1"))?.title === "renamed");
  check("metadata: list", (await store.list()).some((m) => m.sessionId === "m1"));
  await store.delete("m1");
  check("metadata: delete", (await store.get("m1")) === undefined);
}

async function fullRun(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pg-real-"));
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage("over postgres", { stopReason: "stop" })]);
  const repository = new DiskSessionRepository(join(root, "sessions"));
  const metadata = new PgManagedSessionMetadataStore({ pool, table: metadataTable });
  const work = new PgSessionWork({ pool, ownerId: "api", table });
  const service = new SessionService({ work, metadataStore: metadata });
  const harness = createHarness({
    infrastructure: () => ({ sessionRepository: repository, environment: new LocalEnvironment(workDir) }),
    ...faux.harnessModel(),
    config: { eventPublication: "committed", defaults: { ...faux.harnessModel().config.defaults, permission: { mode: "yolo" } } }
  });
  const worker = new SessionWorker({
    profile: "single-tenant", harness, repository, metadataStore: metadata, environments: { resolve: () => ({ workDir }) },
    work: new PgSessionWork({ pool, ownerId: "worker", table }), claimIntervalMs: 20, inputPollIntervalMs: 20, onError: () => undefined,
  });
  worker.start();
  try {
    const session = await service.create({ agent: "default", environment_id: "env", initial_events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] });
    const deadline = Date.now() + 8_000;
    let types: string[] = [];
    while (Date.now() < deadline) {
      types = (await service.listEvents(session.id, { limit: 100 })).data.map((e) => e.type);
      if (types.includes("session.status_idle")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check("full run: service + worker over Postgres", JSON.stringify(types) === JSON.stringify(["user.message", "session.status_running", "agent.message", "session.status_idle"]));
  } finally {
    await worker.stop();
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await pool.query(sessionWorkTableDDL(table));
  await pool.query(sessionWorkTableDDL(table)); // idempotent
  await pool.query(managedSessionMetadataTableDDL(metadataTable));
  await workTable();
  await metadataStore();
  await fullRun();
} finally {
  await pool.query(`DROP TABLE IF EXISTS ${table}_events; DROP TABLE IF EXISTS ${table}; DROP TABLE IF EXISTS ${metadataTable}`).catch(() => undefined);
  await pool.end();
}
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
console.log("✅ PG REAL E2E PASS");
