/**
 * The Postgres-backed work table and metadata store, exercised against an in-memory executor
 * that enforces the semantics the real statements rely on.
 *
 * The fake implements the specific conditional behaviour each statement depends on — a claim
 * that takes only a woken or abandoned row whose lease is free or expired, a DO UPDATE that
 * fires only when the lease is free or expired, a renew that fails when the fence moved, a
 * clearWake only the current holder can make, a fence that advances on every take. Those are the
 * whole mechanism: if the WHERE clause on the claim were wrong, two nodes would hold one session
 * and no amount of testing the surrounding code would show it.
 *
 * This is not a substitute for running against a real server — it cannot catch a syntax error —
 * but it pins the logic that makes the table a queue and a lock at once. `e2e-pg-real.ts` runs
 * every statement, the event log included, against a real Postgres when one is configured.
 */
import { strict as assert } from "node:assert";
import { PgSessionWork } from "../src/server/work-pg.ts";
import type { InboxEntry } from "../src/server/inbox.ts";
import { PgManagedSessionMetadataStore } from "../src/server/metadata-pg.ts";

interface WorkRow {
  session_id: string;
  woken: boolean;
  lease_owner: string | null;
  lease_until: number | null;
  fence: number;
}

/** Just enough Postgres to be wrong in the same places the real one would be. */
class FakeExecutor {
  readonly work = new Map<string, WorkRow>();
  readonly metadata = new Map<string, string>();
  now = Date.now();

  async query(text: string, params: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const sql = text.replace(/\s+/g, " ").trim();
    const expired = (row: WorkRow): boolean => row.lease_until === null || row.lease_until < this.now;

    // append (events + wake in one statement) and wake: wake the row, creating it if absent.
    // The event rows are not modelled here; e2e-pg-real.ts runs those statements for real.
    if (sql.startsWith("WITH wake AS ( INSERT INTO session_work (session_id, woken) VALUES ($1, true)")
      || sql.startsWith("INSERT INTO session_work (session_id, woken) VALUES ($1, true)")) {
      const [id] = params as [string];
      const row = this.work.get(id);
      if (row === undefined) this.work.set(id, { session_id: id, woken: true, lease_owner: null, lease_until: null, fence: 0 });
      else row.woken = true;
      return { rows: [] };
    }

    // claim: one woken-or-abandoned row whose lease is free or expired.
    if (sql.startsWith("UPDATE session_work SET lease_owner = $1, lease_until = now() + make_interval(secs => $2), fence = fence + 1, woken = false WHERE session_id = ( SELECT")) {
      const [owner, secs] = params as [string, number];
      const row = [...this.work.values()]
        .filter((r) => (r.woken || r.lease_owner !== null) && expired(r))
        .sort((a, b) => (a.lease_until ?? -Infinity) - (b.lease_until ?? -Infinity))[0];
      if (row === undefined) return { rows: [] };
      row.lease_owner = owner;
      row.lease_until = this.now + secs * 1000;
      row.fence += 1;
      row.woken = false;
      return { rows: [{ session_id: row.session_id, fence: row.fence }] };
    }

    // acquire: upsert, taking the row only if its lease is free or expired.
    if (sql.startsWith("INSERT INTO session_work (session_id, lease_owner, lease_until, fence, woken)")) {
      const [id, owner, secs] = params as [string, string, number];
      const row = this.work.get(id);
      if (row !== undefined && !expired(row)) return { rows: [] };
      const next: WorkRow = {
        session_id: id,
        woken: false,
        lease_owner: owner,
        lease_until: this.now + secs * 1000,
        fence: (row?.fence ?? 0) + 1,
      };
      this.work.set(id, next);
      return { rows: [{ fence: next.fence }] };
    }

    // renew: extend — only at this owner and fence, and only while unexpired. `woken` is untouched.
    if (sql.startsWith("UPDATE session_work SET lease_until = now() + make_interval(secs => $3)")) {
      const [id, owner, secs, fence] = params as [string, string, number, number];
      const row = this.work.get(id);
      if (row === undefined || row.lease_owner !== owner || row.fence !== Number(fence) || expired(row)) return { rows: [] };
      row.lease_until = this.now + secs * 1000;
      return { rows: [{ "?column?": 1 }] };
    }

    // clearWake: the holder clears the wake before its last look.
    if (sql.startsWith("UPDATE session_work SET woken = false WHERE session_id = $1 AND lease_owner = $2 AND fence = $3")) {
      const [id, owner, fence] = params as [string, string, number];
      const row = this.work.get(id);
      if (row !== undefined && row.lease_owner === owner && row.fence === Number(fence)) row.woken = false;
      return { rows: [] };
    }

    // release: clear the hold — only our own, at our fence. `woken` is left alone.
    if (sql.startsWith("UPDATE session_work SET lease_owner = NULL, lease_until = NULL")) {
      const [id, owner, fence] = params as [string, string, number];
      const row = this.work.get(id);
      if (row !== undefined && row.lease_owner === owner && row.fence === Number(fence)) {
        row.lease_owner = null;
        row.lease_until = null;
      }
      return { rows: [] };
    }

    if (sql.startsWith("SELECT 1 FROM session_work WHERE session_id = $1")) {
      const [id] = params as [string];
      const row = this.work.get(id);
      return { rows: row !== undefined && row.lease_until !== null && row.lease_until > this.now ? [{ "?column?": 1 }] : [] };
    }

    if (sql.startsWith("SELECT document FROM managed_session_metadata")) {
      const [id] = params as [string];
      const doc = this.metadata.get(id);
      return { rows: doc === undefined ? [] : [{ document: doc }] };
    }
    if (sql.startsWith("SELECT session_id, document FROM managed_session_metadata")) {
      const [ids] = params as [string[]];
      return {
        rows: ids.flatMap((id) => {
          const doc = this.metadata.get(id);
          return doc === undefined ? [] : [{ session_id: id, document: doc }];
        }),
      };
    }
    if (sql.startsWith("INSERT INTO managed_session_metadata")) {
      const [id, doc] = params as [string, string];
      if (this.metadata.has(id)) return { rows: [] };
      this.metadata.set(id, doc);
      return { rows: [{ session_id: id }] };
    }
    if (sql.startsWith("DELETE FROM managed_session_metadata")) {
      const [id] = params as [string];
      this.metadata.delete(id);
      return { rows: [] };
    }
    throw new Error(`unhandled statement: ${sql.slice(0, 80)}`);
  }
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

async function main(): Promise<void> {
  const pool = new FakeExecutor();

  const alpha = new PgSessionWork({ pool, ownerId: "node-alpha" });
  const beta = new PgSessionWork({ pool, ownerId: "node-beta" });
  const entry = (): InboxEntry => ({
    event: { type: "user.message", content: [{ type: "text", text: "hi" }], id: `sevt_${crypto.randomUUID()}`, processed_at: null },
    acceptedAt: Date.now(),
  });

  // ── append wakes; claim takes ─────────────────────────────────────────────────
  check("claim: an empty table offers nothing", (await alpha.claim()) === undefined);
  await alpha.append("s1", [entry()]);
  check("append: the row is woken", pool.work.get("s1")?.woken === true);
  const held = await alpha.claim();
  check("claim: a woken session is offered, and taking it is the lease", held?.sessionId === "s1" && held.fence === 1);
  check("claim: taking it clears the wake", pool.work.get("s1")?.woken === false);
  check("claim: a held session is not offered again", (await beta.claim()) === undefined);
  check("acquire: a live lease blocks another node", (await beta.acquire("s1")) === undefined);
  check("peek: a live lease is visible", await beta.peek("s1"));

  // ── the heartbeat only extends; the wake stays until the holder clears it ───
  check("renew: the holder renews", await held!.renew());
  await beta.append("s1", [entry()]);
  check("append: a held session can still be woken", pool.work.get("s1")?.woken === true);
  await held!.renew();
  check("renew: does not consume the wake", pool.work.get("s1")?.woken === true);
  check("claim: a woken-but-held session is still not offered", (await beta.claim()) === undefined);
  await held!.clearWake();
  check("clearWake: the holder clears it before its last look", pool.work.get("s1")?.woken === false);

  // ── the frozen-node case: the TTL lapses, another node legitimately takes over ─
  pool.now += 60_000;
  const takenOver = await beta.claim();
  check("claim: an abandoned session is offered even though nothing woke it", takenOver?.sessionId === "s1");
  check("claim: takeover advances the fence", (takenOver?.fence ?? 0) > (held?.fence ?? 0));
  check("renew: a superseded holder learns the lease is lost", (await held!.renew()) === false);
  check("renew: losing the lease aborts the holder's signal", held!.signal.aborted);
  await held!.release();
  check("release: a superseded release does not free the new holder's row", (await alpha.acquire("s1")) === undefined);
  await held!.clearWake();
  await beta.append("s1", [entry()]);
  await held!.clearWake();
  check("clearWake: a superseded holder cannot clear the new holder's wake", pool.work.get("s1")?.woken === true);
  await takenOver!.clearWake();
  check("renew: the current holder can renew", await takenOver!.renew());
  await takenOver!.release();
  check("release: frees the row", !(await alpha.peek("s1")));
  check("claim: a released, unwoken session is not offered", (await alpha.claim()) === undefined);

  // ── a wake that lands during a hold survives the release ──────────────────────
  const again = (await alpha.acquire("s1"))!;
  await again.clearWake();
  await beta.append("s1", [entry()]);
  await again.release();
  check("release: a wake that arrived after the last look is still there for the next claim", (await beta.claim())?.sessionId === "s1");

  // ── several in line; each offered once ────────────────────────────────────────
  await alpha.append("s2", [entry()]);
  await alpha.append("s3", [entry()]);
  const first = await alpha.claim();
  const second = await beta.claim();
  const ids = new Set([first?.sessionId, second?.sessionId]);
  check("claim: two woken sessions go to two claimants, one each", ids.has("s2") && ids.has("s3"));
  check("claim: nothing is offered twice", (await alpha.claim()) === undefined);

  // ── metadata ──────────────────────────────────────────────────────────────────
  const store = new PgManagedSessionMetadataStore({ pool });
  const doc = {
    version: 1 as const,
    sessionId: "m1",
    agent: { id: "default" },
    environment: { id: "workspace" },
    createdAt: 1,
    updatedAt: 1,
  };
  check("metadata: create claims the id", (await store.create(doc)) === true);
  check("metadata: a second claim on the same id fails", (await store.create(doc)) === false);
  check("metadata: round-trips", (await store.get("m1"))?.sessionId === "m1");
  const many = await store.getMany(["m1", "missing"]);
  check("metadata: getMany skips ids that are not there", many.size === 1 && many.has("m1"));
  await store.delete("m1");
  check("metadata: delete removes it", (await store.get("m1")) === undefined);

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  assert.equal(passed, checks.length);
  console.log("✅ PG BACKENDS E2E PASS");
}

await main();
