/**
 * `SessionService` is the managed API surface, and it runs nothing.
 *
 * The strongest statement this file makes is structural rather than any single assertion: there
 * is no Harness here, no runtime repository, no Environment, no model — and the whole API still
 * works. Sessions are created, addressed, sent events, read back, streamed, archived and deleted
 * without an execution stack existing at all. The only thing a send does is persist the events
 * and wake the session in the work table; a worker that does not exist here would pull them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedStreamEvent } from "../src/protocol/types.ts";
import { MemoryEventBroadcaster } from "../src/server/broadcast.ts";
import { ManagedConflictError, ManagedInvalidRequestError, ManagedSessionNotFoundError } from "../src/server/errors.ts";
import { DiskManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { SessionService } from "../src/server/session-service.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";

const root = mkdtempSync(join(tmpdir(), "session-service-"));
const metadataStore = new DiskManagedSessionMetadataStore(join(root, "managed"));
const work = new MemorySessionWork();
const broadcaster = new MemoryEventBroadcaster();
const service = new SessionService({ work, metadataStore, broadcaster, ownerKey: "tenant-a" });

/** Which sessions are in line for a worker? Claims them to find out, and gives them back woken. */
async function woken(): Promise<readonly string[]> {
  const ids: string[] = [];
  for (let lease = await work.claim(); lease !== undefined; lease = await work.claim()) {
    ids.push(lease.sessionId);
    await lease.release();
  }
  for (const id of ids) await work.wake(id);
  return ids.sort();
}
const only = async (id?: string): Promise<boolean> => (await woken()).join() === (id ?? "");

async function rejects(fn: () => Promise<unknown>, kind: new (...args: never[]) => Error): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof kind;
  }
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

const message = (text: string) => ({ type: "user.message" as const, content: [{ type: "text" as const, text }] });

async function main(): Promise<void> {
  // ── create: a managed record, nothing else ────────────────────────────────────
  const created = await service.create({ agent: "default", environment_id: "default", title: "first", metadata: { team: "a" } });
  check("create: a session resource", created.type === "session" && created.id.startsWith("sesn_") && created.title === "first");
  check("create: idle, with its agent, environment and metadata", created.status === "idle"
    && created.agent.id === "default" && created.environment_id === "default" && created.metadata["team"] === "a");
  check("create: nothing is in line for a worker", await only());
  check("create: no history", (await service.listEvents(created.id)).data.length === 0);
  check("create: a duplicate id conflicts", await rejects(() => service.create({ id: created.id, agent: "default", environment_id: "default" }), ManagedConflictError));
  check("create: environment_id is required", await rejects(() => service.create({ agent: "default" } as never), ManagedInvalidRequestError));
  check("create: initial_events take messages only", await rejects(() => service.create({ agent: "default", environment_id: "default", initial_events: [{ type: "user.interrupt" }] as never }), ManagedInvalidRequestError));

  const seeded = await service.create({ agent: { type: "agent", id: "default" }, environment_id: "default", initial_events: [message("go")] });
  check("create: initial_events wake the session", await only(seeded.id));
  await (await work.acquire(seeded.id))!.release();
  check("create: and read running while unprocessed", (await service.retrieve(seeded.id)).status === "running");
  check("create: the message is in the history, unprocessed", (await service.listEvents(seeded.id)).data[0]?.processed_at === null);

  // ── retrieve / list / update ──────────────────────────────────────────────────
  check("retrieve: round-trips", (await service.retrieve(created.id)).title === "first");
  check("retrieve: an unknown id is not found", await rejects(() => service.retrieve("nope"), ManagedSessionNotFoundError));
  const third = await service.create({ agent: "default", environment_id: "default" });
  const page1 = await service.list({ limit: 2 });
  const page2 = await service.list({ limit: 2, page: page1.next_page! });
  check("list: newest first, paged", page1.data.map((s) => s.id).join() === [third.id, seeded.id].join() && page1.next_page !== null);
  check("list: the next page continues", page2.data.map((s) => s.id).join() === created.id && page2.next_page === null);
  const renamed = await service.update(created.id, { title: "renamed", metadata: { team: "b" } });
  check("update: title and metadata", renamed.title === "renamed" && renamed.metadata["team"] === "b");
  check("update: a blank title is rejected", await rejects(() => service.update(created.id, { title: "  " }), ManagedInvalidRequestError));
  check("update: unknown fields are rejected", await rejects(() => service.update(created.id, { agent: "x" } as never), ManagedInvalidRequestError));

  // ── send events: durable acceptance, and nothing more ─────────────────────────
  const live: ManagedStreamEvent[] = [];
  const unsubscribe = broadcaster.subscribe(created.id, (event) => live.push(event));
  const sent = await service.sendEvents(created.id, { events: [message("do the thing"), { type: "user.interrupt" }] });
  check("send: each event comes back with an id, unprocessed", sent.data.length === 2 && sent.data.every((e) => e.id.startsWith("sevt_") && e.processed_at === null));
  check("send: the session is in line for a worker", await only(created.id));
  const history = (await service.listEvents(created.id)).data;
  check("send: the history holds them in order", history.map((e) => e.id).join() === sent.data.map((e) => e.id).join());
  check("send: pending until a worker processes them", (await work.pending(created.id)).length === 2);
  check("send: nothing is broadcast by the API — that is the worker's", live.length === 0);
  unsubscribe();
  check("send: an unknown event type is rejected", await rejects(() => service.sendEvents(created.id, { events: [{ type: "user.dance" }] } as never), ManagedInvalidRequestError));
  check("send: an empty message is rejected", await rejects(() => service.sendEvents(created.id, { events: [message("   ")] }), ManagedInvalidRequestError));
  check("send: an empty batch is rejected", await rejects(() => service.sendEvents(created.id, { events: [] }), ManagedInvalidRequestError));
  const once = await service.sendEvents(created.id, { events: [message("retry me")] }, "key-1");
  const twice = await service.sendEvents(created.id, { events: [message("retry me")] }, "key-1");
  check("send: a retried idempotency key is accepted once", once.data[0]!.id === twice.data[0]!.id && (await work.pending(created.id)).length === 3);

  // ── history paging ────────────────────────────────────────────────────────────
  const first = await service.listEvents(created.id, { limit: 2 });
  const rest = await service.listEvents(created.id, { limit: 2, page: first.next_page! });
  check("events: pages ascending", first.data.length === 2 && rest.data.length === 1 && rest.next_page === null);
  const newest = await service.listEvents(created.id, { limit: 1, order: "desc" });
  check("events: descending starts at the newest", newest.data[0]?.id === once.data[0]!.id);
  check("events: a page is tied to its order", await rejects(() => service.listEvents(created.id, { limit: 2, order: "desc", page: first.next_page! }), ManagedInvalidRequestError));

  // ── stream: live-only, subscribed when it resolves ────────────────────────────
  const controller = new AbortController();
  const stream = await service.stream(created.id, controller.signal);
  broadcaster.publish(created.id, { type: "session.status_running", id: "evt_live", processed_at: null });
  const iterator = stream[Symbol.asyncIterator]();
  const got = await iterator.next();
  check("stream: carries what is published after it opened, and no history", !got.done && "id" in got.value && got.value.id === "evt_live");
  controller.abort();
  check("stream: ends when aborted", (await iterator.next()).done === true);

  // ── archive / delete ──────────────────────────────────────────────────────────
  check("archive: refused while there is work", await rejects(() => service.archive(created.id), ManagedConflictError));
  check("delete: refused while there is work", await rejects(() => service.delete(created.id), ManagedConflictError));
  const archived = await service.archive(third.id);
  check("archive: terminated, stamped", archived.status === "terminated" && archived.archived_at !== null);
  check("archive: no more events", await rejects(() => service.sendEvents(third.id, { events: [message("hi")] }), ManagedConflictError));
  await service.delete(third.id);
  check("delete: gone from retrieve", await rejects(() => service.retrieve(third.id), ManagedSessionNotFoundError));
  check("delete: gone from events", await rejects(() => service.listEvents(third.id), ManagedSessionNotFoundError));
  check("delete: gone from list", !(await service.list()).data.some((s) => s.id === third.id));
  check("delete: the tombstone wakes a worker to remove the runtime session", (await woken()).includes(third.id));

  // ── validateCreate: a catalog check before anything is recorded ──────────────
  const strict = new SessionService({
    work, metadataStore,
    validateCreate: ({ environment }) => { if (environment.id !== "default") throw new ManagedInvalidRequestError(`unknown environment "${environment.id}"`); },
  });
  check("validate: an unknown environment is refused at create", await rejects(() => strict.create({ id: "refused", agent: "default", environment_id: "elsewhere" }), ManagedInvalidRequestError));
  check("validate: and nothing was recorded", (await metadataStore.get("refused")) === undefined);

  // ── tenancy ───────────────────────────────────────────────────────────────────
  const other = new SessionService({ work, metadataStore, ownerKey: "tenant-b" });
  await other.create({ agent: "default", environment_id: "default", title: "theirs" });
  await strict.create({ agent: "default", environment_id: "default", title: "untenanted" }).then((s) => strict.delete(s.id));
  check("tenancy: a tenant's list holds only its own sessions", (await service.list()).data.length === 2);

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  rmSync(root, { recursive: true, force: true });
  if (passed !== checks.length) process.exit(1);
  console.log("✅ SESSION SERVICE E2E PASS");
}

await main();
