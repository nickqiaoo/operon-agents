/**
 * `SessionService` is the managed API surface, and it runs nothing.
 *
 * The strongest statement this file makes is structural rather than any single assertion: there
 * is no Harness here, no Machine, no model, no capabilities — and the whole API still works.
 * Sessions are created, addressed, written to, read back, streamed and deleted without an
 * execution stack existing at all. Under the previous shape none of this was expressible: every
 * route reached its session through `open()`, so a test like this could not be written without
 * standing up a runtime first, and in production the same coupling meant a client subscribing to
 * an event stream could wake a sandbox and start billing.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSessionRepository } from "operon-agents";
import { ManagedInvalidRequestError } from "../src/server/errors.ts";
import { SessionService } from "../src/server/session-service.ts";
import { DiskManagedSessionMetadataStore } from "../src/server/metadata.ts";
import { MemorySessionWork } from "../src/server/work-memory.ts";
import type { ManagedEnvironmentRegistry } from "../src/server/registries.ts";

const root = mkdtempSync(join(tmpdir(), "session-service-"));
const work = join(root, "work");

/**
 * Resolves a working directory and nothing else. A real registry would also hand back a machine;
 * this one cannot, which is the point — creating and addressing sessions must not depend on an
 * execution backend being resolvable, or a sandbox outage would take the whole API down with it.
 */
const environments: ManagedEnvironmentRegistry = {
  resolve: (ref) => {
    if (ref.id !== "default") throw new Error(`unknown environment "${ref.id}"`);
    return { workDir: work };
  },
};

const repository = new DiskSessionRepository(root);
const sessionWork = new MemorySessionWork({ repository });
/** Is the session in line for a worker? Claims it to find out, and gives it straight back. */
async function woken(): Promise<string | undefined> {
  const lease = await sessionWork.claim();
  await lease?.release();
  return lease?.sessionId;
}
const service = new SessionService({
  repository,
  work: sessionWork,
  environments,
  metadataStore: new DiskManagedSessionMetadataStore(join(root, "managed")),
  ownerKey: "tenant-a",
});

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/** The shape of a `steer.queued` lifecycle record as read raw off the disk. */
interface StoredSteer {
  readonly type: string;
  readonly event?: {
    readonly type?: string;
    readonly steerId?: string;
    readonly origin?: { readonly kind?: string; readonly actor?: string };
    readonly message?: { readonly content?: unknown };
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: string }).text ?? "").join("");
}

async function main(): Promise<void> {
  // ── create: registers a session, starts nothing ───────────────────────────────
  const created = await service.create({ agent: "default", environment: "default", title: "first" });
  check("create: returns an idle session", created.state === "idle" && created.title === "first");
  check("create: no work was signalled", (await woken()) === undefined);

  const fetched = await service.get(created.id);
  check("get: resolves without opening a runtime", fetched.id === created.id && fetched.state === "idle");

  const listed = await service.list();
  check("list: returns the created session", listed.length === 1 && listed[0]!.id === created.id);

  // ── update: a rename is durable and visible on the next read ──────────────────
  const renamed = await service.update(created.id, { title: "renamed" });
  const reread = await service.get(created.id);
  check("update: title changes and persists", renamed.title === "renamed" && reread.title === "renamed");
  check("update: updatedAt moves forward", reread.updatedAt >= created.updatedAt);
  let rejected = false;
  try {
    await service.update(created.id, { title: "  " });
  } catch (error) {
    rejected = error instanceof ManagedInvalidRequestError;
  }
  check("update: rejects a blank title", rejected);

  // ── appendEvent: durable acceptance ───────────────────────────────────────────
  const receipt = await service.appendEvent(created.id, { input: "do the thing", origin: "external", actor: "peer-a" });
  check("append: receipt names the steer", receipt.channel === "steering" && receipt.steerId.startsWith("steer_"));
  check("append: the session is in line for a worker after the write", (await woken()) === created.id);

  // Read it back through a completely independent handle — proving it is on disk, not in memory.
  const independent = await new DiskSessionRepository(root).open(created.id);
  const page = await independent!.store.readRecordPage({ limit: 50 });
  await independent!.store.close?.();
  // The record is the framework's own `steer.queued` — what a session's bus journals for a
  // local steer — so nothing here is a managed-only vocabulary.
  const queued = page.data
    .map((entry) => entry.record as StoredSteer)
    .filter((record) => record.type === "event.lifecycle" && record.event?.type === "steer.queued");
  check("append: input is durable", queued.length === 1 && textOf(queued[0]!.event?.message?.content).includes("do the thing"));
  check("append: provenance is durable", queued[0]!.event?.origin?.kind === "external" && queued[0]!.event.origin.actor === "peer-a");

  // ── listEvents: acceptance is visible to a reconnecting client ────────────────
  const events = await service.listEvents(created.id, { limit: 50 });
  const accepted = events.data.find((event) => event.type === "steer.queued");
  check(
    "events: acceptance is replayable, even though no run consumed it",
    accepted?.type === "steer.queued" && accepted.steerId === receipt.steerId,
  );

  // ── watchEvents: follows the log from a cursor ────────────────────────────────
  const controller = new AbortController();
  const seen: string[] = [];
  const watching = (async () => {
    for await (const event of service.watchEvents(created.id, { signal: controller.signal })) {
      seen.push(event.type);
      if (seen.length === 2) controller.abort();
    }
  })();
  await new Promise((r) => setTimeout(r, 30));
  await service.appendEvent(created.id, { input: "second" });
  await watching;
  check("watch: streams accepted inputs as they land", seen.length === 2 && seen.every((t) => t === "steer.queued"));

  // ── appendEvent: whose words ──────────────────────────────────────────────────
  // The caller is this session's user unless it says it is relaying: the default journals the
  // caller's own words as `user`, under the steer id the receipt names.
  const own = await service.appendEvent(created.id, { input: "and this is me" });
  const ownHandle = await new DiskSessionRepository(root).open(created.id);
  const ownPage = await ownHandle!.store.readRecordPage({ limit: 50 });
  await ownHandle!.store.close?.();
  const ownRecord = ownPage.data
    .map((entry) => entry.record as StoredSteer)
    .filter((record) => record.type === "event.lifecycle" && record.event?.type === "steer.queued")
    .at(-1);
  check(
    "append: the caller's own words are journaled as user, under the receipt's steer id",
    ownRecord?.event?.origin?.kind === "user" && ownRecord.event.steerId === own.steerId,
  );
  // Relay attributes without the declaration would let a caller dress their own words up as
  // someone else's, or the reverse; they are refused, not guessed at.
  const refused = async (request: Parameters<typeof service.appendEvent>[1]): Promise<boolean> => {
    try {
      await service.appendEvent(created.id, request);
      return false;
    } catch (error) {
      return error instanceof ManagedInvalidRequestError;
    }
  };
  check("append: relay attributes require origin: external", await refused({ input: "x", actor: "peer-a" }));
  check("append: an unknown origin is refused", await refused({ input: "x", origin: "root" as never }));

  // ── interruptions: reads state without a runtime ──────────────────────────────
  check("interruptions: empty on a session that never ran", (await service.interruptions(created.id)).length === 0);

  // ── tenancy: list is partitioned by owner ─────────────────────────────────────
  const other = new SessionService({
    repository,
    work: sessionWork,
    environments,
    metadataStore: new DiskManagedSessionMetadataStore(join(root, "managed-b")),
    ownerKey: "tenant-b",
  });
  await other.create({ agent: "default", environment: "default", title: "theirs" });
  check("tenancy: a tenant's list holds only its own sessions", (await service.list()).length === 1);
  check("tenancy: the other tenant sees only its own", (await other.list()).length === 1);

  // ── delete: soft by default, and gone to a client ─────────────────────────────
  await service.delete(created.id);
  let deletedIsHidden = false;
  try {
    await service.get(created.id);
  } catch (error) {
    deletedIsHidden = (error as Error).name === "ManagedSessionNotFoundError";
  }
  check("delete: a deleted session reads as absent", deletedIsHidden);
  check("delete: it leaves the list", (await service.list()).length === 0);

  await service.restore(created.id);
  check("restore: brings it back", (await service.get(created.id)).id === created.id);

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  rmSync(root, { recursive: true, force: true });
  if (passed !== checks.length) process.exit(1);
  console.log("✅ SESSION SERVICE E2E PASS");
}

await main();
