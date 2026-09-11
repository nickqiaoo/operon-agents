/**
 * A steer receipt must outlive the process that issued it.
 *
 * `SteerReceipt.journaled` settles when the `steer.queued` record is on disk. A caller (an HTTP
 * layer answering 202, a peer, cron) that awaits it and then tells someone "accepted" must be
 * right even if the process dies on the next line: before enqueues were journaled, the message
 * existed only in the SteerBus until the run that consumed it got far enough to write it, and a
 * crash in that window lost a message the caller had been told was accepted.
 *
 * The child below steers, awaits the receipt, and `process.exit`s immediately: no close, no
 * flush, no waiting for the run. The parent reopens the same on-disk session and asserts the
 * record is there under the receipt's id.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSessionRepository, steerMessageFromRecord, type AgentRecord } from "operon-agents-core";

const here = new URL(".", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "steer-durability-"));
const home = join(root, "home");
const work = join(root, "work");

// The child is written out rather than inlined so the crash is a real process death.
const childPath = join(root, "child.ts");
writeFileSync(
  childPath,
  `import { fauxAssistantMessage, registerFauxProvider } from ${JSON.stringify(join(here, "faux.ts"))};
import { createLocalHarness } from ${JSON.stringify(join(here, "../src/index.ts"))};

const faux = registerFauxProvider();
faux.setResponses([fauxAssistantMessage("never read", { stopReason: "stop" })]);
const harness = await createLocalHarness({
  model: faux.getChatModel(),
  homeDir: ${JSON.stringify(home)},
  workDir: ${JSON.stringify(work)},
  permission: { mode: "yolo" },
  loadDiskProfiles: false,
});
const session = await harness.createSession({ title: "durability" });
const receipt = session.steerTo("main", "survive the crash", { kind: "external", source: "test-harness", actor: "peer-a", channel: "follow_up" });
await receipt.journaled;
// Crash: the receipt settled, so the record must already be durable. No close(), no flush(),
// and the run this woke is abandoned mid-flight.
process.stdout.write(session.id + "\\n" + receipt.steerId);
process.exit(0);
`,
  "utf-8",
);

const [sessionId, steerId] = execFileSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", childPath],
  { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] },
).trim().split("\n");
assert.ok(sessionId, "child did not report a session id");
assert.ok(steerId, "child did not report a steer id");

// The child is gone. Everything below reads only what reached the disk.
const repository = new DiskSessionRepository(home);
const handle = await repository.open(sessionId);
assert.ok(handle, `session ${sessionId} did not survive the crash`);
const page = await handle.store.readRecordPage({ limit: 200 });
await handle.store.close?.();

const queued = page.data
  .map((entry) => steerMessageFromRecord(entry.record as AgentRecord))
  .filter((item) => item !== undefined);

assert.equal(queued.length, 1, `expected exactly one steer.queued record, saw ${queued.length}`);
const item = queued[0]!;
assert.equal(item.id, steerId, "the record is not the one the receipt named");
assert.equal(item.channel, "follow_up");
assert.equal(item.origin.kind, "external");
assert.equal(item.origin.kind === "external" ? item.origin.source : undefined, "test-harness");
assert.equal(item.origin.kind === "external" ? item.origin.actor : undefined, "peer-a");
const text = Array.isArray(item.message.content) ? item.message.content.map((part) => (part as { text?: string }).text ?? "").join("") : String(item.message.content);
assert.ok(text.includes("survive the crash"), "the record does not carry the message");

console.log("✅ steer durability: a journaled enqueue survives a process crash");

rmSync(root, { recursive: true, force: true });
