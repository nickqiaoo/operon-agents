/**
 * The two seams a multi-node host runs on: a lease keyed by session id, and a way to follow a
 * log without owning the writer.
 *
 * Neither is used by the in-process path, which is the point — they exist so the distributed
 * shape is expressible without the engine knowing anything about nodes.
 */
import { strict as assert } from "node:assert";
import { MemorySessionLock, MemoryStore, watchRecordsByPolling, type AgentRecord } from "../index.ts";

async function leaseIsExclusive(): Promise<void> {
  const lock = new MemorySessionLock();
  const first = await lock.acquire("s1");
  assert.ok(first, "first acquire should succeed");
  assert.equal(await lock.acquire("s1"), undefined, "a live lease must block a second holder");
  // A different session is unrelated.
  assert.ok(await lock.acquire("s2"), "leases are per session id");

  await first.release();
  const second = await lock.acquire("s1");
  assert.ok(second, "release must free the lease");
  assert.ok(second.fence > first.fence, `fence must advance: ${first.fence} → ${second.fence}`);
  console.log("✅ lease: exclusive per session id, fence advances on re-acquire");
}

async function releaseAbortsTheHolder(): Promise<void> {
  const lock = new MemorySessionLock();
  const lease = (await lock.acquire("s"))!;
  assert.equal(lease.signal.aborted, false, "a fresh lease is not aborted");
  await lease.release();
  assert.equal(lease.signal.aborted, true, "releasing must abort the holder's signal");
  console.log("✅ lease: release aborts the signal a run cancels on");
}

async function expiryLetsAnotherHolderTakeOver(): Promise<void> {
  const lock = new MemorySessionLock();
  // The frozen-process case: the TTL lapses while the holder is not looking.
  const stale = (await lock.acquire("s", { ttlMs: 1 }))!;
  await new Promise((r) => setTimeout(r, 10));

  const taken = await lock.acquire("s");
  assert.ok(taken, "an expired lease must be takeable");
  assert.ok(taken.fence > stale.fence, "takeover must advance the fence past the stale holder");
  // The superseded holder learns it lost, and can no longer renew.
  assert.equal(stale.signal.aborted, true, "the superseded holder must be aborted");
  assert.equal(await stale.renew(), false, "a superseded holder must not be able to renew");
  console.log("✅ lease: takeover after expiry aborts the stale holder and bumps the fence");
}

async function renewExtendsTheLease(): Promise<void> {
  const lock = new MemorySessionLock();
  // This is the one case here that asserts a lease has NOT expired, so the margin has to absorb
  // timer jitter on a loaded CI runner: renewing at ~100ms pushes expiry to ~400ms, and the
  // takeover attempt lands at ~200ms. A 30ms TTL slept in 20ms steps left only 10ms of slack and
  // failed on macOS runners. (The other cases assert expiry, where oversleeping only helps.)
  const lease = (await lock.acquire("s", { ttlMs: 300 }))!;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await lease.renew(), true, "renew should succeed while still held");
  await new Promise((r) => setTimeout(r, 100));
  // Without the renew this window would have expired; with it, the lease still stands.
  assert.equal(await lock.acquire("s"), undefined, "a renewed lease must still block others");
  console.log("✅ lease: renew extends the window");
}

async function renewFailureAbortsTheHolder(): Promise<void> {
  const lock = new MemorySessionLock();
  const stale = (await lock.acquire("s", { ttlMs: 1 }))!;
  await new Promise((r) => setTimeout(r, 10));
  await lock.acquire("s"); // someone else takes over

  // The in-process lock must behave exactly like a durable one here: a renewal that fails is
  // how a holder finds out it was superseded, so it has to abort as well as report false. These
  // two diverging would make single-node testing a misleading rehearsal for production.
  assert.equal(await stale.renew(), false, "a superseded holder must not renew");
  assert.equal(stale.signal.aborted, true, "a failed renewal must abort the holder");
  console.log("✅ lease: a failed renewal aborts, not just reports");
}

async function releaseDoesNotStealFromTheNewHolder(): Promise<void> {
  const lock = new MemorySessionLock();
  const first = (await lock.acquire("s", { ttlMs: 1 }))!;
  await new Promise((r) => setTimeout(r, 10));
  const second = (await lock.acquire("s"))!;
  // The superseded holder tidying up must not free the row someone else now owns.
  await first.release();
  assert.equal(await lock.acquire("s"), undefined, "the new holder's lease must survive");
  await second.release();
  console.log("✅ lease: a superseded release leaves the new holder alone");
}

async function peekReportsWithoutTaking(): Promise<void> {
  const lock = new MemorySessionLock();
  assert.equal(await lock.peek("s"), false, "nobody holds it yet");
  const lease = (await lock.acquire("s"))!;
  assert.equal(await lock.peek("s"), true, "peek sees the live holder");
  // Advisory: asking must not disturb the lease.
  assert.equal(await lock.acquire("s"), undefined, "peek did not release anything");
  await lease.release();
  assert.equal(await lock.peek("s"), false, "released leases are not reported as held");
  console.log("✅ lease: peek observes without taking");
}

async function watchDeliversAppendsAndCatchesUp(): Promise<void> {
  const store = new MemoryStore();
  const say = (text: string): AgentRecord => ({
    type: "custom",
    name: "probe",
    data: text,
  });
  // Two records exist BEFORE anyone watches: a late watcher must catch up, not miss them.
  await store.appendRecord(say("one"));
  await store.appendRecord(say("two"));

  const controller = new AbortController();
  const seen: string[] = [];
  const done = (async () => {
    for await (const stored of watchRecordsByPolling(store, { signal: controller.signal, pollMs: 5 })) {
      // The store prepends a `metadata` record to an empty shard; a watcher sees the raw log.
      if (stored.record.type !== "custom") continue;
      seen.push((stored.record as { data: string }).data);
      if (seen.length === 4) controller.abort();
    }
  })();

  // And two that land while the watch is already running.
  await new Promise((r) => setTimeout(r, 20));
  await store.appendRecord(say("three"));
  await store.appendRecord(say("four"));
  await done;

  assert.deepEqual(seen, ["one", "two", "three", "four"], "watch must deliver backlog then live, in order");
  console.log("✅ watch: catches up on the backlog, then follows new appends in order");
}

async function watchResumesFromACursor(): Promise<void> {
  const store = new MemoryStore();
  const first = await store.appendRecord({ type: "custom", name: "probe", data: "skipped" });
  await store.appendRecord({ type: "custom", name: "probe", data: "wanted" });

  const controller = new AbortController();
  const seen: string[] = [];
  for await (const stored of watchRecordsByPolling(store, { after: first, signal: controller.signal, pollMs: 5 })) {
    seen.push((stored.record as { data: string }).data);
    controller.abort();
  }
  assert.deepEqual(seen, ["wanted"], "a cursor must skip what was already consumed");
  console.log("✅ watch: resumes after a cursor without replaying consumed records");
}

await leaseIsExclusive();
await renewFailureAbortsTheHolder();
await releaseDoesNotStealFromTheNewHolder();
await peekReportsWithoutTaking();
await releaseAbortsTheHolder();
await expiryLetsAnotherHolderTakeOver();
await renewExtendsTheLease();
await watchDeliversAppendsAndCatchesUp();
await watchResumesFromACursor();
console.log("\nLOCK + WATCH E2E PASS");
