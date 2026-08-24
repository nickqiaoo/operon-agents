/**
 * PgSessionRepository transactions — create / fork / purge are multi-statement, so they must be
 * all-or-nothing.
 *
 * No live Postgres here: the fake pool records every statement and which connection it went to,
 * which is exactly what these assertions are about — that the writes land on ONE pinned client
 * between `begin` and `commit`, and that any throw reaches `rollback` instead of leaving half a
 * session behind. Whether Postgres honours BEGIN/COMMIT is not this test's business.
 *
 * The fallback matters as much as the happy path: a pool with no `connect()` (a minimal
 * duck-typed one) must keep working, unwrapped, exactly as before.
 */
import type { PgClient, PgPool } from "../store/index.ts";
import { PgSessionRepository, SessionRepositoryConflictError } from "../store/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

type Rows = { rows: Array<Record<string, unknown>> };
interface Trace { readonly on: "pool" | "client"; readonly sql: string }

/** Enough Postgres to get create/fork/purge through: `returning id` yields a row, selects yield
 *  one source row, everything else is empty. `failOn` throws at the first matching statement. */
function fakePool(options: { readonly withConnect: boolean; readonly failOn?: string; readonly conflict?: boolean } = { withConnect: true }) {
  const trace: Trace[] = [];
  let released = 0;
  const run = (on: "pool" | "client", text: string): Promise<Rows> => {
    const sql = text.trim().replace(/\s+/g, " ").slice(0, 60);
    trace.push({ on, sql });
    if (options.failOn !== undefined && sql.includes(options.failOn)) return Promise.reject(new Error("boom"));
    if (/returning id/i.test(text)) return Promise.resolve({ rows: options.conflict === true ? [] : [{ id: "s1" }] });
    if (/^\s*select m\.work_dir/i.test(text)) {
      return Promise.resolve({ rows: [{ work_dir: "/w", owner_key: null, title: "t", durable_state: "idle" }] });
    }
    return Promise.resolve({ rows: [] });
  };
  const pool: PgPool = {
    query: (text) => run("pool", text),
    ...(options.withConnect
      ? {
          connect: async (): Promise<PgClient> => ({
            query: (text) => run("client", text),
            release: () => { released += 1; },
          }),
        }
      : {}),
  };
  return { pool, trace, released: () => released };
}

const sqls = (trace: readonly Trace[]): string[] => trace.map((t) => t.sql);
const onClient = (trace: readonly Trace[]): string[] => trace.filter((t) => t.on === "client").map((t) => t.sql);
const has = (trace: readonly Trace[], needle: string): boolean => sqls(trace).some((s) => s.includes(needle));

async function main(): Promise<void> {
  // ---- create: wrapped, and every write is on the pinned client ----
  {
    const { pool, trace, released } = fakePool({ withConnect: true });
    await new PgSessionRepository(pool).create({ workDir: "/w", title: "t" });
    const client = onClient(trace);
    check("create: opens with begin", client[0] === "begin");
    check("create: closes with commit", client.at(-1) === "commit");
    check("create: never rolls back on the happy path", !has(trace, "rollback"));
    check("create: the meta insert is inside the transaction", client.some((s) => s.startsWith("insert into session_meta")));
    check("create: the meta state write is inside the transaction too", client.some((s) => s.startsWith("insert into session_state")));
    check("create: releases the connection", released() === 1);
  }

  // ---- create: a mid-sequence failure must roll back, not leave half a session ----
  {
    const { pool, trace, released } = fakePool({ withConnect: true, failOn: "insert into session_state" });
    let threw = false;
    await new PgSessionRepository(pool).create({ workDir: "/w" }).catch(() => { threw = true; });
    check("create failure: propagates", threw);
    check("create failure: rolls back", has(trace, "rollback"));
    check("create failure: never commits", !has(trace, "commit"));
    check("create failure: still releases the connection", released() === 1);
  }

  // ---- create: an id collision is a rollback, not a partial row ----
  {
    const { pool, trace } = fakePool({ withConnect: true, conflict: true });
    let conflict = false;
    await new PgSessionRepository(pool).create({ id: "taken", workDir: "/w" })
      .catch((error) => { conflict = error instanceof SessionRepositoryConflictError; });
    check("create conflict: throws SessionRepositoryConflictError", conflict);
    check("create conflict: rolls back", has(trace, "rollback"));
    check("create conflict: writes nothing else", !has(trace, "insert into session_state"));
  }

  // ---- fork: meta + log copy + state copy + meta state, all in one transaction ----
  {
    const { pool, trace } = fakePool({ withConnect: true });
    await new PgSessionRepository(pool).fork("src");
    const client = onClient(trace);
    check("fork: opens with begin", client[0] === "begin");
    check("fork: closes with commit", client.at(-1) === "commit");
    check("fork: copies the log inside the transaction", client.some((s) => s.startsWith("insert into session_log")));
    check("fork: copies state inside the transaction", client.filter((s) => s.startsWith("insert into session_state")).length >= 1);
  }

  // ---- purge: three deletes, one transaction ----
  {
    const { pool, trace } = fakePool({ withConnect: true });
    await new PgSessionRepository(pool).delete("s1", { purge: true });
    const client = onClient(trace);
    check("purge: opens with begin", client[0] === "begin");
    check("purge: closes with commit", client.at(-1) === "commit");
    check("purge: all three deletes are inside", client.filter((s) => s.startsWith("delete from")).length === 3);
  }

  // ---- soft delete is a single statement — no transaction needed, none taken ----
  {
    const { pool, trace, released } = fakePool({ withConnect: true });
    await new PgSessionRepository(pool).delete("s1");
    check("soft delete: takes no connection", released() === 0);
    check("soft delete: no begin/commit", !has(trace, "begin") && !has(trace, "commit"));
  }

  // ---- fallback: a pool without connect() keeps working, unwrapped ----
  {
    const { pool, trace } = fakePool({ withConnect: false });
    await new PgSessionRepository(pool).create({ workDir: "/w" });
    check("no connect(): still creates", has(trace, "insert into session_meta"));
    check("no connect(): runs unwrapped", !has(trace, "begin") && !has(trace, "commit"));
    check("no connect(): everything goes to the pool", trace.every((t) => t.on === "pool"));
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — Pg transactions");
}

await main();
