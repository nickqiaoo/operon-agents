import { testRunner, openTestSession } from "./faux.ts";
/**
 * Root-frame spawn concurrency.
 *
 * Before this, `Agent` had no limiter at all — only `Workflow` did — so one assistant message
 * asking for N subagents launched all N at once. Nested spawns stay exempt on purpose: a frame
 * holding a permit while waiting for a child that needs one is a deadlock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "./faux.ts";
import { DiskSessionStore, Runner, Session, defineAgent } from "../index.ts";
import { defaultSpawnConcurrency } from "../agent/concurrency.ts";
import type { FauxResponseStep } from "./faux.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

/**
 * A gate that holds every arrival until `expected` of them are inside, so the overlap this test
 * measures is established by rendezvous rather than by hoping a fixed sleep is long enough. A
 * 25ms sleep used to stand in for that and failed on CI, where spawning the third subagent took
 * longer than the first one's nap. The timeout only exists so a genuine concurrency regression
 * fails the assertion instead of hanging forever — it is never reached when the pool behaves.
 *
 * The timer is deliberately NOT unref'd. While arrivals are waiting it is the only thing keeping
 * the loop alive, and an unref'd one lets node decide there is no work left: the top-level await
 * never settles and the process exits 13 with no output at all — which is exactly how this failed
 * on CI. It is cleared on the normal path, so it never delays a passing run.
 */
function gate(expected: number, timeoutMs = 5000): { arrive(): Promise<void> } {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const timer = setTimeout(open, timeoutMs);
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= expected) {
        clearTimeout(timer);
        open();
      }
      await opened;
    },
  };
}

/** Occupies its slot until the gate opens, so a genuinely parallel run overlaps. */
function tracked(state: { live: number; peak: number }, slot: { arrive(): Promise<void> }): FauxResponseStep {
  return async () => {
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    await slot.arrive();
    state.live -= 1;
    return fauxAssistantMessage("child done", { stopReason: "stop" });
  };
}

async function peakConcurrency(root: string, name: string, maxConcurrentSubagents?: number): Promise<number> {
  const session = await openTestSession({ store: new DiskSessionStore(join(root, name)) });
  const runner = testRunner(maxConcurrentSubagents !== undefined ? { maxConcurrentSubagents } : {});
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const helper = defineAgent({ name: "helper", model, instructions: "Help." });
  const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [helper] });

  const state = { live: 0, peak: 0 };
  // However many the pool admits at once is how many can rendezvous. Uncapped that is NOT three:
  // the default is min(16, max(2, cpus - 2)), which is 2 on a CI runner. Waiting for more than
  // the pool admits would just sit there until the timeout.
  const admits = Math.min(maxConcurrentSubagents ?? defaultSpawnConcurrency(), 3);
  const slot = gate(admits);
  const spawn = (i: number) => fauxToolCall("Agent", { subagent_type: "helper", prompt: `task ${i}`, description: `t${i}` });
  faux.setResponses([
    // One assistant message, three spawns — the case that used to fan out unbounded.
    fauxAssistantMessage([spawn(1), spawn(2), spawn(3)], { stopReason: "toolUse" }),
    tracked(state, slot),
    tracked(state, slot),
    tracked(state, slot),
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);
  const result = await runner.run(main, "spawn three helpers", { session });
  faux.unregister();
  check(`${name}: run completes`, result.status === "completed");
  return state.peak;
}

/**
 * The reason nested spawns are exempt. With a pool of 1, a subagent holding the only permit
 * spawns a child that would need one — if nesting queued too, nobody could ever release.
 */
async function testNestedDoesNotDeadlock(root: string): Promise<void> {
  const session = await openTestSession({ store: new DiskSessionStore(join(root, "nested")) });
  const runner = testRunner({ maxConcurrentSubagents: 1 });
  const faux = registerFauxProvider();
  const model = faux.getChatModel()!;
  const grandchild = defineAgent({ name: "grandchild", model, instructions: "Deepest." });
  const helper = defineAgent({ name: "helper", model, instructions: "Help.", subagents: [grandchild] });
  const main = defineAgent({ name: "main", model, instructions: "Coordinate.", subagents: [helper] });

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "helper", prompt: "delegate deeper", description: "deep" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "grandchild", prompt: "do the work", description: "work" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("grandchild done", { stopReason: "stop" }),
    fauxAssistantMessage("helper done", { stopReason: "stop" }),
    fauxAssistantMessage("all done", { stopReason: "stop" }),
  ]);

  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000).unref?.());
  const outcome = await Promise.race([runner.run(main, "go deep", { session }), timeout]);
  // Every scripted response consumed ⇒ all three levels ran. The grandchild's own text stays in
  // its shard (only the helper's return value reaches the root), so the root transcript cannot
  // show it.
  const unusedResponses = faux.getPendingResponseCount();
  faux.unregister();

  check("nested: a pool of 1 does not deadlock on a nested spawn", outcome !== "timeout");
  check("nested: the whole chain completes", outcome !== "timeout" && outcome.status === "completed");
  check("nested: all three levels ran", unusedResponses === 0);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "e2e-subagent-concurrency-"));
  try {
    // Uncapped does not mean unbounded — the default pool is CPU-derived, so on a 2-core runner
    // it admits 2 and only a bigger machine ever sees all three at once. Asserting a flat 3 here
    // made this fail on every machine with 4 cores or fewer, CI included.
    const admitted = Math.min(3, defaultSpawnConcurrency());
    const unbounded = await peakConcurrency(root, "default");
    check(`default: the pool runs ${admitted} of three siblings at once`, unbounded === admitted);

    const bounded = await peakConcurrency(root, "capped", 1);
    check("capped: maxConcurrentSubagents=1 serializes them", bounded === 1);

    const pair = await peakConcurrency(root, "pair", 2);
    check("capped: maxConcurrentSubagents=2 admits exactly two at a time", pair === 2);

    await testNestedDoesNotDeadlock(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length > 0) process.exit(1);
}

await main();
