/**
 * Unit-style coverage for loop/scheduler.ts (ToolScheduler) — previously zero direct test
 * coverage despite being the concurrency/serialization engine for every tool-call batch.
 * Covers: non-conflicting tasks run concurrently, conflicting tasks serialize in FIFO
 * queue order, a synchronously-throwing start() rejects its own result without blocking
 * later queued tasks, and finished tasks free up their conflicting successors.
 */
import { ToolAccesses } from "../index.ts";
import { ToolScheduler, type ToolCallTask } from "../internal.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label}`);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function task(id: string, accesses: ReturnType<typeof ToolAccesses.readFile>, log: string[], value: Deferred<string>): ToolCallTask<string> {
  return {
    accesses,
    start: async () => {
      log.push(`start:${id}`);
      return { result: value.promise };
    },
  };
}

async function main(): Promise<void> {
  // ── non-conflicting tasks run concurrently: both start() before either settles ──
  {
    const log: string[] = [];
    const scheduler = new ToolScheduler<string>();
    const a = deferred<string>();
    const b = deferred<string>();
    const pA = scheduler.add(task("A", ToolAccesses.readFile("/a"), log, a));
    const pB = scheduler.add(task("B", ToolAccesses.readFile("/b"), log, b));
    check("non-conflicting: both tasks start before either resolves", log.includes("start:A") && log.includes("start:B"));
    a.resolve("va");
    b.resolve("vb");
    check("non-conflicting: results resolve to the values their start() produced", (await pA) === "va" && (await pB) === "vb");
  }

  // ── conflicting tasks serialize: second doesn't start until the first settles ──
  {
    const log: string[] = [];
    const scheduler = new ToolScheduler<string>();
    const c = deferred<string>();
    const d = deferred<string>();
    const pC = scheduler.add(task("C", ToolAccesses.writeFile("/x"), log, c));
    const pD = scheduler.add(task("D", ToolAccesses.writeFile("/x"), log, d));
    check("conflicting: only the first task has started so far", log.includes("start:C") && !log.includes("start:D"));
    c.resolve("vc");
    await pC;
    await flush();
    check("conflicting: the second task starts only after the first's result settles", log.includes("start:D"));
    d.resolve("vd");
    check("conflicting: both eventually resolve with their own values", (await pD) === "vd");
  }

  // ── FIFO order among multiple queued conflicting tasks ──
  {
    const log: string[] = [];
    const scheduler = new ToolScheduler<string>();
    const e1 = deferred<string>();
    const e2 = deferred<string>();
    const e3 = deferred<string>();
    scheduler.add(task("E1", ToolAccesses.writeFile("/y"), log, e1));
    const pE2 = scheduler.add(task("E2", ToolAccesses.writeFile("/y"), log, e2));
    const pE3 = scheduler.add(task("E3", ToolAccesses.writeFile("/y"), log, e3));
    check("FIFO: only the head task has started", log.join(",") === "start:E1");
    e1.resolve("v1");
    await flush();
    check("FIFO: the SECOND-added queued task starts next, not the third", log.join(",") === "start:E1,start:E2");
    e2.resolve("v2");
    await pE2;
    await flush();
    check("FIFO: the third task starts only after the second finishes", log.join(",") === "start:E1,start:E2,start:E3");
    e3.resolve("v3");
    check("FIFO: all settle with their own values in the end", (await pE3) === "v3");
  }

  // ── a synchronously-throwing start() rejects its own result without blocking the queue ──
  {
    const log: string[] = [];
    const scheduler = new ToolScheduler<string>();
    const failing: ToolCallTask<string> = {
      accesses: ToolAccesses.writeFile("/z"),
      start: () => {
        log.push("start:F");
        throw new Error("boom");
      },
    };
    const g = deferred<string>();
    const pF = scheduler.add(failing);
    const pG = scheduler.add(task("G", ToolAccesses.writeFile("/z"), log, g));

    let failRejected = false;
    try {
      await pF;
    } catch {
      failRejected = true;
    }
    check("throwing start(): the failing task's own result rejects", failRejected);
    await flush();
    check("throwing start(): a queued conflicting task still starts afterward (queue not stuck)", log.includes("start:G"));
    g.resolve("vg");
    check("throwing start(): the later task still resolves normally", (await pG) === "vg");
  }

  const failed = checks.filter(([, passed]) => !passed);
  console.log(`\n${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log("❌ FAILED:", failed.map(([label]) => label).join(", "));
    process.exit(1);
  }
  console.log("✅ E2E PASS — ToolScheduler concurrency/serialization");
}

main().catch((error) => {
  console.error("❌ E2E ERROR:", error);
  process.exit(1);
});
