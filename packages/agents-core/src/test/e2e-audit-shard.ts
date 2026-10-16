// The audit shard: records about the session that nothing restores, replays or projects from.
//
// It is an ordinary shard to the backends, so these checks pin the one rule that makes it a
// separate stream — a read WITHOUT an address leaves it out — on both the log-store family
// (memory; Postgres and Redis share its code) and the disk store, and that the session writes
// what belongs there to it: approvals and permission-mode changes, a capability's own records.
// Also: a fork carries it, and a whole-log reader (a reopen's `readSessionTails`, `events.list`'s
// paging) never pays for it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestSession } from "./faux.ts";
import {
  AUDIT_ADDRESS,
  DiskSessionRepository,
  DiskSessionStore,
  MemorySessionRepository,
  MemoryStore,
  appendAudit,
  readAudit,
  readSessionTails,
  type AgentRecord,
  type Capability,
  type SessionContext,
  type SessionRepository,
  type SessionStore,
} from "../index.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.log(`❌ ${label}`);
  }
}

const message = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

async function collect(records: AsyncIterable<AgentRecord>): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for await (const record of records) out.push(record);
  return out;
}

const isAudit = (record: AgentRecord) => record.address === AUDIT_ADDRESS;

// ── A: no read without an address sees the audit shard ──
async function storeContract(name: string, store: SessionStore): Promise<void> {
  await store.appendRecord({ address: "main", type: "context.append_message", message: message("hello") });
  await appendAudit(store, { type: "permission.set_mode", mode: "yolo" }, "main");
  await store.appendRecord({ address: "main", type: "context.replace", messages: [message("reset")] });
  await appendAudit(store, { type: "custom", name: "extension:alpha:hit", data: { n: 1 } }, "main/sub-1");

  const whole = await collect(store.readRecords());
  check(`${name}: a whole-log read leaves the audit shard out`, whole.length > 0 && !whole.some(isAudit));
  const tails = await collect(store.readRecords({ fromCheckpoint: true }));
  check(`${name}: a from-checkpoint read of every shard leaves it out`, tails.length > 0 && !tails.some(isAudit));
  const page = await store.readRecordPage({ limit: 100 });
  check(`${name}: a page with no address leaves it out (what events.list pages)`, page.data.length > 0 && !page.data.some((stored) => isAudit(stored.record)));
  check(`${name}: readSessionTails leaves it out (what a reopen seeds from)`, !(await readSessionTails(store)).some(isAudit));

  const audit = await readAudit(store);
  check(`${name}: readAudit returns it in append order, without its metadata`, audit.map((record) => record.type).join(",") === "permission.set_mode,custom");
  check(`${name}: each audit record names the shard it is about`, audit[0]?.about === "main" && audit[1]?.about === "main/sub-1");
  const named = await store.readRecordPage({ address: AUDIT_ADDRESS, limit: 100 });
  check(`${name}: naming the address still pages it`, named.data.filter((stored) => stored.record.type !== "metadata").length === 2);
}

// ── B: a fork carries the audit shard ──
async function forkContract(name: string, repo: SessionRepository, workDir: string): Promise<void> {
  const source = await repo.create({ workDir });
  await source.store.appendRecord({ address: "main", type: "context.append_message", message: message("hi") });
  await appendAudit(source.store, { type: "permission.set_mode", mode: "manual" }, "main");
  const forked = await repo.fork(source.id);
  const audit = await readAudit(forked.store);
  check(`${name}: a fork carries the audit shard`, audit.length === 1 && audit[0]?.type === "permission.set_mode");
}

/** A capability that keeps the context it was opened with, to write and read records through. */
function recorder(seen: SessionContext[]): Capability {
  return {
    name: "alpha",
    contract: "detachable",
    openSession: (ctx) => {
      seen.push(ctx);
    },
  };
}

// ── C: the session writes what belongs there to the audit shard, and reads it back from there ──
async function sessionWrites(): Promise<void> {
  const store = new MemoryStore();
  const seen: SessionContext[] = [];
  const session = await openTestSession({ store, capabilities: [recorder(seen)], permission: { mode: "manual" } });
  await session.setPermissionMode("yolo");
  seen[0]!.record("hit", { n: 1 });
  await session.close();

  const log = await collect(store.readRecords());
  const audit = await readAudit(store);
  check("session: a permission-mode change is audited, about main", audit.some((record) => record.type === "permission.set_mode" && record.mode === "yolo" && record.about === "main"));
  check("session: a capability record is audited as extension:<name>:<record>", audit.some((record) => record.type === "custom" && record.name === "extension:alpha:hit"));
  check("session: neither is in the conversation log", !log.some((record) => record.type === "permission.set_mode" || (record.type === "custom" && record.name.startsWith("extension:"))));

  // `records()` tells an earlier session's records from this one's by time: open a millisecond on.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again: SessionContext[] = [];
  const reopened = await openTestSession({ store, capabilities: [recorder(again)] });
  const records = await again[0]!.records();
  check("session: records() reads an earlier session's records back from the audit shard", records.length === 1 && records[0]?.name === "hit");
  check("session: getAuditRecords exposes the shard", (await reopened.getAuditRecords()).length === audit.length);
  await reopened.close();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "operon-audit-"));
  try {
    await storeContract("memory", new MemoryStore());
    await storeContract("disk", new DiskSessionStore(join(root, "disk")));
    await forkContract("mem-repo", new MemorySessionRepository(), join(root, "w1"));
    await forkContract("disk-repo", new DiskSessionRepository(join(root, "repo")), join(root, "w2"));
    await sessionWrites();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("❌ AUDIT-SHARD E2E FAIL");
    process.exit(1);
  }
  console.log("✅ AUDIT-SHARD E2E PASS — whole-log reads skip it (memory + disk); fork carries it; session writes approvals/mode/records there");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
