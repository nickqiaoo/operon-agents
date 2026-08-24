/**
 * A delivery receipt must outlive the process that issued it.
 *
 * `deliver()` returns a receipt that a caller (an HTTP layer answering 202, a peer, cron)
 * treats as "accepted". Before acceptance was journaled, the message existed only in memory —
 * in the SteerBus, or as an argument to `runPrompt` — until the run that consumed it got far
 * enough to journal it. A crash in that window lost a delivery the caller had been told was
 * accepted, and nothing anywhere recorded that it had ever arrived.
 *
 * The child below delivers and then `process.exit`s immediately: no close, no flush, no waiting
 * for the run. The parent reopens the same on-disk session and asserts the input is there.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSessionRepository, type AgentRecord } from "operon-agents-core";

const here = new URL(".", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "delivery-durability-"));
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
await session.deliver("survive the crash", { source: "test-harness", actor: "peer-a" });
// Crash: the receipt exists, so the input must already be durable. No close(), no flush(),
// and the run this started is abandoned mid-flight.
process.stdout.write(session.id);
process.exit(0);
`,
  "utf-8",
);

const sessionId = execFileSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", childPath],
  { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] },
).trim();
assert.ok(sessionId, "child did not report a session id");

// The child is gone. Everything below reads only what reached the disk.
const repository = new DiskSessionRepository(home);
const handle = await repository.open(sessionId);
assert.ok(handle, `session ${sessionId} did not survive the crash`);
const page = await handle.store.readRecordPage({ limit: 200 });
await handle.store.close?.();

const inbox = page.data
  .map((entry) => entry.record as AgentRecord)
  .filter((record): record is AgentRecord & { type: "inbox.received" } => record.type === "inbox.received");

assert.equal(inbox.length, 1, `expected exactly one inbox record, saw ${inbox.length}`);
assert.equal(inbox[0]!.input, "survive the crash");
assert.equal(inbox[0]!.origin.source, "test-harness");
assert.equal(inbox[0]!.origin.actor, "peer-a");
assert.ok(inbox[0]!.origin.deliveryId, "inbox record carries no deliveryId to dedupe on");

console.log("✅ delivery durability: accepted input survives a process crash");

rmSync(root, { recursive: true, force: true });
