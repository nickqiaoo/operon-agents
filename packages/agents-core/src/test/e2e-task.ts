// Structured task list: TaskCreate/Update/List/Get over a dedicated per-task
// store — disk sessions write one JSON file per task, other backends use KV state. Verifies CRUD,
// dependencies (blocks/blockedBy), delete cascade, high-water-mark ids, both backends, and that a
// session's task list survives reopen (no conversation fold).
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundCapability,
  DiskSessionStore,
  DiskTaskListPersistence,
  MemoryStore,
  Session,
  StoreTaskListPersistence,
  TaskStore,
  taskCapability,
  type ToolResult,
} from "../index.ts";
import { taskCreateTool, taskGetTool, taskListTool, taskUpdateTool } from "../capabilities/task/tools.ts";

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean, extra = ""): void {
  checks.push([label, ok]);
  console.log(ok ? `✅ ${label}` : `❌ ${label} ${extra}`);
}

const CTX = { turnId: "t", toolCallId: "c", signal: new AbortController().signal } as never;
async function runTool(tool: { resolve: (a: unknown, c: never) => Promise<{ run: (c: never) => Promise<ToolResult> }> }, args: unknown): Promise<ToolResult> {
  const plan = await tool.resolve(args, CTX);
  return plan.run(CTX);
}
const textOf = (r: ToolResult): string => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

async function testCrudAndDeps(): Promise<void> {
  const store = new TaskStore();
  store.attach(new StoreTaskListPersistence(new MemoryStore()));
  await store.load();
  const create = taskCreateTool(store);
  const update = taskUpdateTool(store);
  const list = taskListTool(store);
  const get = taskGetTool(store);

  const r1 = await runTool(create, { subject: "build", description: "build the thing" });
  const r2 = await runTool(create, { subject: "test", description: "test the thing" });
  check("create returns sequential ids", textOf(r1).includes("#1") && textOf(r2).includes("#2"));

  check("list shows both", textOf(await runTool(list, {})).includes("#1") && textOf(await runTool(list, {})).includes("#2"));
  check("get reads a task's description", textOf(await runTool(get, { taskId: "2" })).includes("test the thing"));

  // #2 must finish before #1: #1 blockedBy #2, #2 blocks #1.
  await runTool(update, { taskId: "1", status: "in_progress", addBlockedBy: ["2"] });
  check("update sets status", store.get("1")!.status === "in_progress");
  check("addBlockedBy wires both endpoints", store.get("1")!.blockedBy.includes("2") && store.get("2")!.blocks.includes("1"));

  // Delete #2 → cascade-remove the edge from #1.
  await runTool(update, { taskId: "2", status: "deleted" });
  check("delete removes the task", store.get("2") === undefined);
  check("delete cascades: #1 no longer blockedBy #2", !store.get("1")!.blockedBy.includes("2"));

  // High-water-mark: the next id is 3, never reusing the deleted 2.
  const r3 = await runTool(create, { subject: "ship", description: "ship it" });
  check("high-water-mark: deleted id is not reused", textOf(r3).includes("#3"));

  check("update of unknown id is a clean error", (await runTool(update, { taskId: "99", subject: "x" })).isError === true);
}

async function testKvPersistence(): Promise<void> {
  const backing = new MemoryStore();
  const a = new TaskStore();
  a.attach(new StoreTaskListPersistence(backing));
  await a.load();
  await runTool(taskCreateTool(a), { subject: "persisted", description: "survives reopen" });

  // Reopen: a fresh store over the same backing must rehydrate the task + hwm.
  const b = new TaskStore();
  b.attach(new StoreTaskListPersistence(backing));
  await b.load();
  check("KV: task survives reopen", b.list().length === 1 && b.get("1")!.subject === "persisted");
  const next = await runTool(taskCreateTool(b), { subject: "next", description: "x" });
  check("KV: hwm survives reopen (next id is 2)", textOf(next).includes("#2"));
}

async function testDiskPersistence(root: string): Promise<void> {
  const dir = join(root, "disk-sess");
  const a = new TaskStore();
  a.attach(new DiskTaskListPersistence(dir));
  await a.load();
  await runTool(taskCreateTool(a), { subject: "on-disk", description: "written as json" });

  // One JSON file per task under <dir>/tasklist/.
  const files = readdirSync(join(dir, "tasklist"));
  check("Disk: writes one JSON file per task", files.includes("1.json"));

  const b = new TaskStore();
  b.attach(new DiskTaskListPersistence(dir));
  await b.load();
  check("Disk: task survives reopen", b.list().length === 1 && b.get("1")!.subject === "on-disk");
}

async function testSessionIntegration(root: string): Promise<void> {
  const sessionDir = join(root, "session");
  // openSession attaches the disk backend and loads; create a task through the capability's store.
  const store = new TaskStore();
  {
    const store1 = new DiskSessionStore(sessionDir);
    const session = await Session.open({ store: store1, capabilities: [taskCapability(store), backgroundCapability()] });
    await runTool(taskCreateTool(store), { subject: "session-task", description: "persist across reopen" });
    await session.close();
  }
  // Reopen with a fresh store instance; openSession.load() rehydrates from disk.
  const store2State = new TaskStore();
  const session2 = await Session.open({ store: new DiskSessionStore(sessionDir), capabilities: [taskCapability(store2State), backgroundCapability()] });
  check("Session: task list survives reopen via capability", store2State.list().length === 1 && store2State.get("1")!.subject === "session-task");
  // BackgroundList is a host/admin helper, not a model capability tool. TaskList remains.
  const names = session2.capabilities.flatMap((c) => (c.tools ?? []).map((t) => t.schema.name));
  check("background list is not exposed to the model", !names.includes("BackgroundList") && names.includes("TaskList"));
  await session2.close();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "af-task-e2e-"));
  try {
    await testCrudAndDeps();
    await testKvPersistence();
    await testDiskPersistence(root);
    await testSessionIntegration(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) {
    console.log("❌ TASK E2E FAIL");
    process.exit(1);
  }
  console.log("✅ TASK E2E PASS — CRUD + deps + delete cascade + hwm + KV/Disk backends + session reopen");
}

main().catch((error) => {
  console.error("❌ TASK E2E ERROR:", error);
  process.exit(1);
});
