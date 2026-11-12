/**
 * `readTranscriptPage` reads WHAT HAPPENED from a session's log, page by page, newest first.
 *
 * The cases that make it more than a filter over `readRecordPage`:
 * - a compaction summarizes messages away from the model's context, but they are still in the
 *   log and must still be on the transcript;
 * - the checkpoint records repeat earlier messages (`kept`, a trimmed `context.replace`), and
 *   taking them as well would show those messages twice;
 * - most records are not transcript items, so a page of N items spans many store pages, and the
 *   cursors must still chain without a gap or an overlap;
 * - a subagent's shard is not the root's transcript.
 *
 * Runs against the in-memory and the disk store: both page through the same sequence cursors.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptPage, type TranscriptItem } from "../events/transcript.ts";
import { DiskSessionStore } from "../store/disk-store.ts";
import { MemoryStore } from "../store/log-store.ts";
import type { AgentRecord, SessionStore } from "../store/store.ts";
import type { Message } from "../protocol/index.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1_000 };
}

function textOf(item: TranscriptItem): string {
  if (item.kind === "compaction") return `[compaction:${item.summary}]`;
  return item.message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

let eventCounter = 0;
async function append(store: SessionStore, record: AgentRecord): Promise<void> {
  eventCounter += 1;
  await store.appendRecord({ eventId: `evt-${eventCounter}`, time: eventCounter, ...record } as AgentRecord);
}

/** Noise between messages: what a real turn writes around them. */
async function lifecycle(store: SessionStore, turnId: string): Promise<void> {
  await append(store, { type: "event.lifecycle", event: { type: "turn.started", turnId } });
  await append(store, { type: "event.lifecycle", event: { type: "turn.ended", turnId, reason: "completed" } });
}

async function writeSession(store: SessionStore): Promise<void> {
  for (let i = 1; i <= 6; i++) {
    await lifecycle(store, `t${i}`);
    await append(store, { type: "context.append_message", message: user(`m${i}`), origin: { kind: "user" } });
  }
  // Compaction: m1..m4 summarized, m5 m6 kept — copies of records already in the log.
  await append(store, {
    type: "context.apply_compaction",
    summary: "S",
    summaryTimestamp: 2_000,
    kept: [user("m5"), user("m6")],
    compactedCount: 4,
    tokensBefore: 100,
    tokensAfter: 10,
  });
  // A micro-compaction trim commits the whole history again through a replace.
  await append(store, { type: "context.replace", messages: [user("m5"), user("m6")] });
  await append(store, { type: "custom_message", customType: "note", content: "visible note", display: true });
  await append(store, { type: "custom_message", customType: "plumbing", content: "hidden note", display: false });
  for (let i = 7; i <= 8; i++) {
    await lifecycle(store, `t${i}`);
    await append(store, { type: "context.append_message", message: user(`m${i}`) });
  }
  // A subagent's own shard.
  await append(store, { type: "context.append_message", message: user("sub-only"), address: "main/sub" } as AgentRecord);
  // A long tail of non-transcript records, longer than one internal scan page.
  for (let i = 0; i < 150; i++) await lifecycle(store, `idle${i}`);
}

const EXPECTED = "m1|m2|m3|m4|m5|m6|[compaction:S]|visible note|hidden note|m7|m8";

async function exercise(label: string, store: SessionStore): Promise<void> {
  await writeSession(store);

  const whole = await readTranscriptPage(store, { limit: 500 });
  check(`${label}: the whole transcript, oldest first, nothing twice`, whole.items.map(textOf).join("|") === EXPECTED);
  check(`${label}: one page that holds it all has no next`, whole.next === undefined);
  check(`${label}: messages compacted away are still on the transcript`, whole.items.slice(0, 4).every((item) => item.kind === "message"));
  const marker = whole.items.find((item) => item.kind === "compaction");
  check(`${label}: the compaction is a marker carrying its summary`, marker?.kind === "compaction" && marker.compactedCount === 4);
  const hidden = whole.items.find((item) => textOf(item) === "hidden note");
  const visible = whole.items.find((item) => textOf(item) === "visible note");
  check(`${label}: a non-display custom message is flagged hidden, a display one is not`, hidden?.kind === "message" && hidden.hidden === true && visible?.kind === "message" && visible.hidden === undefined);
  const first = whole.items[0];
  check(`${label}: items carry the event id and origin`, first?.kind === "message" && first.eventId !== undefined && first.origin?.kind === "user");
  check(`${label}: the root transcript leaves the subagent's shard out`, !whole.items.some((item) => textOf(item) === "sub-only"));

  const sub = await readTranscriptPage(store, { address: "main/sub" });
  check(`${label}: a subagent's transcript is read by its address`, sub.items.map(textOf).join("|") === "sub-only");

  // Page backwards three at a time, across store pages full of lifecycle noise.
  const pages: string[][] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await readTranscriptPage(store, { limit: 3, ...(before !== undefined ? { before } : {}) });
    pages.push(page.items.map(textOf));
    if (page.next === undefined) break;
    before = page.next;
  }
  check(`${label}: the newest page is the latest three`, pages[0]?.join("|") === "hidden note|m7|m8");
  check(`${label}: chained pages rebuild the transcript with no gap or overlap`, [...pages].reverse().flat().join("|") === EXPECTED);
  check(`${label}: the oldest page ends the chain`, pages[pages.length - 1]?.[0] === "m1");

  // Exactly as many items as the transcript holds: records still lie below the first message
  // (metadata, lifecycle), but no older ITEM does — so no next that would page to nothing.
  const exact = await readTranscriptPage(store, { limit: whole.items.length });
  check(`${label}: a page that ends at the first message has no next`, exact.items.length === whole.items.length && exact.next === undefined);
  const short = await readTranscriptPage(store, { limit: whole.items.length - 1 });
  check(`${label}: one item short, next leads to exactly the first message`, short.next !== undefined
    && (await readTranscriptPage(store, { before: short.next })).items.map(textOf).join("|") === "m1");

  const empty = await readTranscriptPage(store, { before: whole.items[0]!.cursor });
  check(`${label}: nothing is older than the first message`, empty.items.length === 0 && empty.next === undefined);

  let rejected = false;
  try {
    await readTranscriptPage(store, { limit: 0 });
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  check(`${label}: a non-positive limit is refused`, rejected);
}

async function main(): Promise<void> {
  await exercise("memory", new MemoryStore());
  const dir = mkdtempSync(join(tmpdir(), "operon-transcript-"));
  try {
    await exercise("disk", new DiskSessionStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.log(`\n❌ TRANSCRIPT PAGE E2E FAIL — ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`\n✅ TRANSCRIPT PAGE E2E PASS — ${checks.length} checks: what happened, paged newest first, nothing twice`);
  process.exit(0);
}

void main();
